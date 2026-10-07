package sh.paseo.visualhost

import android.app.Service
import android.hardware.display.DisplayManager
import android.os.Bundle
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.Message
import android.os.Messenger
import android.os.RemoteException
import android.os.SharedMemory
import android.system.ErrnoException
import android.system.OsConstants
import android.view.MotionEvent
import android.view.SurfaceControlViewHost
import android.webkit.WebView
import androidx.webkit.ProfileStore
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import org.json.JSONException
import org.json.JSONObject

class OpenRequest(
  val hostToken: IBinder,
  val displayId: Int,
  val width: Int,
  val height: Int,
  val document: ByteArray,
)

/**
 * One generated document embedded into Paseo. The WebView lives in this app's process and UID
 * (no INTERNET permission) under a dedicated profile; Paseo receives only its SurfacePackage.
 * Host-owned deadlines terminate a renderer that stops accepting messages.
 */
class VisualDocumentSession(
  private val service: Service,
  val id: String,
  private val client: Messenger,
  private val onClosed: (VisualDocumentSession) -> Unit,
  private val onRecoveryStarted: (VisualDocumentSession) -> Unit,
  private val onRecoveryFinished: (VisualDocumentSession) -> Unit,
  private val watchdog: MainThreadWatchdog,
) : DocumentEvents {
  private val handler = Handler(Looper.getMainLooper())
  private var web: VisualKeyboardWebView? = null
  private var keyboard: VisualKeyboardBridge? = null
  private var recovering = false
  private var destroyed = false
  private var viewHost: SurfaceControlViewHost? = null
  private var pageReady = false
  private var closed = false
  private val queued = ArrayDeque<Pair<String, Int>>()
  private val deadlines = HashMap<Int, Runnable>()
  private var nextToken = 0
  private var loadToken = 0
  private val messageBudget = VisualMessageBudget()
  private var reported = false
  private val bridgeSilent = Runnable {
    fail(
      VisualHostProtocol.DOCUMENT_UNRESPONSIVE,
      "The document loaded but its bridge never reported; reopen the visual",
    )
  }

  val clientBinder: IBinder
    get() = client.binder

  fun open(request: OpenRequest) {
    val required = listOf(
      WebViewFeature.MULTI_PROFILE,
      WebViewFeature.WEB_MESSAGE_LISTENER,
      WebViewFeature.GET_WEB_VIEW_RENDERER,
      WebViewFeature.WEB_VIEW_RENDERER_TERMINATE,
      WebViewFeature.DOCUMENT_START_SCRIPT,
    )
    val missing = required.filterNot { WebViewFeature.isFeatureSupported(it) }
    if (missing.isNotEmpty()) {
      throw VisualHostException(
        VisualHostProtocol.RENDERER_UNAVAILABLE,
        "Android System WebView lacks required isolation features: ${missing.joinToString()}",
      )
    }
    val display = service.getSystemService(DisplayManager::class.java).getDisplay(request.displayId)
      ?: throw VisualHostException(VisualHostProtocol.INVALID_REQUEST, "Display ${request.displayId} is unavailable")
    val view = VisualKeyboardWebView(service)
    web = view
    ProfileStore.getInstance().getOrCreateProfile(VisualHostProtocol.PROFILE)
    WebViewCompat.setProfile(view, VisualHostProtocol.PROFILE)
    VisualDocumentPolicy.install(view, request.document, this)
    keyboard = VisualKeyboardBridge(view, id, object : KeyboardTransport {
      override fun send(data: Bundle) {
        send(VisualHostProtocol.EDITOR) { putAll(data) }
      }
      override fun rejected() {
        fail(VisualHostProtocol.DOCUMENT_REJECTED, "The visual document exceeded its message bounds and was closed")
      }
    }, messageBudget, watchdog).also { it.install() }
    val host = SurfaceControlViewHost(service, display, request.hostToken)
    viewHost = host
    host.setView(view, request.width, request.height)
    val surfacePackage = host.surfacePackage
      ?: throw VisualHostException(VisualHostProtocol.RENDERER_UNAVAILABLE, "The visual surface could not be created")
    send(VisualHostProtocol.ATTACHED) { putParcelable(VisualHostProtocol.KEY_PACKAGE, surfacePackage) }
    loadToken = arm(VisualHostProtocol.LOAD_DEADLINE_MS)
    view.loadUrl(VisualHostProtocol.DOCUMENT_URL)
  }

  fun resize(width: Int, height: Int) {
    if (closed) return
    viewHost?.relayout(width, height)
  }

  /** Delivers a touch Paseo relayed from the visual's area to this document's WebView. */
  fun touch(event: MotionEvent) {
    val view = web
    if (closed || view == null) {
      throw VisualHostException(VisualHostProtocol.INVALID_REQUEST, "Visual session is closed")
    }
    if (event.actionMasked == MotionEvent.ACTION_DOWN && !view.hasFocus() && !view.requestFocus()) {
      throw VisualHostException(VisualHostProtocol.INVALID_REQUEST, "The visual view could not receive touch focus")
    }
    view.dispatchTouchEvent(event)
  }

  fun input(data: Bundle) {
    if (closed) return
    keyboard?.input(data)
  }

  fun post(message: String) {
    if (closed) throw VisualHostException(VisualHostProtocol.INVALID_REQUEST, "Visual session is closed")
    if (message.length > VisualHostProtocol.MAX_MESSAGE_CHARS) {
      throw VisualHostException(VisualHostProtocol.INVALID_REQUEST, "Visual message is too large")
    }
    try {
      JSONObject(message)
    } catch (error: JSONException) {
      throw VisualHostException(VisualHostProtocol.INVALID_REQUEST, "Visual message is not a JSON object")
    }
    val token = arm(VisualHostProtocol.MESSAGE_DEADLINE_MS)
    if (pageReady) {
      evaluate(message, token)
      return
    }
    if (queued.size >= VisualHostProtocol.MAX_PENDING_POSTS) {
      settle(token)
      throw VisualHostException(VisualHostProtocol.INVALID_REQUEST, "Too many messages before the visual loaded")
    }
    queued.addLast(message to token)
  }

  fun capture(request: String) {
    val view = web
    if (closed || view == null || !pageReady) {
      throw VisualHostException(VisualHostProtocol.CAPTURE_FAILED, "The visual is not displayed")
    }
    val frame = VisualCapture.capture(view)
    val memory = try {
      SharedMemory.create("paseo-visual-capture", frame.png.size)
    } catch (error: ErrnoException) {
      throw VisualHostException(VisualHostProtocol.CAPTURE_FAILED, "Could not share the capture: ${error.message}")
    }
    try {
      val buffer = memory.mapReadWrite()
      buffer.put(frame.png)
      SharedMemory.unmap(buffer)
      memory.setProtect(OsConstants.PROT_READ)
      send(VisualHostProtocol.CAPTURED) {
        putString(VisualHostProtocol.KEY_REQUEST, request)
        putParcelable(VisualHostProtocol.KEY_IMAGE, memory)
        putInt(VisualHostProtocol.KEY_IMAGE_BYTES, frame.png.size)
        putInt(VisualHostProtocol.KEY_WIDTH, frame.width)
        putInt(VisualHostProtocol.KEY_HEIGHT, frame.height)
        putFloat(VisualHostProtocol.KEY_DENSITY, frame.density)
      }
    } catch (error: ErrnoException) {
      throw VisualHostException(VisualHostProtocol.CAPTURE_FAILED, "Could not share the capture: ${error.message}")
    } finally {
      memory.close()
    }
  }

  /** Reports a terminal failure to Paseo and releases everything this session owns. */
  fun fail(code: String, message: String) {
    if (closed) return
    send(VisualHostProtocol.FAILED) {
      putString(VisualHostProtocol.KEY_CODE, code)
      putString(VisualHostProtocol.KEY_TEXT, message)
    }
    if (code == VisualHostProtocol.DOCUMENT_UNRESPONSIVE) beginRecovery()
    else close()
  }

  fun close() {
    if (closed) return
    invalidate()
    // Do not destroy a WebView from inside one of its provider callbacks.
    handler.post { watchdog.during("close") { destroy() } }
  }

  private fun invalidate() {
    closed = true
    handler.removeCallbacks(bridgeSilent)
    for (runnable in deadlines.values) handler.removeCallbacks(runnable)
    deadlines.clear()
    queued.clear()
    onClosed(this)
  }

  private fun destroy() {
    if (destroyed) return
    destroyed = true
    val view = web
    web = null
    keyboard?.close()
    keyboard = null
    viewHost?.release()
    viewHost = null
    view?.destroy()
    if (recovering) {
      recovering = false
      onRecoveryFinished(this)
    }
  }

  private fun beginRecovery() {
    if (closed) return
    invalidate()
    recovering = true
    onRecoveryStarted(this)
    val view = web
    val renderer = view?.let { WebViewCompat.getWebViewRenderProcess(it) }
    keyboard?.close()
    keyboard = null
    // terminate() is a renderer-process operation, not a View operation. Retain the WebView
    // until the renderer-gone callback (or a bounded completion grace) and destroy on its UI thread.
    Thread({
      var terminated = false
      try {
        if (renderer != null) {
          VisualHostDebugFaults.beforeTerminate()
          terminated = renderer.terminate()
        } else {
          android.util.Log.w("PaseoVisualHost", "Unresponsive document has no renderer handle; tearing down")
        }
      } catch (error: RuntimeException) {
        android.util.Log.e("PaseoVisualHost", "Renderer termination failed: ${error.javaClass.simpleName}")
      } catch (error: InterruptedException) {
        android.util.Log.e("PaseoVisualHost", "Renderer termination was interrupted")
        Thread.currentThread().interrupt()
      } finally {
        val grace = if (terminated) 2_000L else 0L
        handler.postDelayed({ watchdog.during("close") { destroy() } }, grace)
      }
    }, "visual-terminate").start()
  }

  override fun onPageReady() {
    if (closed || pageReady) return
    pageReady = true
    settle(loadToken)
    // The bridge reports at window load, before the page finishes; silence means it cannot.
    if (!reported) handler.postDelayed(bridgeSilent, VisualHostProtocol.BRIDGE_DEADLINE_MS)
    while (queued.isNotEmpty()) {
      val (message, token) = queued.removeFirst()
      evaluate(message, token)
    }
  }

  override fun onDocumentMessage(text: String) {
    if (closed) return
    if (!messageBudget.accept() || text.length > VisualHostProtocol.MAX_MESSAGE_CHARS) {
      fail(VisualHostProtocol.DOCUMENT_REJECTED, "The visual document exceeded its message bounds and was closed")
      return
    }
    if (!reported) {
      reported = true
      handler.removeCallbacks(bridgeSilent)
    }
    send(VisualHostProtocol.MESSAGE) { putString(VisualHostProtocol.KEY_MESSAGE, text) }
  }

  override fun onActivity() {
    if (!closed) send(VisualHostProtocol.ACTIVITY) {}
  }

  override fun onRendererGone(crashed: Boolean) {
    if (closed) {
      if (recovering) handler.post { watchdog.during("close") { destroy() } }
      return
    }
    fail(
      VisualHostProtocol.RENDERER_EXITED,
      if (crashed) "The visual renderer crashed; reopen the visual" else "The visual renderer was stopped; reopen the visual",
    )
  }

  private fun evaluate(message: String, token: Int) {
    if (closed || destroyed) return
    val view = web ?: return
    // Valid JSON is a JavaScript expression; escaping '<' and line separators keeps it inert text.
    val literal = message.replace("<", "\\u003c").replace("\u2028", "\\u2028").replace("\u2029", "\\u2029")
    view.evaluateJavascript(
      "window.dispatchEvent(new MessageEvent('message',{data:$literal}));true",
    ) { settle(token) }
  }

  private fun arm(milliseconds: Long): Int {
    val token = ++nextToken
    val expire = Runnable { watchdog.during("terminate") { expire(token) } }
    deadlines[token] = expire
    handler.postDelayed(expire, milliseconds)
    return token
  }

  private fun settle(token: Int) {
    val runnable = deadlines.remove(token) ?: return
    handler.removeCallbacks(runnable)
  }

  private fun expire(token: Int) {
    if (closed || deadlines.remove(token) == null) return
    fail(VisualHostProtocol.DOCUMENT_UNRESPONSIVE, "The visual stopped responding; reopen the visual")
  }

  private fun send(what: Int, fill: Bundle.() -> Unit) {
    val message = Message.obtain(null, what)
    message.data = Bundle().apply {
      putString(VisualHostProtocol.KEY_SESSION, id)
      fill()
    }
    try {
      client.send(message)
    } catch (error: RemoteException) {
      // Paseo is gone; nothing displays this document any more.
      close()
    }
  }
}
