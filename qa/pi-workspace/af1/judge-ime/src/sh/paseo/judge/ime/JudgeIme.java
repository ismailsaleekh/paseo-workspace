package sh.paseo.judge.ime;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.graphics.Color;
import android.inputmethodservice.InputMethodService;
import android.util.Base64;
import android.util.Log;
import android.view.KeyEvent;
import android.view.View;
import android.view.inputmethod.EditorInfo;
import android.view.inputmethod.InputConnection;
import android.widget.TextView;

/**
 * Judge-owned test keyboard (AF1 oracle, emulator only). Shows a plain input view whenever the
 * system asks for the soft keyboard and applies commands received by broadcast through the
 * current InputConnection, the same path a phone keyboard such as Gboard uses:
 *
 * <pre>am broadcast -a sh.paseo.judge.ime.COMMAND -p sh.paseo.judge.ime --es id N --es op OP [--es text T]</pre>
 *
 * OP is commit | compose | finish | delete (T = number of characters before the cursor) | enter |
 * before (T = maximum length; logs the text before the cursor as base64, which phone keyboards
 * read for suggestions and autocorrection). Every binding and every command result is logged
 * under the tag PaseoJudgeIme.
 */
public final class JudgeIme extends InputMethodService {
  private static final String TAG = "PaseoJudgeIme";
  private static final String ACTION = "sh.paseo.judge.ime.COMMAND";
  private EditorInfo editor;
  private final BroadcastReceiver receiver =
      new BroadcastReceiver() {
        @Override
        public void onReceive(Context context, Intent intent) {
          apply(intent);
        }
      };

  @Override
  public void onCreate() {
    super.onCreate();
    registerReceiver(receiver, new IntentFilter(ACTION), Context.RECEIVER_EXPORTED);
    Log.i(TAG, "CREATED");
  }

  @Override
  public void onDestroy() {
    unregisterReceiver(receiver);
    super.onDestroy();
  }

  @Override
  public boolean onEvaluateInputViewShown() {
    // The judge emulator has a hardware keyboard; the oracle enables show_ime_with_hard_keyboard,
    // and this view must appear whenever the system shows the soft keyboard.
    super.onEvaluateInputViewShown();
    return true;
  }

  @Override
  public View onCreateInputView() {
    TextView view = new TextView(this);
    view.setText("Judge keyboard");
    view.setTextColor(Color.WHITE);
    view.setBackgroundColor(Color.rgb(32, 32, 32));
    view.setMinHeight((int) (200 * getResources().getDisplayMetrics().density));
    return view;
  }

  @Override
  public void onStartInput(EditorInfo attribute, boolean restarting) {
    super.onStartInput(attribute, restarting);
    editor = attribute;
    Log.i(TAG, "START " + describe(attribute) + " restarting=" + restarting);
  }

  @Override
  public void onStartInputView(EditorInfo attribute, boolean restarting) {
    super.onStartInputView(attribute, restarting);
    Log.i(TAG, "SHOWN " + describe(attribute));
  }

  @Override
  public void onFinishInputView(boolean finishingInput) {
    super.onFinishInputView(finishingInput);
    Log.i(TAG, "HIDDEN finishing=" + finishingInput);
  }

  private static String describe(EditorInfo attribute) {
    if (attribute == null) return "package=none";
    return "package="
        + attribute.packageName
        + " inputType=0x"
        + Integer.toHexString(attribute.inputType)
        + " imeOptions=0x"
        + Integer.toHexString(attribute.imeOptions)
        + " fieldId="
        + attribute.fieldId;
  }

  private void apply(Intent intent) {
    String id = intent.getStringExtra("id");
    String op = intent.getStringExtra("op");
    String text = intent.getStringExtra("text");
    InputConnection connection = getCurrentInputConnection();
    if (connection == null || op == null) {
      Log.i(TAG, "RESULT id=" + id + " op=" + op + " ok=false reason=no-connection");
      return;
    }
    boolean ok;
    String extra = "";
    switch (op) {
      case "commit":
        ok = connection.commitText(text == null ? "" : text, 1);
        break;
      case "compose":
        ok = connection.setComposingText(text == null ? "" : text, 1);
        break;
      case "finish":
        ok = connection.finishComposingText();
        break;
      case "delete":
        ok = connection.deleteSurroundingText(Integer.parseInt(text == null ? "1" : text), 0);
        break;
      case "enter":
        ok =
            connection.sendKeyEvent(new KeyEvent(KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_ENTER))
                && connection.sendKeyEvent(new KeyEvent(KeyEvent.ACTION_UP, KeyEvent.KEYCODE_ENTER));
        break;
      case "before":
        {
          CharSequence before =
              connection.getTextBeforeCursor(Integer.parseInt(text == null ? "100" : text), 0);
          ok = before != null;
          if (ok) {
            extra =
                " before="
                    + Base64.encodeToString(
                        before.toString().getBytes(java.nio.charset.StandardCharsets.UTF_8),
                        Base64.NO_WRAP);
          }
          break;
        }
      default:
        ok = false;
    }
    Log.i(TAG, "RESULT id=" + id + " op=" + op + " ok=" + ok + extra + " " + describe(editor));
  }
}
