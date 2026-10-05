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
  private val watchedClients = HashSet<IBinder>()
  private val handler = object : Handler(Looper.getMainLooper()) {
    override fun handleMessage(msg: Message) {
      dispatch(msg)
    }
  }
  private val messenger = Messenger(handler)
  private var warmView: WebView? = null
  private var bound = false
  private val rewarm = Runnable { warm() }

  override fun onBind(intent: Intent): IBinder {
    bound = true
    return messenger.binder
  }

  override fun onUnbind(intent: Intent): Boolean {
    bound = false
    closeAll()
    return false
  }

  override fun onDestroy() {
    bound = false
    closeAll()
    super.onDestroy()
  }

  /**
   * Pre-starts the WebView provider and the visual profile's renderer with an idle, never
   * displayed page that loads nothing, so a document's display deadline excludes cold start.
   */
  private fun warm() {
    if (!bound || warmView != null || !WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE)) return
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
          view.destroy()
          handler.postDelayed(rewarm, REWARM_DELAY_MS)
        }
        return true
      }
    }
    warmView = view
    view.loadUrl("about:blank")
  }

  private fun dropWarmView() {
    handler.removeCallbacks(rewarm)
    warmView?.destroy()
    warmView = null
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
        VisualHostProtocol.RESIZE ->
          session(sessionId).resize(dimension(data, VisualHostProtocol.KEY_WIDTH), dimension(data, VisualHostProtocol.KEY_HEIGHT))
        VisualHostProtocol.POST ->
          session(sessionId).post(
            data.getString(VisualHostProtocol.KEY_MESSAGE)
              ?: throw VisualHostException(VisualHostProtocol.INVALID_REQUEST, "Visual message is missing"),
          )
        VisualHostProtocol.CAPTURE -> capture(sessionId, reply, data)
        VisualHostProtocol.TOUCH -> touch(sessionId, data)
        // Closing an already closed session is complete by definition.
        VisualHostProtocol.CLOSE -> sessions[sessionId]?.close()
        else -> throw VisualHostException(VisualHostProtocol.INVALID_REQUEST, "Unknown visual host request ${msg.what}")
      }
    } catch (error: VisualHostException) {
      val existing = sessions[sessionId]
      if (existing != null) existing.fail(error.code, error.message ?: "Visual host request failed")
      else report(reply, sessionId, error.code, error.message ?: "Visual host request failed")
    }
  }

  private fun open(sessionId: String, reply: Messenger, data: Bundle) {
    if (sessions.containsKey(sessionId)) {
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
    val session = VisualDocumentSession(this, sessionId, reply) { closed -> sessions.remove(closed.id) }
    sessions[sessionId] = session
    watch(reply)
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
          for (session in sessions.values.filter { it.clientBinder == binder }) session.close()
        }
      }, 0)
    } catch (error: RemoteException) {
      watchedClients.remove(binder)
      for (session in sessions.values.filter { it.clientBinder == binder }) session.close()
    }
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
    for (session in sessions.values.toList()) session.close()
    sessions.clear()
    if (!bound) dropWarmView()
  }

  companion object {
    private const val REWARM_DELAY_MS = 500L
    private const val TAG = "PaseoVisualHost"
  }
}
