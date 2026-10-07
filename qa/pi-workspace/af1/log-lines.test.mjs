import assert from "node:assert/strict";
import { test } from "node:test";
import { completeLogLines, destroyedWebViewCalls } from "./log-lines.mjs";

test("a mark at a newline boundary preserves the first appended record", () => {
  const prefix = "old record\n";
  const mark = completeLogLines(prefix).length;
  assert.equal(mark, 1);
  assert.deepEqual(completeLogLines(prefix + "debug block main: 7000 ms\n").slice(mark), [
    "debug block main: 7000 ms",
  ]);
});

test("an initially empty log retains its first record", () => {
  const mark = completeLogLines("").length;
  assert.equal(mark, 0);
  assert.deepEqual(completeLogLines("first\n").slice(mark), ["first"]);
});

test("an incomplete record is deferred rather than counted before it can match", () => {
  const prefix = "old record\npartial";
  const mark = completeLogLines(prefix).length;
  assert.deepEqual(completeLogLines(prefix), ["old record"]);
  assert.deepEqual(completeLogLines(prefix + " record\nnext part").slice(mark), ["partial record"]);
  assert.deepEqual(completeLogLines("no newline yet"), []);
});

test("complete blank lines and CRLF boundaries preserve stable record counts", () => {
  const prefix = "old\r\n\n";
  assert.deepEqual(completeLogLines(prefix), ["old", ""]);
  const mark = completeLogLines(prefix).length;
  assert.deepEqual(completeLogLines(prefix + "new\r\n").slice(mark), ["new"]);
});

// Recorded on the judge emulator (VS2 submit, 2026-10-07): WebView's own loadingStateChanged
// callback reached a WebView the companion had destroyed after its renderer was gone.
const internalWarning = [
  "10-07 13:11:15.718  5238  5238 E chromium: [ERROR:aw_browser_terminator.cc(165)] Renderer process (5284) crash detected (code -1).",
  "10-07 13:11:16.481  5238  5238 W cr_AwContents: Application attempted to call on a destroyed WebView",
  "10-07 13:11:16.481  5238  5238 W cr_AwContents: java.lang.Throwable",
  "10-07 13:11:16.481  5238  5238 W cr_AwContents: \tat org.chromium.android_webview.AwContents.p(chromium-TrichromeWebViewGoogle6432.aab-stable-694313732:10)",
  "10-07 13:11:16.481  5238  5238 W cr_AwContents: \tat WV.F9.loadingStateChanged(chromium-TrichromeWebViewGoogle6432.aab-stable-694313732:4)",
  "10-07 13:11:16.481  5238  5238 W cr_AwContents: \tat android.os.MessageQueue.nativePollOnce(Native Method)",
  "10-07 13:11:16.481  5238  5238 W cr_AwContents: \tat android.os.Looper.loop(Looper.java:338)",
  "10-07 13:11:16.481  5238  5238 W cr_AwContents: \tat android.app.ActivityThread.main(ActivityThread.java:9067)",
  "10-07 13:11:16.481  5238  5238 W cr_AwContents: \tat com.android.internal.os.ZygoteInit.main(ZygoteInit.java:932)",
  "10-07 13:11:16.503  5238  5238 E chromium: [ERROR:aw_browser_terminator.cc(165)] Renderer process (7378) crash detected (code -1).",
];

test("a destroyed-WebView warning whose logged stack has only WebView and platform frames is WebView-internal", () => {
  const { companion, internal } = destroyedWebViewCalls(internalWarning);
  assert.deepEqual(companion, []);
  assert.deepEqual(internal, [internalWarning[1]]);
});

test("a companion frame anywhere in the logged stack makes the warning a companion call", () => {
  const lines = internalWarning.toSpliced(
    5,
    0,
    "10-07 13:11:16.481  5238  5238 W cr_AwContents: \tat sh.paseo.visualhost.VisualDocumentSession.evaluate(VisualDocumentSession.kt:305)",
  );
  const { companion, internal } = destroyedWebViewCalls(lines);
  assert.deepEqual(companion, [internalWarning[1]]);
  assert.deepEqual(internal, []);
});

test("a warning without a logged stack counts as a companion call", () => {
  const { companion, internal } = destroyedWebViewCalls([
    internalWarning[0],
    internalWarning[1],
    internalWarning[9],
  ]);
  assert.deepEqual(companion, [internalWarning[1]]);
  assert.deepEqual(internal, []);
});

test("stack records of another thread, time or tag are not attributed to the warning", () => {
  const otherThread = internalWarning.map((line, index) =>
    index > 1 && index < 9 ? line.replace("5238  5238 W", "5238  5262 W") : line,
  );
  assert.deepEqual(destroyedWebViewCalls(otherThread).companion, [internalWarning[1]]);
  const otherTime = internalWarning.map((line, index) =>
    index > 1 && index < 9 ? line.replace("13:11:16.481", "13:11:16.482") : line,
  );
  assert.deepEqual(destroyedWebViewCalls(otherTime).companion, [internalWarning[1]]);
  const otherTag = internalWarning.map((line, index) =>
    index > 1 && index < 9 ? line.replace("cr_AwContents:", "PaseoVisualHost:") : line,
  );
  assert.deepEqual(destroyedWebViewCalls(otherTag).companion, [internalWarning[1]]);
});

test("back-to-back warnings are attributed separately", () => {
  const companionCall = [
    "10-07 13:11:17.000  5238  5238 W cr_AwContents: Application attempted to call on a destroyed WebView",
    "10-07 13:11:17.000  5238  5238 W cr_AwContents: java.lang.Throwable",
    "10-07 13:11:17.000  5238  5238 W cr_AwContents: \tat org.chromium.android_webview.AwContents.evaluateJavaScript(chromium:1)",
    "10-07 13:11:17.000  5238  5238 W cr_AwContents: \tat sh.paseo.visualhost.VisualDocumentSession.post(VisualDocumentSession.kt:140)",
  ];
  const { companion, internal } = destroyedWebViewCalls([...internalWarning, ...companionCall]);
  assert.deepEqual(internal, [internalWarning[1]]);
  assert.deepEqual(companion, [companionCall[0]]);
});
