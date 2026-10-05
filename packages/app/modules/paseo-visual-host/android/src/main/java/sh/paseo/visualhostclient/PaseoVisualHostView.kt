package sh.paseo.visualhostclient

import android.annotation.TargetApi
import android.content.Context
import android.graphics.Matrix
import android.os.Build
import android.os.Bundle
import android.os.Message
import android.os.SharedMemory
import android.system.ErrnoException
import android.system.OsConstants
import android.util.Base64
import android.view.MotionEvent
import android.view.SurfaceControlViewHost
import android.view.SurfaceHolder
import android.view.SurfaceView
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.viewevent.EventDispatcher
import expo.modules.kotlin.views.ExpoView

/**
 * Embeds one document session of the companion visual host. The companion renders the document
 * in its own process and UID; this view only owns the SurfaceView whose host token it lends and
 * the SurfacePackage it receives back. Nothing here can render generated HTML.
 */
class PaseoVisualHostView(context: Context, appContext: AppContext) :
  ExpoView(context, appContext),
  SurfaceHolder.Callback,
  VisualHostConnection.Listener {

  private val onHostEvent by EventDispatcher()
  private val surface = SurfaceView(context)
  private var connection: VisualHostConnection? = null
  private var session: String? = null
  private var document: String? = null
  private var opened = false
  private var surfaceReady = false
  private var attached: SurfaceControlViewHost.SurfacePackage? = null
  private val pendingPosts = ArrayList<String>()
  private var hostMessages = 0
  private var embeddedWidth = 0
  private var embeddedHeight = 0
  private var emittedEvents = 0
  private var lastFailure: String? = null

  init {
    // The surface stays behind Paseo's window, so every in-window overlay, header and composer is
    // drawn above the visual. Input that lands on this view (nothing above it) is relayed to the
    // embedded document; focusing the SurfaceView hands window focus to the embedded hierarchy
    // (Android 12+), so the keyboard reaches text fields inside the visual.
    surface.isFocusable = true
    surface.isFocusableInTouchMode = true
    surface.holder.addCallback(this)
    addView(surface, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
  }

  override fun onLayout(changed: Boolean, left: Int, top: Int, right: Int, bottom: Int) {
    val width = right - left
    val height = bottom - top
    surface.measure(
      MeasureSpec.makeMeasureSpec(width, MeasureSpec.EXACTLY),
      MeasureSpec.makeMeasureSpec(height, MeasureSpec.EXACTLY),
    )
    surface.layout(0, 0, width, height)
  }

  fun open(session: String, html: String) {
    require(VisualHostProtocol.isSession(session)) { "Invalid visual session" }
    if (this.session != null) closeCurrent(notifyHost = true)
    this.session = session
    document = html
    opened = false
    pendingPosts.clear()
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) {
      fail(session, VisualHostProtocol.RENDERER_UNAVAILABLE, "Pi visuals on Android need Android 11 or newer")
      return
    }
    if (connection == null) {
      val created = VisualHostConnection(context, this)
      connection = created
      if (!created.bind()) return
    }
    tryOpen()
  }

  fun post(session: String, message: String) {
    requireSession(session)
    require(message.length <= VisualHostProtocol.MAX_MESSAGE_CHARS) { "Visual message is too large" }
    if (!opened) {
      check(pendingPosts.size < VisualHostProtocol.MAX_PENDING_POSTS) { "Too many messages before the visual opened" }
      pendingPosts.add(message)
      return
    }
    sendPost(session, message)
  }

  fun capture(session: String, request: String) {
    requireSession(session)
    require(VisualHostProtocol.isSession(request)) { "Invalid capture request" }
    val sent = opened && connection?.send(
      VisualHostProtocol.CAPTURE,
      Bundle().apply {
        putString(VisualHostProtocol.KEY_SESSION, session)
        putString(VisualHostProtocol.KEY_REQUEST, request)
      },
    ) == true
    if (!sent) {
      emit(
        mapOf(
          "type" to "captureFailed",
          "session" to session,
          "request" to request,
          "message" to "The visual surface is not open",
        ),
      )
    }
  }

  fun close(session: String) {
    if (this.session == session) closeCurrent(notifyHost = true)
  }

  /**
   * Touches reach this view only where nothing in Paseo's window is drawn above the visual. Every
   * action is relayed (down, move, pointer down/up for multi-touch, up and cancel), mapped from this
   * view's coordinates into the embedded view: minus the surface offset, scaled if the embedded
   * size differs from the surface (both are physical pixels on the same display, so density needs
   * no further conversion). Ancestor transforms are already applied to the local coordinates.
   */
  override fun onTouchEvent(event: MotionEvent): Boolean {
    val current = session
    val host = connection
    if (current == null || host == null || !opened || attached == null) return false
    if (event.actionMasked == MotionEvent.ACTION_DOWN) {
      parent?.requestDisallowInterceptTouchEvent(true)
      if (!surface.isFocused) surface.requestFocus()
    }
    val copy = MotionEvent.obtain(event)
    try {
      copy.offsetLocation(-surface.left.toFloat(), -surface.top.toFloat())
      if (surface.width > 0 && surface.height > 0 &&
        (embeddedWidth != surface.width || embeddedHeight != surface.height)
      ) {
        copy.transform(
          Matrix().apply {
            setScale(
              embeddedWidth.toFloat() / surface.width,
              embeddedHeight.toFloat() / surface.height,
            )
          },
        )
      }
      host.send(
        VisualHostProtocol.TOUCH,
        Bundle().apply {
          putString(VisualHostProtocol.KEY_SESSION, current)
          putParcelable(VisualHostProtocol.KEY_EVENT, copy)
        },
      )
    } finally {
      copy.recycle()
    }
    return true
  }

  fun dispose() {
    closeCurrent(notifyHost = true)
    connection?.release()
    connection = null
  }

  /** Observable state for an explicit display failure; independent of the event channel. */
  fun describe(): String {
    val host = connection
    val link = when {
      host == null -> "unbound"
      host.connected -> "connected"
      else -> "binding"
    }
    return listOf(
      "session=${session != null}",
      "link=$link",
      "window=$isAttachedToWindow",
      "view=${width}x$height",
      "surface=${surface.width}x${surface.height}",
      "surfaceReady=$surfaceReady",
      "opened=$opened",
      "attached=${attached != null}",
      "hostMessages=$hostMessages",
      "events=$emittedEvents",
      "lastFailure=${lastFailure ?: "none"}",
    ).joinToString(" ")
  }

  override fun surfaceCreated(holder: SurfaceHolder) {
    surfaceReady = true
    tryOpen()
  }

  override fun surfaceChanged(holder: SurfaceHolder, format: Int, width: Int, height: Int) {
    val current = session
    if (!opened || current == null) {
      tryOpen()
      return
    }
    val nextWidth = width.coerceIn(1, VisualHostProtocol.MAX_SURFACE_DIMENSION)
    val nextHeight = height.coerceIn(1, VisualHostProtocol.MAX_SURFACE_DIMENSION)
    val sent = connection?.send(
      VisualHostProtocol.RESIZE,
      Bundle().apply {
        putString(VisualHostProtocol.KEY_SESSION, current)
        putInt(VisualHostProtocol.KEY_WIDTH, nextWidth)
        putInt(VisualHostProtocol.KEY_HEIGHT, nextHeight)
        putInt(VisualHostProtocol.KEY_DENSITY_DPI, resources.displayMetrics.densityDpi)
      },
    ) == true
    if (sent) {
      embeddedWidth = nextWidth
      embeddedHeight = nextHeight
    }
  }

  override fun surfaceDestroyed(holder: SurfaceHolder) {
    surfaceReady = false
  }

  override fun onConnected() {
    tryOpen()
  }

  override fun onUnavailable(message: String) {
    connection = null
    val current = session ?: return
    fail(current, VisualHostProtocol.RENDERER_UNAVAILABLE, message)
  }

  override fun onHostMessage(message: Message) {
    hostMessages += 1
    val data = message.data
    val current = session
    val from = data.getString(VisualHostProtocol.KEY_SESSION)
    if (current == null || from != current) {
      // A message of a closed session; its surface must not stay alive.
      if (message.what == VisualHostProtocol.ATTACHED && Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
        surfacePackage(data)?.release()
      }
      return
    }
    when (message.what) {
      VisualHostProtocol.ATTACHED -> attach(current, data)
      VisualHostProtocol.MESSAGE -> relayMessage(current, data)
      VisualHostProtocol.CAPTURED -> relayCapture(current, data)
      VisualHostProtocol.FAILED -> relayFailure(current, data)
      VisualHostProtocol.ACTIVITY -> emit(mapOf("type" to "activity", "session" to current))
      else -> fail(current, VisualHostProtocol.INVALID_REQUEST, "Visual host sent an unknown message")
    }
  }

  private fun tryOpen() {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) openOnSurface()
  }

  @TargetApi(Build.VERSION_CODES.R)
  private fun openOnSurface() {
    val current = session ?: return
    val html = document ?: return
    val host = connection ?: return
    if (opened || !host.connected || !surfaceReady || !isAttachedToWindow) return
    val display = surface.display ?: return
    if (surface.width <= 0 || surface.height <= 0) return
    val bytes = html.toByteArray(Charsets.UTF_8)
    if (bytes.isEmpty() || bytes.size > VisualHostProtocol.MAX_DOCUMENT_BYTES) {
      fail(current, VisualHostProtocol.INVALID_REQUEST, "Visual document exceeds the host transport bound")
      return
    }
    val memory = try {
      SharedMemory.create("paseo-visual-document", bytes.size)
    } catch (error: ErrnoException) {
      fail(current, VisualHostProtocol.RENDERER_UNAVAILABLE, "Could not share the visual document: ${error.message}")
      return
    }
    try {
      val buffer = memory.mapReadWrite()
      buffer.put(bytes)
      SharedMemory.unmap(buffer)
      memory.setProtect(OsConstants.PROT_READ)
      val openWidth = surface.width.coerceAtMost(VisualHostProtocol.MAX_SURFACE_DIMENSION)
      val openHeight = surface.height.coerceAtMost(VisualHostProtocol.MAX_SURFACE_DIMENSION)
      val request = Bundle().apply {
        putString(VisualHostProtocol.KEY_SESSION, current)
        putBinder(VisualHostProtocol.KEY_HOST_TOKEN, surface.hostToken)
        putInt(VisualHostProtocol.KEY_DISPLAY, display.displayId)
        putInt(VisualHostProtocol.KEY_WIDTH, openWidth)
        putInt(VisualHostProtocol.KEY_HEIGHT, openHeight)
        putInt(VisualHostProtocol.KEY_DENSITY_DPI, resources.displayMetrics.densityDpi)
        putParcelable(VisualHostProtocol.KEY_DOCUMENT, memory)
        putInt(VisualHostProtocol.KEY_DOCUMENT_BYTES, bytes.size)
      }
      if (!host.send(VisualHostProtocol.OPEN, request)) return
      embeddedWidth = openWidth
      embeddedHeight = openHeight
    } catch (error: ErrnoException) {
      fail(current, VisualHostProtocol.RENDERER_UNAVAILABLE, "Could not share the visual document: ${error.message}")
      return
    } finally {
      memory.close()
    }
    opened = true
    document = null
    val queued = ArrayList(pendingPosts)
    pendingPosts.clear()
    for (message in queued) sendPost(current, message)
  }

  private fun sendPost(current: String, message: String) {
    connection?.send(
      VisualHostProtocol.POST,
      Bundle().apply {
        putString(VisualHostProtocol.KEY_SESSION, current)
        putString(VisualHostProtocol.KEY_MESSAGE, message)
      },
    )
  }

  private fun attach(current: String, data: Bundle) {
    val received = surfacePackage(data)
    if (received == null) {
      fail(current, VisualHostProtocol.INVALID_REQUEST, "Visual host attached no surface")
      return
    }
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
      attached?.release()
      surface.setChildSurfacePackage(received)
      attached = received
      emit(mapOf("type" to "attached", "session" to current))
    }
  }

  private fun relayMessage(current: String, data: Bundle) {
    val text = data.getString(VisualHostProtocol.KEY_MESSAGE)
    if (text.isNullOrEmpty() || text.length > VisualHostProtocol.MAX_MESSAGE_CHARS) {
      fail(current, VisualHostProtocol.DOCUMENT_REJECTED, "Visual document sent an invalid message")
      return
    }
    emit(mapOf("type" to "message", "session" to current, "data" to text))
  }

  private fun relayCapture(current: String, data: Bundle) {
    val request = data.getString(VisualHostProtocol.KEY_REQUEST)
    if (!VisualHostProtocol.isSession(request)) {
      fail(current, VisualHostProtocol.INVALID_REQUEST, "Visual host sent an unaddressed capture")
      return
    }
    val requestId = request ?: return
    val width = data.getInt(VisualHostProtocol.KEY_WIDTH)
    val height = data.getInt(VisualHostProtocol.KEY_HEIGHT)
    val density = data.getFloat(VisualHostProtocol.KEY_DENSITY)
    val size = data.getInt(VisualHostProtocol.KEY_IMAGE_BYTES)
    val memory = sharedMemory(data, VisualHostProtocol.KEY_IMAGE)
    val invalid = memory == null || size <= 0 || size > VisualHostProtocol.MAX_CAPTURE_BYTES ||
      memory.size < size || width !in 1..VisualHostProtocol.MAX_CAPTURE_DIMENSION ||
      height !in 1..VisualHostProtocol.MAX_CAPTURE_DIMENSION || !(density > 0f && density <= 4f)
    if (memory == null || invalid) {
      memory?.close()
      emit(captureFailure(current, requestId, "Visual host returned a capture outside its bounds"))
      return
    }
    val png = try {
      val buffer = memory.mapReadOnly()
      val bytes = ByteArray(size)
      buffer.get(bytes)
      SharedMemory.unmap(buffer)
      bytes
    } catch (error: ErrnoException) {
      emit(captureFailure(current, requestId, "Could not read the capture: ${error.message}"))
      return
    } finally {
      memory.close()
    }
    emit(
      mapOf(
        "type" to "capture",
        "session" to current,
        "request" to requestId,
        "data" to Base64.encodeToString(png, Base64.NO_WRAP),
        "width" to width,
        "height" to height,
        "density" to density.toDouble(),
      ),
    )
  }

  private fun relayFailure(current: String, data: Bundle) {
    val code = data.getString(VisualHostProtocol.KEY_CODE) ?: VisualHostProtocol.INVALID_REQUEST
    val text = (data.getString(VisualHostProtocol.KEY_TEXT) ?: "").ifEmpty { "Visual host failed" }.take(2048)
    val request = data.getString(VisualHostProtocol.KEY_REQUEST)
    if (code == VisualHostProtocol.CAPTURE_FAILED && request != null && VisualHostProtocol.isSession(request)) {
      emit(captureFailure(current, request, text))
      return
    }
    fail(current, code.take(128), text)
  }

  private fun captureFailure(current: String, request: String, message: String): Map<String, Any> =
    mapOf("type" to "captureFailed", "session" to current, "request" to request, "message" to message)

  /** Reports a terminal failure of the current session and releases its surface. */
  private fun fail(current: String, code: String, message: String) {
    lastFailure = "$code: $message".take(512)
    emit(mapOf("type" to "error", "session" to current, "code" to code, "message" to message))
    if (session == current) closeCurrent(notifyHost = connection?.connected == true)
  }

  private fun closeCurrent(notifyHost: Boolean) {
    val current = session
    if (current != null && opened && notifyHost) {
      connection?.send(
        VisualHostProtocol.CLOSE,
        Bundle().apply { putString(VisualHostProtocol.KEY_SESSION, current) },
      )
    }
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
      if (attached != null) surface.clearChildSurfacePackage()
      attached?.release()
    }
    attached = null
    session = null
    document = null
    opened = false
    pendingPosts.clear()
  }

  private fun requireSession(session: String) {
    check(this.session == session) { "Visual session is not mounted" }
  }

  private fun emit(event: Map<String, Any>) {
    emittedEvents += 1
    onHostEvent(event)
  }

  @TargetApi(Build.VERSION_CODES.R)
  private fun surfacePackage(data: Bundle): SurfaceControlViewHost.SurfacePackage? =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      data.getParcelable(VisualHostProtocol.KEY_PACKAGE, SurfaceControlViewHost.SurfacePackage::class.java)
    } else {
      data.getParcelable(VisualHostProtocol.KEY_PACKAGE)
    }

  private fun sharedMemory(data: Bundle, key: String): SharedMemory? =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      data.getParcelable(key, SharedMemory::class.java)
    } else {
      data.getParcelable(key)
    }
}
