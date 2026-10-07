package sh.paseo.visualhostclient

import android.annotation.TargetApi
import android.content.Context
import android.graphics.Matrix
import android.graphics.Rect
import android.text.Editable
import android.text.InputType
import android.text.Selection
import android.text.SpannableStringBuilder
import android.view.KeyEvent
import android.view.View
import android.view.ViewGroup
import android.view.WindowInsets
import android.view.inputmethod.BaseInputConnection
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.ExtractedText
import android.view.inputmethod.ExtractedTextRequest
import android.view.inputmethod.InputConnection
import android.view.inputmethod.InputMethodManager
import android.os.Build
import android.os.Bundle
import android.os.Message
import android.os.SharedMemory
import android.system.ErrnoException
import android.system.OsConstants
import android.util.Base64
import android.util.Log
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
  private var imeWasShown = false
  private var showPending = false
  private val editor = VisualEditor(this, object : EditorTransport {
    override fun send(data: Bundle): Boolean = connection?.send(VisualHostProtocol.INPUT, data) == true
    override fun ended() {
      showPending = false
      if (isFocused) {
        context.getSystemService(InputMethodManager::class.java).hideSoftInputFromWindow(windowToken, 0)
        clearFocus()
      }
    }
  })

  init {
    // The surface never owns input focus: the IME must belong to Paseo's window on every OEM.
    isFocusable = true
    isFocusableInTouchMode = true
    descendantFocusability = ViewGroup.FOCUS_BLOCK_DESCENDANTS
    surface.isFocusable = false
    surface.isFocusableInTouchMode = false
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
      setOnApplyWindowInsetsListener { _, insets ->
        val shown = insets.isVisible(WindowInsets.Type.ime())
        if (imeWasShown && !shown && editor.active) editor.stop(true)
        imeWasShown = shown
        insets
      }
    }
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
    editor.bind(session)
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
      // Focus is claimed only after the companion reports an editable element.
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
      VisualHostProtocol.EDITOR -> {
        val previousGeneration = editor.generation
        if (editor.receive(data)) {
          // Echoes of the same focused field keep the existing keyboard; only a new focus binds it.
          if (!isFocused || previousGeneration != editor.generation) {
            requestFocus()
            val ime = context.getSystemService(InputMethodManager::class.java)
            ime.restartInput(this)
            // The element was focused by the user's tap: request the keyboard explicitly, as an
            // EditText does. If the IMM has not bound this view yet, onCreateInputConnection shows it.
            showPending = true
            post { showKeyboardIfBound() }
          }
        }
      }
      else -> fail(current, VisualHostProtocol.INVALID_REQUEST, "Visual host sent an unknown message")
    }
  }

  override fun onCheckIsTextEditor(): Boolean = editor.active

  override fun onCreateInputConnection(info: EditorInfo): InputConnection? {
    val created = editor.connection(info)
    if (created != null && showPending) post { showKeyboardIfBound() }
    return created
  }

  private fun showKeyboardIfBound() {
    if (!showPending) return
    if (!editor.active || !isFocused) {
      showPending = false
      return
    }
    val ime = context.getSystemService(InputMethodManager::class.java)
    // Not served yet: the IMM's next onCreateInputConnection for this view retries once bound.
    if (!ime.isActive(this)) return
    showPending = false
    ime.showSoftInput(this, 0)
  }

  override fun onFocusChanged(gainFocus: Boolean, direction: Int, previouslyFocusedRect: Rect?) {
    super.onFocusChanged(gainFocus, direction, previouslyFocusedRect)
    if (!gainFocus) editor.stop(true)
  }

  override fun onKeyPreIme(keyCode: Int, event: KeyEvent): Boolean {
    if (keyCode == KeyEvent.KEYCODE_BACK && editor.active) {
      if (event.action == KeyEvent.ACTION_UP) editor.stop(true)
      return true
    }
    return super.onKeyPreIme(keyCode, event)
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
    editor.stop(notifyHost)
    editor.bind(null)
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

/** The production editor's only outbound boundary; text is never sent through React Native. */
interface EditorTransport {
  fun send(data: Bundle): Boolean
  fun ended()
}

/** A transient IME mirror, bound to one mount and focus generation. */
class VisualEditor(private val host: View, private val transport: EditorTransport) {
  private var session: String? = null
  private val text = SpannableStringBuilder()
  private var sequence = 0L
  private var epoch = 0L
  private var connectionSerial = 0L
  private var retiredGeneration = 0L
  private var inputKind = "text"
  var generation = 0L
    private set
  val active: Boolean get() = generation > 0L

  fun bind(session: String?) {
    stop(false)
    this.session = session
    retiredGeneration = 0L
    epoch += 1
  }

  fun receive(data: Bundle): Boolean {
    if (data.get(VisualHostProtocol.KEY_SESSION) != session || session == null) return false
    val next = data.get(VisualHostProtocol.KEY_GENERATION) as? Long
    val ack = data.get(VisualHostProtocol.KEY_SEQUENCE) as? Long
    val focused = data.get(VisualHostProtocol.KEY_FOCUSED) as? Boolean
    if (next == null || next <= 0 || ack == null || ack < 0 || focused == null) {
      stop(true)
      return false
    }
    if (next <= retiredGeneration || next < generation) return false
    if (!focused) {
      retiredGeneration = maxOf(retiredGeneration, next)
      stop(false)
      return false
    }
    val value = data.get(VisualHostProtocol.KEY_TEXT) as? String
    val start = data.get(VisualHostProtocol.KEY_SELECTION_START) as? Int
    val end = data.get(VisualHostProtocol.KEY_SELECTION_END) as? Int
    val kind = data.get(VisualHostProtocol.KEY_INPUT_KIND) as? String
    if (value == null || start == null || end == null || kind == null ||
      !VisualHostProtocol.validEditorText(value) || !VisualHostProtocol.validSelection(value, start, end) ||
      !VisualHostProtocol.validInputKind(kind)
    ) {
      stop(true)
      return false
    }
    if (next == generation && ack < sequence) return true
    if ((next == generation && ack > sequence) || (next != generation && ack != 0L)) {
      stop(true)
      return false
    }
    if (next != generation) {
      epoch += 1
      text.clear()
      text.clearSpans()
      generation = next
    }
    sequence = ack
    inputKind = kind
    if (text.toString() != value) text.replace(0, text.length, value)
    Selection.setSelection(text, start, end)
    return true
  }

  fun stop(notify: Boolean) {
    if (!active) return
    Log.i("PaseoVisualEditor", "editor stopped (notify=$notify)")
    if (notify) send("blur", null, 0, 0)
    retiredGeneration = maxOf(retiredGeneration, generation)
    generation = 0L
    epoch += 1
    sequence = 0L
    text.clear()
    text.clearSpans()
    transport.ended()
  }

  fun connection(info: EditorInfo): InputConnection? {
    if (!active) return null
    info.inputType = when (inputKind) {
      "number" -> InputType.TYPE_CLASS_NUMBER
      "multiline" -> InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_MULTI_LINE
      else -> InputType.TYPE_CLASS_TEXT
    }
    info.imeOptions = EditorInfo.IME_FLAG_NO_EXTRACT_UI or
      if (inputKind == "multiline") EditorInfo.IME_FLAG_NO_ENTER_ACTION else EditorInfo.IME_ACTION_DONE
    info.initialSelStart = Selection.getSelectionStart(text)
    info.initialSelEnd = Selection.getSelectionEnd(text)
    connectionSerial += 1
    return Connection(epoch, connectionSerial)
  }

  private fun send(operation: String, value: String?, first: Int, second: Int): Boolean {
    val mounted = session ?: return false
    if (!active) return false
    sequence += 1
    val data = Bundle().apply {
      putString(VisualHostProtocol.KEY_SESSION, mounted)
      putLong(VisualHostProtocol.KEY_GENERATION, generation)
      putLong(VisualHostProtocol.KEY_SEQUENCE, sequence)
      putString(VisualHostProtocol.KEY_OPERATION, operation)
      if (value != null) putString(VisualHostProtocol.KEY_TEXT, value)
      putInt(VisualHostProtocol.KEY_FIRST, first)
      putInt(VisualHostProtocol.KEY_SECOND, second)
    }
    return transport.send(data)
  }

  private inner class Connection(private val binding: Long, private val serial: Long) : BaseInputConnection(host, true) {
    private var disconnected = false
    // Validity follows the IMM's own retirement (closeConnection) and the focus epoch. The IMM may
    // create a further connection without moving the keyboard off this one (observed on API 36),
    // so "newest created" is not a retirement signal.
    private fun live(): Boolean = !disconnected && active && epoch == binding
    override fun getEditable(): Editable = text

    private fun apply(operation: String, value: CharSequence?, first: Int, second: Int, edit: () -> Boolean): Boolean {
      if (!live()) {
        // Loud, content-free: an IME operation reached a connection that no longer serves the field.
        Log.w(
          "PaseoVisualEditor",
          "dropped $operation: disconnected=$disconnected active=$active epochMatch=${epoch == binding} connection=#$serial",
        )
        return false
      }
      val string = value?.toString()
      if (string != null && (!VisualHostProtocol.validEditorText(string) ||
        first !in -VisualHostProtocol.MAX_EDITOR_BYTES..VisualHostProtocol.MAX_EDITOR_BYTES)
      ) {
        stop(true)
        return false
      }
      if (!edit() || !VisualHostProtocol.validEditorText(text.toString())) {
        stop(true)
        return false
      }
      if (!send(operation, string, first, second)) {
        Log.w("PaseoVisualEditor", "relay of $operation failed; ending the editor")
        stop(false)
        return false
      }
      return true
    }

    override fun commitText(value: CharSequence?, cursor: Int): Boolean =
      apply("commit", value ?: "", cursor, 0) { super.commitText(value ?: "", cursor) }
    override fun setComposingText(value: CharSequence?, cursor: Int): Boolean =
      apply("compose", value ?: "", cursor, 0) { super.setComposingText(value ?: "", cursor) }
    override fun finishComposingText(): Boolean = apply("finish", null, 0, 0) { super.finishComposingText() }
    override fun deleteSurroundingText(before: Int, after: Int): Boolean {
      if (before !in 0..VisualHostProtocol.MAX_EDITOR_BYTES || after !in 0..VisualHostProtocol.MAX_EDITOR_BYTES) {
        if (live()) stop(true)
        return false
      }
      return apply("delete", null, before, after) { super.deleteSurroundingText(before, after) }
    }
    override fun deleteSurroundingTextInCodePoints(before: Int, after: Int): Boolean {
      if (before !in 0..VisualHostProtocol.MAX_EDITOR_BYTES || after !in 0..VisualHostProtocol.MAX_EDITOR_BYTES) {
        if (live()) stop(true)
        return false
      }
      return apply("deleteCodePoints", null, before, after) { super.deleteSurroundingTextInCodePoints(before, after) }
    }
    override fun setSelection(start: Int, end: Int): Boolean {
      if (!VisualHostProtocol.validSelection(text.toString(), start, end)) {
        if (live()) stop(true)
        return false
      }
      return apply("selection", null, start, end) { super.setSelection(start, end) }
    }
    override fun setComposingRegion(start: Int, end: Int): Boolean {
      if (!VisualHostProtocol.validSelection(text.toString(), start, end)) {
        if (live()) stop(true)
        return false
      }
      return apply("region", null, start, end) { super.setComposingRegion(start, end) }
    }
    override fun sendKeyEvent(event: KeyEvent): Boolean {
      if (event.keyCode != KeyEvent.KEYCODE_ENTER && event.keyCode != KeyEvent.KEYCODE_DEL) return false
      return apply("key", null, event.keyCode, event.action) {
        if (event.action == KeyEvent.ACTION_DOWN) {
          if (event.keyCode == KeyEvent.KEYCODE_DEL) super.deleteSurroundingText(1, 0)
          else if (inputKind == "multiline") super.commitText("\n", 1)
          else true
        } else event.action == KeyEvent.ACTION_UP
      }
    }
    override fun performEditorAction(action: Int): Boolean = apply("action", null, action, 0) { true }
    override fun beginBatchEdit(): Boolean = live()
    override fun endBatchEdit(): Boolean = live()
    override fun getTextBeforeCursor(length: Int, flags: Int): CharSequence? =
      if (live() && length >= 0) super.getTextBeforeCursor(length.coerceAtMost(VisualHostProtocol.MAX_EDITOR_BYTES), flags) else null
    override fun getTextAfterCursor(length: Int, flags: Int): CharSequence? =
      if (live() && length >= 0) super.getTextAfterCursor(length.coerceAtMost(VisualHostProtocol.MAX_EDITOR_BYTES), flags) else null
    override fun getSelectedText(flags: Int): CharSequence? = if (live()) super.getSelectedText(flags) else null
    override fun getExtractedText(request: ExtractedTextRequest?, flags: Int): ExtractedText? {
      if (!live()) return null
      return ExtractedText().apply {
        text = this@VisualEditor.text.toString()
        selectionStart = Selection.getSelectionStart(this@VisualEditor.text)
        selectionEnd = Selection.getSelectionEnd(this@VisualEditor.text)
      }
    }
    override fun closeConnection() {
      // IMM closes the previous connection during restartInput, without ending DOM focus.
      // Blur, window insets, composer handoff and mount lifetime retire the editor instead.
      disconnected = true
    }
  }
}
