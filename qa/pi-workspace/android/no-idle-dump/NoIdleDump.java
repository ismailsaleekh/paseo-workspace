// Judge-owned UI hierarchy dumper for the Android oracle (not product code). `uiautomator dump`
// first waits for one second without accessibility events (up to ten seconds) and writes
// nothing when the UI keeps changing — for example while Paseo's running-turn timer ticks.
// This tool connects the same shell UiAutomation that uiautomator uses and writes the same XML
// immediately, without that idle wait. Usage (CLASSPATH must include uiautomator.jar):
//   app_process /system/bin NoIdleDump <out.xml> <width> <height>
import android.app.UiAutomation;
import android.view.accessibility.AccessibilityNodeInfo;
import java.io.File;
import java.lang.reflect.Method;

public final class NoIdleDump {
  public static void main(String[] args) throws Exception {
    if (args.length != 3) throw new IllegalArgumentException("usage: NoIdleDump <out.xml> <width> <height>");
    File out = new File(args[0]);
    int width = Integer.parseInt(args[1]);
    int height = Integer.parseInt(args[2]);
    Class<?> wrapperClass = Class.forName("com.android.uiautomator.core.UiAutomationShellWrapper");
    Object wrapper = wrapperClass.getConstructor().newInstance();
    wrapperClass.getMethod("connect").invoke(wrapper);
    try {
      wrapperClass.getMethod("setCompressedLayoutHierarchy", boolean.class).invoke(wrapper, false);
      UiAutomation automation = (UiAutomation) wrapperClass.getMethod("getUiAutomation").invoke(wrapper);
      AccessibilityNodeInfo root = null;
      // The accessibility bridge needs a moment after connecting; poll briefly, never for idle.
      for (int attempt = 0; attempt < 20 && root == null; attempt += 1) {
        root = automation.getRootInActiveWindow();
        if (root == null) Thread.sleep(100);
      }
      if (root == null) throw new IllegalStateException("no active window root");
      Class<?> dumper = Class.forName("com.android.uiautomator.core.AccessibilityNodeInfoDumper");
      Method dump = dumper.getMethod(
          "dumpWindowToFile", AccessibilityNodeInfo.class, File.class, int.class, int.class, int.class);
      dump.invoke(null, root, out, 0, width, height);
      System.out.println("UI hierarchy dumped without idle wait to: " + out.getAbsolutePath());
    } finally {
      wrapperClass.getMethod("disconnect").invoke(wrapper);
    }
  }
}
