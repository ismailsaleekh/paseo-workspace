package sh.paseo.visualhost

import android.content.Context
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.text.InputType
import android.util.Log
import android.view.KeyEvent
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputConnection
import android.webkit.WebView
import androidx.webkit.JavaScriptReplyProxy
import androidx.webkit.ScriptHandler
import androidx.webkit.WebMessageCompat
import androidx.webkit.WebViewCompat
import org.json.JSONException
import org.json.JSONObject
import java.util.UUID

/** A WebView may supply an internal input connection, but must never offer one to the system IME. */
class VisualKeyboardWebView(context: Context) : WebView(context) {
  private var lendingConnection = false
  override fun onCheckIsTextEditor(): Boolean = lendingConnection && super.onCheckIsTextEditor()
  override fun onCreateInputConnection(info: EditorInfo): InputConnection? = null
  fun visualConnection(info: EditorInfo): InputConnection? {
    lendingConnection = true
    try {
      return super.onCreateInputConnection(info)
    } finally {
      lendingConnection = false
    }
  }
}

interface KeyboardTransport {
  fun send(data: Bundle)
  fun rejected()
}

/** The document's production keyboard consumer. All methods run on the WebView's UI thread. */
class VisualKeyboardBridge(
  private val web: VisualKeyboardWebView,
  private val session: String,
  private val transport: KeyboardTransport,
  private val budget: VisualMessageBudget,
  private val watchdog: MainThreadWatchdog,
) {
  private var connection: InputConnection? = null
  @Volatile private var generation = 0L
  private var retiredGeneration = 0L
  private var sequence = 0L
  private var fieldText = ""
  @Volatile private var closed = false
  private var script: ScriptHandler? = null
  private val handler = Handler(Looper.getMainLooper())
  private var pendingEditor: Bundle? = null
  private var editorDeadline = 0L
  private var focusReportedAt = 0L
  private var editorAttempts = 0
  private var lastNativeClass = -1
  private var lastNativeConnected = false
  private val establishEditor = Runnable { watchdog.during("input") { establishEditor() } }
  private val inputTasks = HashMap<InputTask, Handler>()
  private val queuedInputs = ArrayDeque<InputTask>()
  private var awaitedBarrier = 0L
  private var blurPending = false
  private val barrierExpired = Runnable {
    watchdog.during("input") {
      if (!closed && awaitedBarrier != 0L) {
        Log.w("PaseoVisualHost", "Visual editor input was not confirmed by the document in time")
        end(true)
      }
    }
  }
  private val reportFunction = "__paseoEditor_" + UUID.randomUUID().toString().replace("-", "")

  fun install() {
    WebViewCompat.addWebMessageListener(
      web, PORT, setOf(VisualHostProtocol.DOCUMENT_ORIGIN),
      object : WebViewCompat.WebMessageListener {
        override fun onPostMessage(
          view: WebView, message: WebMessageCompat, origin: Uri,
          mainFrame: Boolean, reply: JavaScriptReplyProxy,
        ) {
          if (!closed && mainFrame) watchdog.during("input") {
            if (message.type == WebMessageCompat.TYPE_STRING) report(message.data)
            else report(null)
          }
        }
      },
    )
    script = WebViewCompat.addDocumentStartJavaScript(web, observer(), setOf(VisualHostProtocol.DOCUMENT_ORIGIN))
  }

  /** Also used by native instrumentation: this is the same receipt boundary the document uses. */
  fun report(raw: String?) {
    if (closed) return
    // Count before decoding, including invalid/stale receipts. This budget is shared with the
    // document's normal visual-state port, so another untrusted channel cannot double it.
    if (!budget.accept()) {
      close()
      transport.rejected()
      return
    }
    if (raw == null || raw.length > 512 * 1024) {
      Log.w("PaseoVisualHost", "Visual editor rejected report size or type")
      end(true)
      return
    }
    val report = try {
      JSONObject(raw)
    } catch (error: JSONException) {
      Log.w("PaseoVisualHost", "Visual editor rejected malformed report JSON")
      end(true)
      return
    }
    val next = integer(report.opt("generation"))
    val ack = integer(report.opt("sequence"))
    val focused = report.opt("focused") as? Boolean
    if (next == null || next <= 0 || ack == null || ack < 0 || focused == null) {
      Log.w("PaseoVisualHost", "Visual editor rejected report envelope")
      end(true)
      return
    }
    if (next <= retiredGeneration || next < generation) return
    if (focused && next == generation && awaitedBarrier != 0L && ack == awaitedBarrier) {
      // The document confirmed the in-flight operation: release the next one.
      awaitedBarrier = 0L
      handler.removeCallbacks(barrierExpired)
      if (!startNextInput()) return
    }
    if (!focused) {
      if (next == generation) end(false)
      return
    }
    val text = report.opt("text") as? String
    val start = integer(report.opt("selectionStart"))
    val finish = integer(report.opt("selectionEnd"))
    val kind = report.opt("inputKind") as? String
    if (text == null || start == null || finish == null || kind == null ||
      !VisualHostProtocol.validEditorText(text) || start < 0 || finish < 0 || start > Int.MAX_VALUE || finish > Int.MAX_VALUE ||
      !VisualHostProtocol.validSelection(text, start.toInt(), finish.toInt()) ||
      !VisualHostProtocol.validInputKind(kind)
    ) {
      Log.w("PaseoVisualHost", "Visual editor rejected focused-field snapshot")
      generation = next
      end(true)
      return
    }
    if (next == generation && ack < sequence) return
    if ((ack > sequence && next == generation) || (next != generation && ack != 0L)) {
      end(true)
      return
    }
    if (next != generation) {
      handler.removeCallbacks(establishEditor)
      generation = next
      cancelInputs()
      sequence = 0
      connection = null
      editorDeadline = SystemClock.uptimeMillis() + 2_000L
      focusReportedAt = SystemClock.uptimeMillis()
      editorAttempts = 0
    }
    fieldText = text
    val snapshot = Bundle().apply {
      putString(VisualHostProtocol.KEY_SESSION, session)
      putBoolean(VisualHostProtocol.KEY_FOCUSED, true)
      putLong(VisualHostProtocol.KEY_GENERATION, generation)
      putLong(VisualHostProtocol.KEY_SEQUENCE, ack)
      putString(VisualHostProtocol.KEY_TEXT, text)
      putString(VisualHostProtocol.KEY_INPUT_KIND, kind)
      putInt(VisualHostProtocol.KEY_SELECTION_START, start.toInt())
      putInt(VisualHostProtocol.KEY_SELECTION_END, finish.toInt())
    }
    if (connection == null) {
      pendingEditor = snapshot
      handler.removeCallbacks(establishEditor)
      // focusin's WebMessage can precede Chromium's native editor metadata update. Never lend
      // a TYPE_NULL connection as though it could edit; wait for the actual native editor.
      handler.post(establishEditor)
    } else transport.send(snapshot)
  }

  private fun nativeConnection(): InputConnection? {
    val info = EditorInfo()
    val candidate = web.visualConnection(info)
    val nativeClass = info.inputType and InputType.TYPE_MASK_CLASS
    val connected = candidate != null
    if (nativeClass != lastNativeClass || connected != lastNativeConnected) {
      lastNativeClass = nativeClass
      lastNativeConnected = connected
      Log.d("PaseoVisualHost", "Visual native editor class=$nativeClass connected=$connected viewFocus=${web.hasFocus()} windowFocus=${web.hasWindowFocus()}")
    }
    return if (nativeClass != 0) candidate else null
  }

  private fun establishEditor() {
    if (closed || generation == 0L || pendingEditor == null) return
    connection = nativeConnection()
    editorAttempts += 1
    val snapshot = pendingEditor
    if (connection != null && snapshot != null) {
      pendingEditor = null
      // Content-free latency diagnostic: focus report receipt to the native editor's connection.
      Log.i("PaseoVisualHost", "Visual editor established after ${SystemClock.uptimeMillis() - focusReportedAt} ms (attempts $editorAttempts)")
      transport.send(snapshot)
    } else if (SystemClock.uptimeMillis() >= editorDeadline) {
      Log.w("PaseoVisualHost", "Visual editor did not establish a native input connection (viewFocus=${web.hasFocus()} windowFocus=${web.hasWindowFocus()})")
      end(true)
    } else handler.postDelayed(establishEditor, 16L)
  }

  /** Returns false for rejected/late operations, without delivering them to any other field. */
  fun input(data: Bundle): Boolean {
    if (closed || data.get(VisualHostProtocol.KEY_SESSION) != session) {
      Log.w("PaseoVisualHost", "Visual editor ignored input for a closed or other session")
      return false
    }
    val focus = data.get(VisualHostProtocol.KEY_GENERATION) as? Long
    val ordinal = data.get(VisualHostProtocol.KEY_SEQUENCE) as? Long
    if (generation == 0L || focus != generation || ordinal == null || ordinal <= sequence || blurPending) {
      // Late operations after blur/handoff are expected; log the reason (never the content).
      Log.w("PaseoVisualHost", "Visual editor ignored stale input (active=${generation != 0L} generationMatch=${focus == generation} ordinalValid=${ordinal != null && ordinal > sequence} blurPending=$blurPending)")
      return false
    }
    val op = data.get(VisualHostProtocol.KEY_OPERATION) as? String
    val first = data.get(VisualHostProtocol.KEY_FIRST) as? Int
    val second = data.get(VisualHostProtocol.KEY_SECOND) as? Int
    val text = data.get(VisualHostProtocol.KEY_TEXT) as? String
    if (first == null || second == null) {
      Log.w("PaseoVisualHost", "Visual editor ended on input without operands ($op)")
      end(true)
      return false
    }
    val valid = ordinal == sequence + 1 && when (op) {
      "commit", "compose" -> text != null && VisualHostProtocol.validEditorText(text) &&
        first in -VisualHostProtocol.MAX_EDITOR_BYTES..VisualHostProtocol.MAX_EDITOR_BYTES
      "delete", "deleteCodePoints" -> first in 0..VisualHostProtocol.MAX_EDITOR_BYTES && second in 0..VisualHostProtocol.MAX_EDITOR_BYTES
      "selection", "region" -> VisualHostProtocol.validSelection(fieldText, first, second)
      "finish", "blur" -> first == 0 && second == 0
      "key" -> (first == KeyEvent.KEYCODE_ENTER || first == KeyEvent.KEYCODE_DEL) &&
        (second == KeyEvent.ACTION_DOWN || second == KeyEvent.ACTION_UP)
      "action" -> first in EditorInfo.IME_ACTION_UNSPECIFIED..EditorInfo.IME_ACTION_PREVIOUS && second == 0
      else -> false
    }
    if (!valid) {
      Log.w("PaseoVisualHost", "Visual editor ended on invalid input $op (ordinalInOrder=${ordinal == sequence + 1})")
      end(true)
      return false
    }
    sequence = ordinal
    if (op == "blur") {
      // Keystrokes accepted before the blur are applied first, in order, with the same pacing;
      // focus ends once the last one is confirmed (bounded by the same message deadline).
      if (awaitedBarrier == 0L && queuedInputs.isEmpty()) end(true) else blurPending = true
      return true
    }
    // Reuse the connection established for this focus generation. Re-calling the WebView's
    // onCreateInputConnection per operation would restart Chromium's IME state while earlier
    // operations may still be queued on its IME thread.
    // A real field change arrives as a new focus generation and re-establishes the connection.
    val target = connection
    if (target == null) {
      Log.w("PaseoVisualHost", "Visual editor lost its native input connection")
      end(true)
      return false
    }
    if (inputTasks.size + queuedInputs.size >= VisualHostProtocol.MAX_PENDING_POSTS) {
      Log.w("PaseoVisualHost", "Visual editor input queue exceeded its bound")
      end(true)
      return false
    }
    queuedInputs.addLast(InputTask(target, generation, ordinal, op, text, first, second))
    return if (awaitedBarrier == 0L) startNextInput() else true
  }

  /**
   * One operation at a time, in order: the next starts only after the document's barrier receipt
   * confirmed the previous one, so a missing confirmation ends keyboard focus loudly instead of
   * losing input silently. Bounded by the document message deadline. UI thread only.
   */
  private fun startNextInput(): Boolean {
    val task = queuedInputs.removeFirstOrNull()
    if (task == null) {
      if (!blurPending) return true
      blurPending = false
      end(true)
      return false
    }
    // Chromium may supply a threaded InputConnection. The platform dispatches IME operations
    // on getHandler(), not necessarily the WebView's UI thread. A null handler means UI thread.
    val owner = task.target.handler ?: handler
    inputTasks[task] = owner
    awaitedBarrier = task.ordinal
    handler.removeCallbacks(barrierExpired)
    handler.postDelayed(barrierExpired, VisualHostProtocol.MESSAGE_DEADLINE_MS.toLong())
    if (!owner.post(task)) {
      inputTasks.remove(task)
      Log.w("PaseoVisualHost", "Visual editor input handler stopped")
      end(true)
      return false
    }
    return true
  }

  private inner class InputTask(
    val target: InputConnection,
    private val binding: Long,
    val ordinal: Long,
    private val operation: String?,
    private val text: String?,
    private val first: Int,
    private val second: Int,
  ) : Runnable {
    override fun run() {
      if (Looper.myLooper() == Looper.getMainLooper()) watchdog.during("input") { dispatch() }
      else dispatch()
    }

    private fun dispatch() {
      if (closed || generation != binding) {
        Log.w("PaseoVisualHost", "Visual editor skipped input $operation #$ordinal after focus ended")
        return
      }
      val applied = try {
        when (operation) {
          "commit" -> target.commitText(text, first)
          "compose" -> target.setComposingText(text, first)
          "finish" -> target.finishComposingText()
          "delete" -> target.deleteSurroundingText(first, second)
          "deleteCodePoints" -> target.deleteSurroundingTextInCodePoints(first, second)
          "selection" -> target.setSelection(first, second)
          "region" -> target.setComposingRegion(first, second)
          "key" -> target.sendKeyEvent(KeyEvent(second, first))
          "action" -> target.performEditorAction(first)
          else -> false
        }
      } catch (error: RuntimeException) {
        Log.e("PaseoVisualHost", "Visual editor input failed: ${error.javaClass.simpleName}")
        false
      }
      handler.post {
        watchdog.during("input") {
          inputTasks.remove(this@InputTask)
          if (!closed && generation == binding) {
            if (!applied) {
              Log.w("PaseoVisualHost", "Visual editor rejected input operation $operation")
              end(true)
            } else {
              // Queue the barrier after the native operation, back on the WebView UI thread.
              web.evaluateJavascript("window['$reportFunction']($ordinal,false,$binding)", null)
            }
          }
        }
      }
    }
  }

  private fun cancelInputs() {
    val unapplied = queuedInputs.size + inputTasks.size
    if (unapplied > 0) Log.w("PaseoVisualHost", "Visual editor focus ended with $unapplied unapplied input operations")
    for ((task, owner) in inputTasks) owner.removeCallbacks(task)
    inputTasks.clear()
    queuedInputs.clear()
    awaitedBarrier = 0L
    blurPending = false
    handler.removeCallbacks(barrierExpired)
  }

  fun end(blur: Boolean) {
    val old = generation
    if (old == 0L) return
    Log.i("PaseoVisualHost", "Visual editor focus ended (blur=$blur)")
    generation = 0L
    cancelInputs()
    retiredGeneration = maxOf(retiredGeneration, old)
    fieldText = ""
    connection = null
    pendingEditor = null
    handler.removeCallbacks(establishEditor)
    transport.send(Bundle().apply {
      putString(VisualHostProtocol.KEY_SESSION, session)
      putBoolean(VisualHostProtocol.KEY_FOCUSED, false)
      putLong(VisualHostProtocol.KEY_GENERATION, old)
      putLong(VisualHostProtocol.KEY_SEQUENCE, sequence)
    })
    if (blur && !closed) web.evaluateJavascript("window['$reportFunction']($sequence,true,$old)", null)
  }

  fun close() {
    if (closed) return
    closed = true
    end(false)
    script?.remove()
    script = null
    WebViewCompat.removeWebMessageListener(web, PORT)
  }

  private fun integer(value: Any?): Long? = when (value) {
    is Int -> value.toLong()
    is Long -> value
    else -> null
  }

  private fun observer(): String = """
    (() => {
      let field = null, generation = 0, sequence = 0, last = '';
      function editable(node) {
        if (!node || node.disabled || node.readOnly) return null;
        if (node instanceof HTMLTextAreaElement || node.isContentEditable) return node;
        if (node instanceof HTMLInputElement &&
          ['text','search','email','url','tel','password','number'].includes(node.type)) return node;
        return null;
      }
      function report() {
        const next = editable(document.activeElement);
        if (next !== field) {
          if (field) window.$PORT.postMessage(JSON.stringify({focused:false,generation,sequence}));
          field = next; last = '';
          if (field) { generation += 1; sequence = 0; }
        }
        if (!field) return;
        const text = field.isContentEditable ? field.textContent : field.value;
        let start = field.selectionStart, end = field.selectionEnd;
        if (field.isContentEditable) {
          const selection = window.getSelection();
          if (!selection || !selection.rangeCount || !field.contains(selection.anchorNode) || !field.contains(selection.focusNode)) return;
          function offset(node, offset) {
            const range = document.createRange(); range.selectNodeContents(field);
            range.setEnd(node, offset); return range.toString().length;
          }
          start = offset(selection.anchorNode, selection.anchorOffset);
          end = offset(selection.focusNode, selection.focusOffset);
        }
        const inputKind = field instanceof HTMLTextAreaElement || field.isContentEditable ? 'multiline' :
          (field.type === 'number' || field.inputMode === 'numeric' || field.inputMode === 'decimal' ? 'number' : 'text');
        // Number/email inputs do not expose selectionStart; their initial caret is at the end.
        if (start === null) start = text.length;
        if (end === null) end = text.length;
        const payload = new TextEncoder().encode(text).length > ${VisualHostProtocol.MAX_EDITOR_BYTES} ?
          {focused:true,generation,sequence,invalid:true} :
          {focused:true,generation,sequence,text,selectionStart:start,selectionEnd:end,inputKind};
        const encoded = JSON.stringify(payload);
        if (encoded !== last) { last = encoded; window.$PORT.postMessage(encoded); }
      }
      Object.defineProperty(window, '$reportFunction', {value: (ack, blur, expected) => {
        if (expected !== generation) return;
        sequence = ack;
        if (blur && field && document.activeElement === field) field.blur();
        report();
      }});
      for (const event of ['focusin','focusout','input','selectionchange'])
        document.addEventListener(event, () => queueMicrotask(report), true);
      setInterval(report, 100);
    })();
  """.trimIndent()

  companion object {
    private const val PORT = "paseoVisualEditor"
  }
}

interface MessageClock {
  fun now(): Long
}

/** One native admission budget for every untrusted message of a document. UI-thread owned. */
class VisualMessageBudget(private val clock: MessageClock) {
  constructor() : this(object : MessageClock {
    override fun now(): Long = SystemClock.uptimeMillis()
  })

  private var started = -1L
  private var count = 0

  fun accept(): Boolean {
    val now = clock.now()
    if (started < 0L || now - started >= 1_000L) {
      started = now
      count = 0
    }
    if (count >= VisualHostProtocol.MESSAGES_PER_SECOND) return false
    count += 1
    return true
  }
}
