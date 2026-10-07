package sh.paseo.visualhost.tests;

import android.app.Instrumentation;
import android.app.Activity;
import android.app.BroadcastOptions;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.ComponentName;
import android.content.BroadcastReceiver;
import android.hardware.display.DisplayManager;
import android.os.IBinder;
import android.os.Build;
import android.os.Bundle;
import android.os.SystemClock;
import android.view.Choreographer;
import android.view.SurfaceControlViewHost;
import android.view.SurfaceView;
import android.view.SurfaceHolder;
import android.view.MotionEvent;
import android.view.InputDevice;
import android.view.View;
import android.view.inputmethod.EditorInfo;
import android.view.inputmethod.InputConnection;
import android.webkit.WebView;
import java.lang.reflect.Proxy;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicLong;
import org.json.JSONObject;
import java.util.UUID;

/** Calls public production receipt/operation APIs in each installed target, never copies a validator. */
public final class KeyboardBoundaryInstrumentation extends Instrumentation {
  private static final String SESSION = "0df373f2-caca-4086-89cd-bf4944907e9a";
  private static final String OTHER = "0df373f2-caca-4086-89cd-bf4944907e9b";
  private static final String READY = "sh.paseo.visualhost.boundaries.WINDOW_READY";
  private static final String ATTACHED = "sh.paseo.visualhost.boundaries.WINDOW_ATTACHED";
  private static final String ATTACH = "sh.paseo.visualhost.boundaries.WINDOW_ATTACH";
  private static final String FINISH = "sh.paseo.visualhost.boundaries.WINDOW_FINISH";
  private String currentCase = "startup";
  private int passed;

  interface Checked { void run() throws Exception; }

  @Override public void onCreate(Bundle arguments) {
    super.onCreate(arguments);
    start();
  }

  @Override public void onStart() {
    Bundle result = new Bundle();
    try {
      if (getTargetContext().getPackageName().equals("sh.paseo.debug.visualhost")) companionCases();
      else if (getTargetContext().getPackageName().equals("sh.paseo.debug")) clientCases();
      else throw new IllegalStateException("Unexpected instrumentation target");
      result.putString("boundary_result", "PASS");
      result.putInt("boundary_cases", passed);
      finish(-1, result);
    } catch (Throwable error) {
      result.putString("boundary_result", "FAIL");
      result.putString("boundary_case", currentCase);
      StringBuilder classes = new StringBuilder();
      Throwable cause = error;
      for (int depth = 0; cause != null && depth < 8; depth++) {
        if (depth > 0) classes.append(" -> ");
        classes.append(cause.getClass().getName());
        if (cause.getCause() == null) {
          StringBuilder frames = new StringBuilder();
          for (StackTraceElement frame : cause.getStackTrace()) {
            if (frame.getClassName().startsWith("sh.paseo.")) frames.append(frame).append("; ");
          }
          result.putString("boundary_stack", frames.toString());
        }
        cause = cause.getCause();
      }
      result.putString("boundary_error", classes.toString());
      finish(0, result);
    }
  }

  private void check(String name, Checked body) throws Exception {
    currentCase = name;
    Bundle status = new Bundle();
    status.putString("boundary_case", name);
    status.putString("boundary_phase", "begin");
    sendStatus(1, status);
    body.run();
    passed++;
  }

  private void main(Checked body) throws Exception {
    AtomicReference<Throwable> failure = new AtomicReference<>();
    runOnMainSync(() -> {
      try { body.run(); } catch (Throwable error) { failure.set(error); }
    });
    if (failure.get() != null) throw new Exception("Native consumer failed", failure.get());
  }

  private static void require(boolean value) {
    if (!value) throw new AssertionError("Boundary behavior differed");
  }

  private Class<?> targetClass(String name) throws Exception {
    return Class.forName(name, true, getTargetContext().getClassLoader());
  }

  private static Object invoke(Object target, String name, Class<?>[] types, Object... values) throws Exception {
    return target.getClass().getMethod(name, types).invoke(target, values);
  }

  private static Bundle report(String text, int start, int end, long generation, long sequence) {
    Bundle result = new Bundle();
    result.putString("session", SESSION);
    result.putBoolean("focused", true);
    result.putLong("generation", generation);
    result.putLong("sequence", sequence);
    result.putString("text", text);
    result.putString("inputKind", "text");
    result.putInt("selectionStart", start);
    result.putInt("selectionEnd", end);
    return result;
  }

  private final class Client {
    final Object editor;
    int sends;
    int endings;
    Client() throws Exception {
      Class<?> port = targetClass("sh.paseo.visualhostclient.EditorTransport");
      Object transport = Proxy.newProxyInstance(port.getClassLoader(), new Class<?>[]{port}, (proxy, method, args) -> {
        if (method.getName().equals("send")) { sends++; return true; }
        if (method.getName().equals("ended")) { endings++; return null; }
        if (method.getName().equals("toString")) return "Boundary transport";
        throw new IllegalStateException("Unexpected transport method");
      });
      editor = targetClass("sh.paseo.visualhostclient.VisualEditor")
        .getConstructor(View.class, port).newInstance(new View(getTargetContext()), transport);
      invoke(editor, "bind", new Class<?>[]{String.class}, SESSION);
    }
    boolean receive(Bundle value) throws Exception {
      return (Boolean) invoke(editor, "receive", new Class<?>[]{Bundle.class}, value);
    }
    boolean active() throws Exception { return (Boolean) invoke(editor, "getActive", new Class<?>[]{}); }
    InputConnection connection() throws Exception {
      return (InputConnection) invoke(editor, "connection", new Class<?>[]{EditorInfo.class}, new EditorInfo());
    }
    void stop() throws Exception { invoke(editor, "stop", new Class<?>[]{boolean.class}, true); }
  }

  private void clientCases() throws Exception {
    check("client-empty-and-64KiB", () -> main(() -> {
      Client client = new Client();
      require(client.receive(report("", 0, 0, 1, 0)));
      require("".contentEquals(client.connection().getTextBeforeCursor(100, 0)));
      String atLimit = "a".repeat(65536);
      require(client.receive(report(atLimit, atLimit.length(), atLimit.length(), 1, 0)));
      require(client.connection().getTextBeforeCursor(65536, 0).length() == 65536);
      String multibyte = "\u00e9".repeat(32768);
      require(multibyte.getBytes(StandardCharsets.UTF_8).length == 65536);
      require(client.receive(report(multibyte, multibyte.length(), multibyte.length(), 1, 0)));
      require(multibyte.contentEquals(client.connection().getTextBeforeCursor(65536, 0)));
      client.stop();
    }));
    check("client-oversized-ASCII-and-multibyte", () -> main(() -> {
      for (String text : new String[]{"a".repeat(65537), "\u00e9".repeat(32769), "\ud800"}) {
        Client client = new Client();
        require(client.receive(report("", 0, 0, 1, 0)));
        InputConnection old = client.connection();
        require(!client.receive(report(text, 0, 0, 1, 0)));
        require(!client.active() && client.endings == 1);
        require(old.getTextBeforeCursor(10, 0) == null && !old.commitText("x", 1));
      }
    }));
    check("client-malformed-reports-end-session", () -> main(() -> {
      for (int which = 0; which < 8; which++) {
        Client client = new Client();
        require(client.receive(report("abc", 3, 3, 1, 0)));
        Bundle bad = report("abc", 3, 3, 1, 0);
        switch (which) {
          case 0: bad.remove("text"); break;
          case 1: bad.putInt("text", 3); break;
          case 2: bad.putInt("selectionStart", -1); break;
          case 3: bad.putInt("selectionEnd", 4); break;
          case 4: bad.putDouble("selectionStart", 1.5); break;
          case 5: bad.putString("inputKind", "unsupported"); break;
          case 6: bad.putString("focused", "true"); break;
          case 7: bad.putLong("sequence", 10); break;
        }
        require(!client.receive(bad) && !client.active() && client.endings == 1);
      }
    }));
    check("client-commit-compose-delete-and-cursor", () -> main(() -> {
      Client client = new Client();
      require(client.receive(report("", 0, 0, 1, 0)));
      InputConnection connection = client.connection();
      require(connection.commitText("Hello", 1));
      require(connection.setComposingText(" wor", 1));
      require(connection.finishComposingText());
      require(connection.deleteSurroundingText(1, 0));
      require(connection.commitText("rld", 1));
      require("Hello world".contentEquals(connection.getTextBeforeCursor(100, 0)));
      require(connection.setSelection(5, 5));
      require("Hello".contentEquals(connection.getTextBeforeCursor(100, 0)));
      require(" world".contentEquals(connection.getTextAfterCursor(100, 0)));
      require(client.receive(report("stale", 5, 5, 1, 0)));
      require("Hello".contentEquals(connection.getTextBeforeCursor(100, 0)));
      client.stop();
    }));
    check("client-input-restart-retires-connection-not-field", () -> main(() -> {
      Client client = new Client();
      require(client.receive(report("abc", 3, 3, 1, 0)));
      InputConnection previous = client.connection();
      InputConnection replacement = client.connection();
      previous.closeConnection();
      require(client.active() && client.endings == 0 && client.sends == 0);
      require(!previous.commitText("late", 1) && previous.getTextBeforeCursor(100, 0) == null);
      require(replacement.commitText("d", 1));
      require("abcd".contentEquals(replacement.getTextBeforeCursor(100, 0)));
      replacement.closeConnection();
      require(!replacement.commitText("late", 1) && client.active());
      client.stop();
      require(!client.active() && client.endings == 1);
    }));
    check("client-stale-mount-and-focus-generation", () -> main(() -> {
      Client client = new Client();
      require(client.receive(report("first", 5, 5, 1, 0)));
      InputConnection previous = client.connection();
      Bundle foreign = report("foreign", 7, 7, 2, 0); foreign.putString("session", OTHER);
      require(!client.receive(foreign) && client.active());
      require(client.receive(report("next", 4, 4, 2, 0)));
      int sent = client.sends;
      require(!previous.commitText("old", 1) && previous.getTextBeforeCursor(10, 0) == null);
      require(!client.receive(report("first", 5, 5, 1, 0)) && client.sends == sent);
      require("next".contentEquals(client.connection().getTextBeforeCursor(10, 0)));
      client.stop();
    }));
    check("client-blur-composer-handoff-and-close", () -> main(() -> {
      for (int which = 0; which < 3; which++) {
        Client client = new Client();
        require(client.receive(report("draft", 5, 5, 1, 0)));
        InputConnection old = client.connection();
        if (which == 0) {
          Bundle blur = report("", 0, 0, 1, 0); blur.putBoolean("focused", false);
          require(!client.receive(blur));
        } else if (which == 1) client.stop();
        else invoke(client.editor, "bind", new Class<?>[]{String.class}, new Object[]{null});
        int sent = client.sends;
        require(!old.commitText("late", 1) && old.getTextBeforeCursor(100, 0) == null);
        require(!client.receive(report("draft", 5, 5, 1, 0)) && client.sends == sent);
      }
    }));
    check("client-invalid-operations-never-forward", () -> main(() -> {
      for (int which = 0; which < 3; which++) {
        Client client = new Client();
        require(client.receive(report("", 0, 0, 1, 0)));
        InputConnection connection = client.connection();
        boolean applied = which == 0 ? connection.commitText("a".repeat(65537), 1) :
          which == 1 ? connection.setSelection(-1, 0) : connection.deleteSurroundingText(-1, 0);
        require(!applied && !client.active() && client.sends == 1 && client.endings == 1);
      }
    }));
  }

  private static void sendWindow(Context context, String peer, String action, String nonce, Bundle payload) {
    Intent intent = new Intent(action).setPackage(peer).addFlags(Intent.FLAG_RECEIVER_FOREGROUND);
    intent.putExtra("window_nonce", nonce).putExtras(payload);
    if (Build.VERSION.SDK_INT >= 34) {
      BroadcastOptions options = BroadcastOptions.makeBasic().setShareIdentityEnabled(true);
      context.sendBroadcast(intent, null, options.toBundle());
    } else context.sendBroadcast(intent);
  }

  /** Test-APK window only. It hosts the real surface rather than pretending a Binder is a window. */
  public static final class HostActivity extends Activity implements SurfaceHolder.Callback {
    private SurfaceView view;
    private SurfaceControlViewHost.SurfacePackage attached;
    private String nonce;
    private String peer;
    private int peerUid;
    private boolean readySent;
    private boolean receiverRegistered;
    private final BroadcastReceiver commands = new BroadcastReceiver() {
      @Override public void onReceive(Context context, Intent intent) {
        if (!nonce.equals(intent.getStringExtra("window_nonce"))) return;
        if (Build.VERSION.SDK_INT >= 34 && getSentFromUid() != peerUid) throw new SecurityException("Unexpected window peer");
        if (FINISH.equals(intent.getAction())) { finish(); return; }
        SurfaceControlViewHost.SurfacePackage received = Build.VERSION.SDK_INT >= 33 ?
          intent.getParcelableExtra("surface", SurfaceControlViewHost.SurfacePackage.class) : intent.getParcelableExtra("surface");
        if (received == null) throw new IllegalStateException("No fixture surface package");
        if (attached != null) attached.release();
        attached = received;
        view.setChildSurfacePackage(received);
        sendWindow(HostActivity.this, peer, ATTACHED, nonce, new Bundle());
      }
    };

    @Override public void onCreate(Bundle state) {
      super.onCreate(state);
      nonce = getIntent().getStringExtra("window_nonce");
      peer = getIntent().getStringExtra("reply_package");
      if (nonce == null || peer == null || getPackageManager().checkSignatures(getPackageName(), peer) != 0) {
        throw new SecurityException("Invalid fixture window launch");
      }
      try { peerUid = getPackageManager().getApplicationInfo(peer, 0).uid; }
      catch (android.content.pm.PackageManager.NameNotFoundException error) { throw new IllegalStateException("Missing window peer", error); }
      IntentFilter filter = new IntentFilter(); filter.addAction(ATTACH); filter.addAction(FINISH);
      if (Build.VERSION.SDK_INT >= 33) registerReceiver(commands, filter, Context.RECEIVER_EXPORTED);
      else registerReceiver(commands, filter);
      receiverRegistered = true;
      view = new SurfaceView(this);
      view.setFocusable(false);
      view.getHolder().addCallback(this);
      setContentView(view);
    }

    private void ready() {
      if (readySent || view.getHostToken() == null || view.getDisplay() == null) return;
      readySent = true;
      Bundle data = new Bundle();
      data.putBinder("host_token", view.getHostToken());
      data.putInt("display_id", view.getDisplay().getDisplayId());
      sendWindow(this, peer, READY, nonce, data);
    }
    @Override public void surfaceCreated(SurfaceHolder holder) { ready(); }
    @Override public void surfaceChanged(SurfaceHolder holder, int format, int width, int height) { ready(); }
    @Override public void surfaceDestroyed(SurfaceHolder holder) { }
    @Override public void onDestroy() {
      if (receiverRegistered) unregisterReceiver(commands);
      if (attached != null) { view.clearChildSurfacePackage(); attached.release(); attached = null; }
      super.onDestroy();
    }
  }

  private final class Companion implements AutoCloseable {
    Object bridge;
    WebView web;
    SurfaceControlViewHost surface;
    final AtomicReference<Bundle> latest = new AtomicReference<>();
    final AtomicBoolean rejected = new AtomicBoolean();
    final AtomicBoolean loaded = new AtomicBoolean();
    final AtomicReference<Bundle> window = new AtomicReference<>();
    final AtomicBoolean surfaceAttached = new AtomicBoolean();
    final String windowNonce = UUID.randomUUID().toString();
    final String hostPackage = getContext().getPackageName();
    BroadcastReceiver windowEvents;
    boolean receiverRegistered;
    // Content-free phase timing (uptime ms since construction), for diagnostics only.
    final long started = SystemClock.uptimeMillis();
    final AtomicLong activityAt = new AtomicLong(-1), viewAt = new AtomicLong(-1), attachedAt = new AtomicLong(-1);
    final AtomicLong loadedAt = new AtomicLong(-1), laidOutAt = new AtomicLong(-1), paintedAt = new AtomicLong(-1), tapAt = new AtomicLong(-1);
    final AtomicLong receiptAt = new AtomicLong(-1), focusedAt = new AtomicLong(-1);
    void mark(AtomicLong phase) { phase.compareAndSet(-1, SystemClock.uptimeMillis() - started); }
    String phases() {
      return "activity=" + activityAt.get() + ";view=" + viewAt.get() + ";attached=" + attachedAt.get()
        + ";loaded=" + loadedAt.get() + ";laidOut=" + laidOutAt.get() + ";painted=" + paintedAt.get() + ";tap=" + tapAt.get()
        + ";receipt=" + receiptAt.get() + ";focused=" + focusedAt.get();
    }
    Companion() throws Exception {
      long deadline = started + 10000;
      try {
      int hostUid = getTargetContext().getPackageManager().getApplicationInfo(hostPackage, 0).uid;
      main(() -> {
        windowEvents = new BroadcastReceiver() {
          @Override public void onReceive(Context context, Intent intent) {
            if (!windowNonce.equals(intent.getStringExtra("window_nonce"))) return;
            if (Build.VERSION.SDK_INT >= 34 && getSentFromUid() != hostUid) throw new SecurityException("Unexpected fixture host");
            if (READY.equals(intent.getAction())) { mark(activityAt); window.set(intent.getExtras()); }
            if (ATTACHED.equals(intent.getAction())) { mark(attachedAt); surfaceAttached.set(true); }
          }
        };
        IntentFilter filter = new IntentFilter(); filter.addAction(READY); filter.addAction(ATTACHED);
        if (Build.VERSION.SDK_INT >= 33) getTargetContext().registerReceiver(windowEvents, filter, Context.RECEIVER_EXPORTED);
        else getTargetContext().registerReceiver(windowEvents, filter);
        receiverRegistered = true;
        // MULTIPLE_TASK: the previous case's activity may still be finishing; NEW_TASK alone would
        // bring that task to front and drop this launch (measured: READY never arrived in 10 s).
        Intent intent = new Intent().setComponent(new ComponentName(hostPackage, HostActivity.class.getName()))
          .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_MULTIPLE_TASK).putExtra("window_nonce", windowNonce)
          .putExtra("reply_package", getTargetContext().getPackageName());
        getTargetContext().startActivity(intent);
      });
      while (window.get() == null && SystemClock.uptimeMillis() < deadline) Thread.sleep(20);
      require(window.get() != null);
      main(() -> {
        Context context = getTargetContext();
        Class<?> webClass = targetClass("sh.paseo.visualhost.VisualKeyboardWebView");
        web = (WebView) webClass.getConstructor(Context.class).newInstance(context);
        DisplayManager displays = context.getSystemService(DisplayManager.class);
        Bundle hosting = window.get();
        IBinder token = hosting.getBinder("host_token");
        require(token != null);
        surface = new SurfaceControlViewHost(context, displays.getDisplay(hosting.getInt("display_id")), token);
        surface.setView(web, 720, 480);
        web.requestFocus();
        Class<?> events = targetClass("sh.paseo.visualhost.DocumentEvents");
        Object eventSink = Proxy.newProxyInstance(events.getClassLoader(), new Class<?>[]{events}, (proxy, method, args) -> {
          if (method.getName().equals("onPageReady")) { mark(loadedAt); loaded.set(true); }
          return null;
        });
        Class<?> policy = targetClass("sh.paseo.visualhost.VisualDocumentPolicy");
        String html = "<!doctype html><html><head><meta name='viewport' content='width=device-width,initial-scale=1'><style>html,body{margin:0}input{box-sizing:border-box;width:100%;height:200px;font-size:24px}</style></head><body><input id='field'></body></html>";
        policy.getMethod("install", WebView.class, byte[].class, events)
          .invoke(policy.getField("INSTANCE").get(null), web, html.getBytes(StandardCharsets.UTF_8), eventSink);
        Class<?> port = targetClass("sh.paseo.visualhost.KeyboardTransport");
        Object transport = Proxy.newProxyInstance(port.getClassLoader(), new Class<?>[]{port}, (proxy, method, args) -> {
          if (method.getName().equals("rejected")) { rejected.set(true); return null; }
          if (!method.getName().equals("send")) throw new IllegalStateException("Unexpected keyboard transport method");
          Bundle sent = new Bundle((Bundle) args[0]);
          mark(receiptAt);
          if (sent.getBoolean("focused")) mark(focusedAt);
          latest.set(sent); return null;
        });
        Class<?> clockClass = targetClass("sh.paseo.visualhost.MessageClock");
        Object clock = Proxy.newProxyInstance(clockClass.getClassLoader(), new Class<?>[]{clockClass}, (proxy, method, args) -> {
          if (!method.getName().equals("now")) throw new IllegalStateException("Unexpected clock method");
          return 1000L;
        });
        Class<?> budgetClass = targetClass("sh.paseo.visualhost.VisualMessageBudget");
        Object budget = budgetClass.getConstructor(clockClass).newInstance(clock);
        Class<?> watchdogClass = targetClass("sh.paseo.visualhost.MainThreadWatchdog");
        Object watchdog = watchdogClass.getConstructor().newInstance();
        bridge = targetClass("sh.paseo.visualhost.VisualKeyboardBridge")
          .getConstructor(webClass, String.class, port, budgetClass, watchdogClass).newInstance(web, SESSION, transport, budget, watchdog);
        invoke(bridge, "install", new Class<?>[]{});
        SurfaceControlViewHost.SurfacePackage exported = surface.getSurfacePackage();
        require(exported != null);
        Bundle data = new Bundle(); data.putParcelable("surface", exported);
        try { sendWindow(context, hostPackage, ATTACH, windowNonce, data); }
        finally { exported.release(); }
        mark(viewAt);
      });
      while (!surfaceAttached.get() && SystemClock.uptimeMillis() < deadline) Thread.sleep(20);
      require(surfaceAttached.get());
      main(() -> web.loadUrl("https://visual.invalid/"));
      AtomicBoolean laidOut = new AtomicBoolean();
      while (SystemClock.uptimeMillis() < deadline) {
        main(() -> laidOut.set(web.isLaidOut() && web.getWidth() > 40 && web.getHeight() > 40));
        if (laidOut.get()) mark(laidOutAt);
        if (loaded.get() && laidOut.get()) break;
        Thread.sleep(20);
      }
      require(loaded.get() && laidOut.get());
      // Chromium drops input that arrives before a navigation's first paint (measured: a tap 31 ms
      // after onPageReady never focused the field). Tap only after the loaded DOM is ready to draw
      // and one more frame has been produced, like a user tapping a displayed visual.
      AtomicBoolean painted = new AtomicBoolean();
      main(() -> web.postVisualStateCallback(1L, new WebView.VisualStateCallback() {
        @Override public void onComplete(long requestId) {
          Choreographer.getInstance().postFrameCallback(frame -> { mark(paintedAt); painted.set(true); });
        }
      }));
      while (!painted.get() && SystemClock.uptimeMillis() < deadline) Thread.sleep(20);
      require(painted.get());
      main(() -> {
        require(web.requestFocus());
        long now = SystemClock.uptimeMillis();
        MotionEvent down = MotionEvent.obtain(now, now, MotionEvent.ACTION_DOWN, 40f, 40f, 0);
        MotionEvent up = MotionEvent.obtain(now, SystemClock.uptimeMillis(), MotionEvent.ACTION_UP, 40f, 40f, 0);
        down.setSource(InputDevice.SOURCE_TOUCHSCREEN);
        up.setSource(InputDevice.SOURCE_TOUCHSCREEN);
        try {
          require(web.dispatchTouchEvent(down));
          require(web.dispatchTouchEvent(up));
        } finally { down.recycle(); up.recycle(); }
        mark(tapAt);
      });
      waitFocusedUntil(deadline);
      Bundle timing = new Bundle(); timing.putString("native_phase_ms", phases()); sendStatus(1, timing);
      } catch (Exception | Error failure) {
        try { close(); } catch (Exception cleanup) { failure.addSuppressed(cleanup); }
        throw failure;
      }
    }
    Bundle waitFocused() throws Exception {
      return waitFocusedUntil(SystemClock.uptimeMillis() + 10000);
    }
    Bundle waitFocusedUntil(long deadline) throws Exception {
      while (SystemClock.uptimeMillis() < deadline) {
        Bundle state = latest.get();
        if (state != null && state.getBoolean("focused")) return state;
        Thread.sleep(20);
      }
      // Measurement only: record when (if at all) a late focused receipt arrives. The case still fails.
      long measure = SystemClock.uptimeMillis() + 10000;
      while (focusedAt.get() < 0 && SystemClock.uptimeMillis() < measure) Thread.sleep(20);
      CountDownLatch diagnostic = new CountDownLatch(1);
      main(() -> {
        Bundle status = new Bundle();
        status.putString("native_phase_ms", phases());
        Bundle state = latest.get();
        status.putBoolean("native_receipt_present", state != null);
        status.putBoolean("native_receipt_focused", state != null && state.getBoolean("focused"));
        status.putBoolean("native_rejected", rejected.get());
        status.putBoolean("native_view_focused", web.hasFocus());
        status.putBoolean("native_window_focused", web.hasWindowFocus());
        status.putBoolean("native_view_laid_out", web.isLaidOut());
        status.putBoolean("native_surface_attached", surfaceAttached.get());
        sendStatus(1, status);
        web.evaluateJavascript("JSON.stringify({complete:document.readyState==='complete',inputActive:document.activeElement===document.getElementById('field'),portPresent:typeof window.paseoVisualEditor==='object',viewport:window.innerWidth>0&&window.innerHeight>0})", value -> {
          Bundle dom = new Bundle(); dom.putString("native_dom_booleans", value); sendStatus(1, dom);
          diagnostic.countDown();
        });
      });
      diagnostic.await(1, TimeUnit.SECONDS);
      throw new AssertionError("Real focused WebView never supplied its connection");
    }
    String snapshot(String text, long start, long end) throws Exception {
      Bundle state = waitFocused();
      return new JSONObject().put("focused", true).put("generation", state.getLong("generation"))
        .put("sequence", state.getLong("sequence")).put("text", text).put("selectionStart", start)
        .put("selectionEnd", end).put("inputKind", "text").toString();
    }
    void report(String json) throws Exception { main(() -> invoke(bridge, "report", new Class<?>[]{String.class}, json)); }
    boolean input(Bundle data) throws Exception {
      AtomicReference<Boolean> applied = new AtomicReference<>();
      main(() -> applied.set((Boolean) invoke(bridge, "input", new Class<?>[]{Bundle.class}, data)));
      return applied.get();
    }
    Bundle command(String op) throws Exception {
      Bundle state = waitFocused();
      Bundle command = new Bundle();
      command.putString("session", SESSION); command.putLong("generation", state.getLong("generation"));
      command.putLong("sequence", state.getLong("sequence") + 1); command.putString("operation", op);
      command.putInt("first", 0); command.putInt("second", 0);
      return command;
    }
    void edit(String operation, String text, int first, int second, String expected) throws Exception {
      Bundle command = command(operation);
      if (text != null) command.putString("text", text);
      command.putInt("first", first); command.putInt("second", second);
      long ordinal = command.getLong("sequence");
      require(input(command));
      long deadline = SystemClock.uptimeMillis() + 10000;
      while (SystemClock.uptimeMillis() < deadline) {
        Bundle state = latest.get();
        if (state != null && state.getBoolean("focused") && state.getLong("sequence") == ordinal) {
          require(expected.equals(state.getString("text")));
          return;
        }
        Thread.sleep(20);
      }
      throw new AssertionError("Native input never reached its focused-field receipt");
    }
    @Override public void close() throws Exception {
      main(() -> {
        if (bridge != null) invoke(bridge, "close", new Class<?>[]{});
        if (surface != null) surface.release();
        if (web != null) web.destroy();
        sendWindow(getTargetContext(), hostPackage, FINISH, windowNonce, new Bundle());
        if (receiverRegistered) {
          getTargetContext().unregisterReceiver(windowEvents);
          receiverRegistered = false;
        }
      });
    }
  }

  private void companionCases() throws Exception {
    // Like the product's WARM: start the WebView provider once before the timed cases. The first
    // case otherwise pays the cold provider start inside its 10 s setup (measured 2-4 s, once >10 s).
    main(() -> new WebView(getTargetContext()).destroy());
    check("companion-empty-and-64KiB", () -> {
      try (Companion companion = new Companion()) {
        companion.report(companion.snapshot("", 0, 0));
        require(companion.latest.get().getBoolean("focused"));
        for (String text : new String[]{"a".repeat(65536), "\u00e9".repeat(32768)}) {
          companion.report(companion.snapshot(text, text.length(), text.length()));
          require(companion.latest.get().getString("text").equals(text));
        }
      }
    });
    check("companion-oversized-ASCII-and-multibyte", () -> {
      for (String text : new String[]{"a".repeat(65537), "\u00e9".repeat(32769), "\ud800"}) {
        try (Companion companion = new Companion()) {
          companion.report(companion.snapshot(text, 0, 0));
          require(!companion.latest.get().getBoolean("focused") && !companion.latest.get().containsKey("text"));
        }
      }
    });
    check("companion-malformed-fields-and-selection", () -> {
      for (int which = 0; which < 5; which++) {
        try (Companion companion = new Companion()) {
          JSONObject malformed = new JSONObject(companion.snapshot("abc", 3, 3));
          switch (which) {
            case 0: malformed.remove("text"); break;
            case 1: malformed.put("selectionStart", -1); break;
            case 2: malformed.put("selectionEnd", 4); break;
            case 3: malformed.put("selectionStart", 0.5); break;
            case 4: malformed.put("selectionStart", Long.MIN_VALUE); break;
          }
          companion.report(malformed.toString());
          require(!companion.latest.get().getBoolean("focused"));
        }
      }
    });
    check("companion-real-input-connection-edits-focused-field", () -> {
      try (Companion companion = new Companion()) {
        companion.edit("commit", "Native a", 1, 0, "Native a");
        companion.edit("compose", "bx", 1, 0, "Native abx");
        companion.edit("finish", null, 0, 0, "Native abx");
        companion.edit("delete", null, 1, 0, "Native ab");
        companion.edit("commit", "c", 1, 0, "Native abc");
      }
    });
    check("companion-back-to-back-input-then-blur-applies-all", () -> {
      try (Companion companion = new Companion()) {
        Bundle state = companion.waitFocused();
        long generation = state.getLong("generation");
        long next = state.getLong("sequence");
        String[][] ops = {{"commit", "ab"}, {"compose", "cd"}, {"finish", null}, {"commit", "e"}, {"blur", null}};
        Bundle[] burst = new Bundle[ops.length];
        for (int index = 0; index < ops.length; index++) {
          Bundle command = new Bundle();
          command.putString("session", SESSION); command.putLong("generation", generation);
          command.putLong("sequence", ++next); command.putString("operation", ops[index][0]);
          if (ops[index][1] != null) command.putString("text", ops[index][1]);
          command.putInt("first", ops[index][1] != null ? 1 : 0); command.putInt("second", 0);
          burst[index] = command;
        }
        AtomicBoolean accepted = new AtomicBoolean(true);
        // Back to back in one UI-thread turn, then the client's blur: nothing may wait in between.
        main(() -> {
          for (Bundle command : burst) {
            if (!(Boolean) invoke(companion.bridge, "input", new Class<?>[]{Bundle.class}, command)) accepted.set(false);
          }
        });
        require(accepted.get());
        long deadline = SystemClock.uptimeMillis() + 10000;
        while (companion.latest.get().getBoolean("focused") && SystemClock.uptimeMillis() < deadline) Thread.sleep(20);
        require(!companion.latest.get().getBoolean("focused"));
        AtomicReference<String> value = new AtomicReference<>();
        CountDownLatch read = new CountDownLatch(1);
        main(() -> companion.web.evaluateJavascript("document.getElementById('field').value", result -> {
          value.set(result); read.countDown();
        }));
        require(read.await(5, TimeUnit.SECONDS) && "\"abcde\"".equals(value.get()));
      }
    });
    check("companion-stale-session-focus-and-close", () -> {
      try (Companion companion = new Companion()) {
        Bundle state = companion.waitFocused();
        Bundle stale = companion.command("commit"); stale.putString("text", "late"); stale.putInt("first", 1);
        stale.putString("session", OTHER); require(!companion.input(stale));
        stale.putString("session", SESSION); stale.putLong("generation", state.getLong("generation") + 1);
        require(!companion.input(stale));
        Bundle blur = companion.command("blur"); require(companion.input(blur));
        stale.putLong("generation", state.getLong("generation")); require(!companion.input(stale));
        require(!companion.latest.get().getBoolean("focused"));
        main(() -> invoke(companion.bridge, "close", new Class<?>[]{}));
        require(!companion.input(stale));
      }
    });
    check("companion-message-excess-retires-production-consumer", () -> {
      try (Companion companion = new Companion()) {
        String snapshot = companion.snapshot("", 0, 0);
        Bundle command = companion.command("commit"); command.putString("text", "late"); command.putInt("first", 1);
        main(() -> {
          for (int index = 0; index < 120; index++) invoke(companion.bridge, "report", new Class<?>[]{String.class}, snapshot);
        });
        require(companion.rejected.get() && !companion.latest.get().getBoolean("focused"));
        require(!companion.input(command));
        JSONObject later = new JSONObject(snapshot); later.put("generation", later.getLong("generation") + 1);
        companion.report(later.toString());
        require(!companion.latest.get().getBoolean("focused"));
      }
    });
    check("companion-invalid-operation-ends-focus", () -> {
      for (int which = 0; which < 3; which++) {
        try (Companion companion = new Companion()) {
          Bundle invalid = companion.command("commit"); invalid.putInt("first", 1);
          if (which == 0) invalid.putString("text", "a".repeat(65537));
          if (which == 1) { invalid.putString("operation", "delete"); invalid.putInt("first", -1); }
          if (which == 2) invalid.putString("operation", "unknown");
          require(!companion.input(invalid) && !companion.latest.get().getBoolean("focused"));
        }
      }
    });
  }
}
