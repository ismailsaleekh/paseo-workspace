// Marks count complete LF-delimited records, not split()'s trailing empty entry. A partial last
// record is deferred until its newline arrives, so an append cannot disappear behind a mark.
export function completeLogLines(text) {
  const lastNewline = text.lastIndexOf("\n");
  if (lastNewline === -1) return [];
  return text
    .slice(0, lastNewline)
    .split("\n")
    .map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
}

const DESTROYED_WEBVIEW = "attempted to call on a destroyed WebView";
// logcat -v threadtime: "MM-DD HH:MM:SS.mmm  PID  TID L TAG: message"
const THREADTIME =
  /^(\d\d-\d\d \d\d:\d\d:\d\d\.\d{3})\s+(\d+)\s+(\d+)\s+[VDIWEF]\s+([^:]+?)\s*: (.*)$/;

// Require a complete native-dispatched WebView stack, not just the absence of a Paseo frame.
// A partial stack can end before its app caller; an unknown caller is not proven internal either.
const MAIN_LOOP_FRAMES = new Set([
  "android.os.MessageQueue.nativePollOnce",
  "android.os.MessageQueue.nextLegacy",
  "android.os.MessageQueue.next",
  "android.os.Looper.loopOnce",
  "android.os.Looper.loop",
  "android.app.ActivityThread.main",
  "java.lang.reflect.Method.invoke",
  "com.android.internal.os.RuntimeInit$MethodAndArgsCaller.run",
  "com.android.internal.os.ZygoteInit.main",
]);

function isNativeWebViewCallback(frames) {
  const dispatch = frames.indexOf("android.os.MessageQueue.nativePollOnce");
  if (dispatch < 1 || !frames[0].startsWith("org.chromium.android_webview.AwContents."))
    return false;
  const webview = frames.slice(0, dispatch);
  const runtime = frames.slice(dispatch);
  return (
    webview.every((frame) => frame.startsWith("org.chromium.") || frame.startsWith("WV.")) &&
    runtime.every((frame) => MAIN_LOOP_FRAMES.has(frame)) &&
    runtime.includes("android.os.Looper.loop") &&
    runtime.includes("android.app.ActivityThread.main") &&
    runtime.at(-1) === "com.android.internal.os.ZygoteInit.main"
  );
}

/**
 * Keep ambiguous warnings in the failing `companion` bucket. Only a complete, well-formed
 * cr_AwContents trace from WebView through nativePollOnce to Android's main-loop bootstrap is
 * attributed as internal. Unknown, missing, interrupted and truncated stacks still fail R2.
 */
export function destroyedWebViewCalls(lines) {
  const companion = [];
  const internal = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.includes(DESTROYED_WEBVIEW)) continue;
    const head = THREADTIME.exec(line);
    const frames = [];
    let traceStarted = false;
    let malformed = false;
    if (head && head[4] === "cr_AwContents") {
      const [, time, pid, tid, tag] = head;
      for (let next = index + 1; next < lines.length; next += 1) {
        const record = THREADTIME.exec(lines[next]);
        if (
          !record ||
          record[1] !== time ||
          record[2] !== pid ||
          record[3] !== tid ||
          record[4] !== tag
        )
          break;
        if (record[5].includes(DESTROYED_WEBVIEW)) break;
        if (!traceStarted && record[5] !== "java.lang.Throwable") break;
        if (!traceStarted) {
          traceStarted = true;
          continue;
        }
        const frame = /^\s*at\s+([^\s(]+)\([^)]*\)$/.exec(record[5]);
        if (!frame) {
          malformed = true;
          break;
        }
        frames.push(frame[1]);
      }
    }
    if (traceStarted && !malformed && isNativeWebViewCallback(frames)) internal.push(line);
    else companion.push(line);
  }
  return { companion, internal };
}
