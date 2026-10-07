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

/**
 * Attributes each "Application attempted to call on a destroyed WebView" warning by the stack
 * WebView logs with it (the following records of the same time, process, thread and tag). A
 * warning counts as a companion call unless its stack was logged and holds no companion frame
 * (`sh.paseo.`): a stack made only of WebView and platform frames is WebView's own late callback
 * after teardown, not companion code. A warning without a logged stack counts as a companion call.
 */
export function destroyedWebViewCalls(lines) {
  const companion = [];
  const internal = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.includes(DESTROYED_WEBVIEW)) continue;
    const head = THREADTIME.exec(line);
    const frames = [];
    if (head) {
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
        const frame = /^\s*at\s+(\S+)/.exec(record[5]);
        if (frame) frames.push(frame[1]);
      }
    }
    if (frames.length > 0 && !frames.some((frame) => frame.startsWith("sh.paseo.")))
      internal.push(line);
    else companion.push(line);
  }
  return { companion, internal };
}
