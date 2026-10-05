package sh.paseo.visualhost

/**
 * Messenger protocol shared with the Paseo app's embedding adapter
 * (packages/app/modules/paseo-visual-host, VisualHostProtocol.kt). Message codes, keys, bounds
 * and error codes must match that copy.
 */
object VisualHostProtocol {
  // Paseo -> visual host
  const val OPEN = 1
  const val RESIZE = 2
  const val POST = 3
  const val CAPTURE = 4
  const val CLOSE = 5
  /** Start the WebView and the visual profile's renderer ahead of the first document. */
  const val WARM = 6
  /** A touch on the visual's area in Paseo, relayed to the embedded document. */
  const val TOUCH = 7

  // Visual host -> Paseo
  const val ATTACHED = 101
  const val MESSAGE = 102
  const val CAPTURED = 103
  const val FAILED = 104
  const val ACTIVITY = 105

  const val KEY_SESSION = "session"
  const val KEY_HOST_TOKEN = "hostToken"
  const val KEY_DISPLAY = "displayId"
  const val KEY_WIDTH = "width"
  const val KEY_HEIGHT = "height"
  const val KEY_DENSITY_DPI = "densityDpi"
  const val KEY_DENSITY = "density"
  const val KEY_DOCUMENT = "document"
  const val KEY_DOCUMENT_BYTES = "documentBytes"
  const val KEY_MESSAGE = "message"
  const val KEY_REQUEST = "request"
  const val KEY_PACKAGE = "package"
  const val KEY_IMAGE = "image"
  const val KEY_IMAGE_BYTES = "imageBytes"
  const val KEY_CODE = "code"
  const val KEY_TEXT = "text"
  const val KEY_EVENT = "event"

  const val MAX_DOCUMENT_BYTES = 4 * 1024 * 1024
  const val MAX_MESSAGE_CHARS = 128 * 1024
  const val MAX_CAPTURE_BYTES = 2 * 1024 * 1024
  const val MAX_CAPTURE_DIMENSION = 4096
  const val MAX_SURFACE_DIMENSION = 8192
  const val MAX_PENDING_POSTS = 64

  /** Host-owned deadline for a document to accept a delivered message (daemon allows 13 s). */
  const val MESSAGE_DEADLINE_MS = 5_000L
  /** Host-owned deadline for the document to finish loading. */
  const val LOAD_DEADLINE_MS = 9_000L
  /** After loading, the document bridge must have reported within this time. */
  const val BRIDGE_DEADLINE_MS = 3_000L
  /** Messages a document may send per second before it is closed as abusive. */
  const val MESSAGES_PER_SECOND = 120

  const val RENDERER_UNAVAILABLE = "RENDERER_UNAVAILABLE"
  const val DOCUMENT_UNRESPONSIVE = "DOCUMENT_UNRESPONSIVE"
  const val RENDERER_EXITED = "RENDERER_EXITED"
  const val CAPTURE_FAILED = "CAPTURE_FAILED"
  const val INVALID_REQUEST = "INVALID_REQUEST"
  const val DOCUMENT_REJECTED = "DOCUMENT_REJECTED"

  /** Synthetic origin of every generated document; nothing is ever fetched from it. */
  const val DOCUMENT_ORIGIN = "https://visual.invalid"
  const val DOCUMENT_URL = "$DOCUMENT_ORIGIN/"
  /** Name of the injected message port the document bridge reports through. */
  const val BRIDGE_OBJECT = "paseoVisualHost"
  /** Dedicated WebView profile: its own renderer, storage and cookies. */
  const val PROFILE = "paseo-visual"

  private val SESSION = Regex("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")

  fun isSession(value: String?): Boolean = value != null && SESSION.matches(value)
}

/** An explicit failure that crosses the IPC boundary as a FAILED message with this code. */
class VisualHostException(val code: String, message: String) : Exception(message)
