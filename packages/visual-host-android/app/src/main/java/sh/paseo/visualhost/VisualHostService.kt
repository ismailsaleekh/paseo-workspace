package sh.paseo.visualhost

import android.app.Service
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.Message
import android.os.Messenger
import android.os.RemoteException
import android.os.SharedMemory
import android.os.SystemClock
import android.system.ErrnoException
import android.util.Log
import android.view.MotionEvent
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.webkit.ProfileStore
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import java.io.ByteArrayInputStream

/**
 * The exported, signature-permission-protected entry point Paseo binds. It hosts one
 * [VisualDocumentSession] per mounted document and reports every failure explicitly.
 */
class VisualHostService : Service() {
  private val sessions = HashMap<String, VisualDocumentSession>()
  private val recovering = HashSet<VisualDocumentSession>()
  private val pendingOpens = LinkedHashMap<String, PendingOpen>()
  private val watchdog = MainThreadWatchdog()
  private class PendingOpen(val reply: Messenger, val request: OpenRequest, val timeout: Runnable) {
    val posts = ArrayList<String>()
    var width = request.width
    var height = request.height
  }
  private val watchedClients = HashSet<IBinder>()
  private val handler = object : Handler(Looper.getMainLooper()) {
    override fun handleMessage(msg: Message) {
      val operation = when (msg.what) {
        VisualHostProtocol.OPEN -> "open"
        VisualHostProtocol.CLOSE -> "close"
        VisualHostProtocol.POST -> "message"
        VisualHostProtocol.CAPTURE -> "capture"
        VisualHostProtocol.WARM -> "warm"
        VisualHostProtocol.TOUCH -> "touch"
        VisualHostProtocol.INPUT -> "input"
        else -> "idle"
      }
      watchdog.during(operation) { dispatch(msg) }
    }
  }
  private val messenger = Messenger(handler)
  private var warmView: WebView? = null
  private var bound = false
  private var lastOpenAt = Long.MIN_VALUE / 2
  private val rewarm: Runnable = Runnable {
    watchdog.during("warm") {
      // A renderer death while documents are being opened means a recovery open is imminent or
      // running. Re-warming creates a WebView on this main thread (observed 3.2 s under load) and
      // would delay that open past its display deadline. Warm once opening has been quiet.
      val sinceOpen = SystemClock.uptimeMillis() - lastOpenAt
      if (pendingOpens.isNotEmpty() || sinceOpen < REWARM_QUIET_MS) {
        handler.postDelayed(rewarm, maxOf(REWARM_DELAY_MS, REWARM_QUIET_MS - sinceOpen))
      } else warm()
    }
  }

  override fun onCreate() {
    super.onCreate()
    watchdog.start()
  }

  override fun onBind(intent: Intent): IBinder {
    bound = true
    return messenger.binder
  }

  override fun onUnbind(intent: Intent): Boolean {
    bound = false
    watchdog.during("close") { closeAll() }
    return false
  }

  override fun onDestroy() {
    bound = false
    watchdog.during("close") { closeAll() }
    watchdog.stop()
    super.onDestroy()
  }

  /**
   * Pre-starts the WebView provider and the visual profile's renderer with an idle, never
   * displayed page that loads nothing, so a document's display deadline excludes cold start.
   */
  private fun warm() {
    if (!bound || recovering.isNotEmpty() || warmView != null || !WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE)) return
    val view = try {
      WebView(this)
    } catch (error: RuntimeException) {
      // Warming is an optimization; the document that needs the WebView reports this failure.
      Log.w(TAG, "WebView warm-up failed: ${error.javaClass.simpleName}: ${error.message}")
      return
    }
    ProfileStore.getInstance().getOrCreateProfile(VisualHostProtocol.PROFILE)
    WebViewCompat.setProfile(view, VisualHostProtocol.PROFILE)
    view.settings.javaScriptEnabled = false
    view.settings.allowFileAccess = false
    view.settings.allowContentAccess = false
    view.webViewClient = object : WebViewClient() {
      override fun shouldInterceptRequest(
        view: WebView,
        request: WebResourceRequest,
      ): WebResourceResponse =
        WebResourceResponse("text/plain", "utf-8", 403, "Refused", emptyMap(), ByteArrayInputStream(ByteArray(0)))

      override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean = true

      override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
        // The shared profile renderer was terminated (for example a hung document): start a new one.
        if (warmView === view) {
          warmView = null
          handler.post {
            watchdog.during("close") { view.destroy() }
            handler.postDelayed(rewarm, REWARM_DELAY_MS)
          }
        }
        return true
      }
    }
    warmView = view
    view.loadUrl("about:blank")
  }

  private fun dropWarmView() {
    handler.removeCallbacks(rewarm)
    val old = warmView
    warmView = null
    old?.destroy()
  }

  private fun dispatch(msg: Message) {
    if (msg.what == VisualHostProtocol.WARM) {
      warm()
      return
    }
    val data = msg.data
    val sessionId = data.getString(VisualHostProtocol.KEY_SESSION)
    val reply = msg.replyTo
    if (reply == null || !VisualHostProtocol.isSession(sessionId) || sessionId == null) {
      // Without a reply channel and a session nothing can be reported or addressed.
      return
    }
    try {
      when (msg.what) {
        VisualHostProtocol.OPEN -> open(sessionId, reply, data)
        VisualHostProtocol.RESIZE -> resize(sessionId, data)
        VisualHostProtocol.POST -> post(sessionId, data)
        VisualHostProtocol.CAPTURE -> capture(sessionId, reply, data)
        VisualHostProtocol.TOUCH -> touch(sessionId, data)
        VisualHostProtocol.INPUT -> sessions[sessionId]?.input(data)
        // Closing an already closed session is complete by definition.
        VisualHostProtocol.CLOSE -> {
          pendingOpens.remove(sessionId)?.let { handler.removeCallbacks(it.timeout) }
          sessions[sessionId]?.close()
        }
        else -> throw VisualHostException(VisualHostProtocol.INVALID_REQUEST, "Unknown visual host request ${msg.what}")
      }
    } catch (error: VisualHostException) {
      pendingOpens.remove(sessionId)?.let { handler.removeCallbacks(it.timeout) }
      val existing = sessions[sessionId]
      if (existing != null) existing.fail(error.code, error.message ?: "Visual host request failed")
      else report(reply, sessionId, error.code, error.message ?: "Visual host request failed")
    }
  }

  private fun resize(sessionId: String, data: Bundle) {
    val width = dimension(data, VisualHostProtocol.KEY_WIDTH)
    val height = dimension(data, VisualHostProtocol.KEY_HEIGHT)
    val pending = pendingOpens[sessionId]
    if (pending != null) {
      pending.width = width
      pending.height = height
    } else session(sessionId).resize(width, height)
  }

  private fun post(sessionId: String, data: Bundle) {
    val message = data.getString(VisualHostProtocol.KEY_MESSAGE)
      ?: throw VisualHostException(VisualHostProtocol.INVALID_REQUEST, "Visual message is missing")
    val pending = pendingOpens[sessionId]
    if (pending == null) {
      session(sessionId).post(message)
      return
    }
    if (message.length > VisualHostProtocol.MAX_MESSAGE_CHARS || pending.posts.size >= VisualHostProtocol.MAX_PENDING_POSTS) {
      throw VisualHostException(VisualHostProtocol.INVALID_REQUEST, "Visual recovery message queue exceeded its bounds")
    }
    try {
      org.json.JSONObject(message)
    } catch (error: org.json.JSONException) {
      throw VisualHostException(VisualHostProtocol.INVALID_REQUEST, "Visual message is not a JSON object")
    }
    // Paseo posts its initialization immediately after OPEN, even while the old renderer dies.
    // Retain the bounded messages with this mount, not with the terminated document.
    pending.posts.add(message)
  }

  private fun open(sessionId: String, reply: Messenger, data: Bundle) {
    lastOpenAt = SystemClock.uptimeMillis()
    if (sessions.containsKey(sessionId) || pendingOpens.containsKey(sessionId)) {
      throw VisualHostException(VisualHostProtocol.INVALID_REQUEST, "Visual session is already open")
    }
    val hostToken = data.getBinder(VisualHostProtocol.KEY_HOST_TOKEN)
      ?: throw VisualHostException(VisualHostProtocol.INVALID_REQUEST, "Host surface token is missing")
    val request = OpenRequest(
      hostToken = hostToken,
      displayId = data.getInt(VisualHostProtocol.KEY_DISPLAY, -1),
      width = dimension(data, VisualHostProtocol.KEY_WIDTH),
      height = dimension(data, VisualHostProtocol.KEY_HEIGHT),
      document = readDocument(data),
    )
    watch(reply)
    if (recovering.isNotEmpty()) {
      val timeout = Runnable {
        pendingOpens.remove(sessionId)
        report(reply, sessionId, VisualHostProtocol.RENDERER_UNAVAILABLE, "The visual renderer is still recovering; present again")
      }
      if (pendingOpens.size >= VisualHostProtocol.MAX_PENDING_POSTS) {
        throw VisualHostException(VisualHostProtocol.RENDERER_UNAVAILABLE, "Too many visuals waiting for renderer recovery")
      }
      pendingOpens[sessionId] = PendingOpen(reply, request, timeout)
      handler.postDelayed(timeout, VisualHostProtocol.LOAD_DEADLINE_MS)
      return
    }
    openReady(sessionId, reply, request)
  }

  private fun openReady(sessionId: String, reply: Messenger, request: OpenRequest) {
    val session = VisualDocumentSession(
      this, sessionId, reply,
      { closed -> sessions.remove(closed.id) },
      { dying -> recovering.add(dying); Unit },
      { recovered ->
        recovering.remove(recovered)
        if (recovering.isEmpty()) handler.post { watchdog.during("open") { drainRecovery() } }
      },
      watchdog,
    )
    sessions[sessionId] = session
    try {
      session.open(request)
    } catch (error: VisualHostException) {
      session.fail(error.code, error.message ?: "The visual could not be opened")
    } catch (error: RuntimeException) {
      // WebView provider or surface creation failures are platform faults, reported explicitly.
      session.fail(
        VisualHostProtocol.RENDERER_UNAVAILABLE,
        "The visual renderer could not start: ${error.javaClass.simpleName}: ${error.message}",
      )
    }
  }

  private fun drainRecovery() {
    if (!bound || recovering.isNotEmpty()) return
    val waiting = pendingOpens.toMap()
    pendingOpens.clear()
    for ((id, pending) in waiting) {
      handler.removeCallbacks(pending.timeout)
      val request = OpenRequest(
        pending.request.hostToken, pending.request.displayId,
        pending.width, pending.height, pending.request.document,
      )
      openReady(id, pending.reply, request)
      val opened = sessions[id]
      if (opened != null) {
        try {
          for (message in pending.posts) opened.post(message)
        } catch (error: VisualHostException) {
          opened.fail(error.code, error.message ?: "Visual recovery initialization failed")
        }
      }
    }
    handler.postDelayed(rewarm, REWARM_DELAY_MS)
  }

  private fun capture(sessionId: String, reply: Messenger, data: Bundle) {
    val request = data.getString(VisualHostProtocol.KEY_REQUEST)
    if (!VisualHostProtocol.isSession(request) || request == null) {
      throw VisualHostException(VisualHostProtocol.INVALID_REQUEST, "Capture request is unaddressed")
    }
    try {
      session(sessionId).capture(request)
    } catch (error: VisualHostException) {
      // A failed capture answers the inspection; the document itself stays displayed.
      val message = Message.obtain(null, VisualHostProtocol.FAILED)
      message.data = Bundle().apply {
        putString(VisualHostProtocol.KEY_SESSION, sessionId)
        putString(VisualHostProtocol.KEY_CODE, VisualHostProtocol.CAPTURE_FAILED)
        putString(VisualHostProtocol.KEY_REQUEST, request)
        putString(VisualHostProtocol.KEY_TEXT, error.message ?: "Capture failed")
      }
      sendOrClose(reply, sessionId, message)
    }
  }

  private fun touch(sessionId: String, data: Bundle) {
    val event = motionEvent(data)
      ?: throw VisualHostException(VisualHostProtocol.INVALID_REQUEST, "Touch event is missing")
    try {
      session(sessionId).touch(event)
    } finally {
      event.recycle()
    }
  }

  private fun motionEvent(data: Bundle): MotionEvent? =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      data.getParcelable(VisualHostProtocol.KEY_EVENT, MotionEvent::class.java)
    } else {
      data.getParcelable(VisualHostProtocol.KEY_EVENT)
    }

  private fun session(sessionId: String): VisualDocumentSession =
    sessions[sessionId]
      ?: throw VisualHostException(VisualHostProtocol.INVALID_REQUEST, "Visual session is not open")

  private fun dimension(data: Bundle, key: String): Int {
    val value = data.getInt(key, 0)
    if (value !in 1..VisualHostProtocol.MAX_SURFACE_DIMENSION) {
      throw VisualHostException(VisualHostProtocol.INVALID_REQUEST, "Invalid surface $key $value")
    }
    return value
  }

  private fun readDocument(data: Bundle): ByteArray {
    val size = data.getInt(VisualHostProtocol.KEY_DOCUMENT_BYTES, 0)
    val memory = sharedMemory(data)
      ?: throw VisualHostException(VisualHostProtocol.INVALID_REQUEST, "Visual document is missing")
    try {
      if (size <= 0 || size > VisualHostProtocol.MAX_DOCUMENT_BYTES || memory.size < size) {
        throw VisualHostException(VisualHostProtocol.INVALID_REQUEST, "Visual document exceeds its bound")
      }
      val buffer = memory.mapReadOnly()
      val bytes = ByteArray(size)
      buffer.get(bytes)
      SharedMemory.unmap(buffer)
      return bytes
    } catch (error: ErrnoException) {
      throw VisualHostException(VisualHostProtocol.INVALID_REQUEST, "Visual document is unreadable: ${error.message}")
    } finally {
      memory.close()
    }
  }

  private fun sharedMemory(data: Bundle): SharedMemory? =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      data.getParcelable(VisualHostProtocol.KEY_DOCUMENT, SharedMemory::class.java)
    } else {
      data.getParcelable(VisualHostProtocol.KEY_DOCUMENT)
    }

  /** Paseo dying (or being force-stopped) closes every document it displayed. */
  private fun watch(reply: Messenger) {
    val binder = reply.binder
    if (!watchedClients.add(binder)) return
    try {
      binder.linkToDeath({
        handler.post {
          watchedClients.remove(binder)
          closeClient(binder)
        }
      }, 0)
    } catch (error: RemoteException) {
      watchedClients.remove(binder)
      closeClient(binder)
    }
  }

  private fun closeClient(binder: IBinder) {
    for (session in sessions.values.filter { it.clientBinder == binder }) session.close()
    val abandoned = pendingOpens.filterValues { it.reply.binder == binder }.keys.toList()
    for (id in abandoned) pendingOpens.remove(id)?.let { handler.removeCallbacks(it.timeout) }
  }

  private fun report(reply: Messenger, sessionId: String, code: String, text: String) {
    val message = Message.obtain(null, VisualHostProtocol.FAILED)
    message.data = Bundle().apply {
      putString(VisualHostProtocol.KEY_SESSION, sessionId)
      putString(VisualHostProtocol.KEY_CODE, code)
      putString(VisualHostProtocol.KEY_TEXT, text)
    }
    sendOrClose(reply, sessionId, message)
  }

  private fun sendOrClose(reply: Messenger, sessionId: String, message: Message) {
    try {
      reply.send(message)
    } catch (error: RemoteException) {
      sessions[sessionId]?.close()
    }
  }

  private fun closeAll() {
    for ((id, pending) in pendingOpens.toMap()) {
      handler.removeCallbacks(pending.timeout)
      report(pending.reply, id, VisualHostProtocol.RENDERER_UNAVAILABLE, "The visual host was released")
    }
    pendingOpens.clear()
    for (session in sessions.values.toList()) session.close()
    sessions.clear()
    if (!bound) dropWarmView()
  }

  companion object {
    private const val REWARM_DELAY_MS = 500L
    // Two load deadlines: covers a recovery open that timed out and its immediate retry.
    private val REWARM_QUIET_MS = 2L * VisualHostProtocol.LOAD_DEADLINE_MS
    private const val TAG = "PaseoVisualHost"
  }
}
