#!/usr/bin/env node
// Judge-owned AF1 Android flow: keyboard input into visuals, prompt DOCUMENT_UNRESPONSIVE with a
// slow renderer termination, recovery and companion log hygiene, on a fresh judge emulator with
// the real Paseo Android app, the real companion visual host and a real Pi agent. The judge
// keyboard (sh.paseo.judge.ime) drives the standard InputConnection like a phone keyboard.
// --prerequisite checks only that the harness reaches a displayed visual with editable fields
// (must pass on the pre-AF1 product).
import { spawn } from "node:child_process";
import { existsSync, openSync, closeSync, readFileSync } from "node:fs";
import path from "node:path";
import sharp from "sharp";
import {
  COMPANION_PACKAGE,
  PASEO_PACKAGE,
  androidEnv,
  connectClient,
  decodeMotif,
  fail,
  makeTemp,
  readFile,
  readResults,
  repository,
  rm,
  sleep,
  startEmulator,
  startIsolatedDaemon,
  tools,
  trackChild,
  waitFor,
  writeFile,
} from "../android/lib.mjs";
import {
  imeCommand,
  imeLog,
  keyboardShown,
  releaseJudgeIme,
  selectJudgeIme,
  startImeLog,
} from "./ime.mjs";

const argv = process.argv.slice(2);
const option = (name) => {
  const index = argv.indexOf(name);
  return index === -1 ? null : argv[index + 1];
};
const prerequisiteOnly = argv.includes("--prerequisite");
const buildResult = JSON.parse(
  await readFile(option("--build") ?? fail("--build <result.json> required"), "utf8"),
);
const fixtures = path.join(repository, "qa/pi-workspace/fixtures");
const SLOW_RENDERER_MS = 12_000;
const SLOW_PROPERTY = "debug.paseo.visualhost.slow_renderer_ms";
const BLOCK_PROPERTY = "debug.paseo.visualhost.block_main_ms";
const BLOCK_MS = 7_000;
const OPERATIONS = new Set([
  "open",
  "close",
  "message",
  "capture",
  "terminate",
  "warm",
  "touch",
  "input",
  "idle",
]);
/** Milliseconds since midnight of a logcat threadtime line ("MM-DD HH:MM:SS.mmm ..."). */
function logTime(line) {
  const match = line.match(/^\d\d-\d\d (\d\d):(\d\d):(\d\d)\.(\d\d\d)/);
  if (!match) return null;
  const [hours, minutes, seconds, millis] = match.slice(1).map(Number);
  return ((hours * 60 + minutes) * 60 + seconds) * 1000 + millis;
}

let passed = 0;
let failed = 0;
let activeDevice = null;
const root = await makeTemp("paseo-af1-judge-");
process.stdout.write(`AF1 evidence directory: ${root}\n`);

let artifactCount = 0;
async function artifacts(label) {
  if (!activeDevice) return;
  try {
    artifactCount += 1;
    const index = artifactCount;
    await writeFile(path.join(root, `failure-${index}.png`), await activeDevice.screencap());
    const visible = activeDevice
      .dump()
      .filter((node) => node.text || node.id)
      .map((node) => `${node.pkg} ${node.id} ${JSON.stringify(node.text)}`);
    await writeFile(path.join(root, `failure-${index}.txt`), `${label}\n${visible.join("\n")}\n`);
    process.stdout.write(`failure screen: ${visible.slice(0, 20).join(" | ")}\n`);
  } catch (error) {
    process.stdout.write(`failure artifacts unavailable: ${error.message}\n`);
  }
}

/** A required step: failure stops the flow. */
async function required(label, body) {
  process.stdout.write(`AF1 CHECK ${label}\n`);
  try {
    const value = await body();
    passed += 1;
    process.stdout.write(`AF1 PASS ${label}\n`);
    return value;
  } catch (error) {
    failed += 1;
    process.stdout.write(`AF1 FAIL ${label}: ${error.stack ?? error.message}\n`);
    await artifacts(label);
    throw error;
  }
}

/** An independent feature check: failure is recorded and the flow continues after recovery. */
async function check(label, body, recover) {
  process.stdout.write(`AF1 CHECK ${label}\n`);
  try {
    await body();
    passed += 1;
    process.stdout.write(`AF1 PASS ${label}\n`);
  } catch (error) {
    failed += 1;
    process.stdout.write(`AF1 FAIL ${label}: ${error.stack ?? error.message}\n`);
    await artifacts(label);
    if (recover) {
      try {
        await recover();
      } catch (recoverError) {
        process.stdout.write(`recovery after failure did not complete: ${recoverError.message}\n`);
        await artifacts(`recovery after: ${label}`);
        throw recoverError;
      }
    }
  }
}

/** Pi driver over the isolated session that reports errors instead of asserting them. */
function piCaller({ client, agentId, cwd, piDir }) {
  let count = 0;
  async function callAny(name, args) {
    await client.sendAgentMessage(
      agentId,
      `oracle-call:${JSON.stringify({ name, arguments: args })}`,
    );
    const finish = await client.waitForFinish(agentId, 90_000);
    if (finish.status !== "idle") fail(`${name}: agent finished ${finish.status}`);
    const results = await readResults(piDir, cwd);
    count += 1;
    if (results.length !== count)
      fail(`${name}: expected ${count} tool results, found ${results.length}`);
    const result = results.at(-1);
    if (result.toolName !== name) fail(`${name}: last result was ${result.toolName}`);
    const images = (result.content ?? []).filter((part) => part.type === "image");
    if (images.length > 1) fail(`${name}: more than one image`);
    return {
      isError: result.isError === true,
      details: result.details,
      png: images[0]?.data ? Buffer.from(images[0].data, "base64") : null,
    };
  }
  return {
    callAny,
    async call(name, args, expectError = false) {
      const outcome = await callAny(name, args);
      if (outcome.isError !== expectError)
        fail(
          `${name}: isError=${outcome.isError}, expected ${expectError}: ${JSON.stringify(outcome.details)}`,
        );
      return outcome;
    },
  };
}

function errorCodeOf(outcome) {
  const code = outcome.details?.error?.code;
  if (typeof code !== "string")
    fail(`no structured error code: ${JSON.stringify(outcome.details)}`);
  return code;
}

const cleanups = [];
let exitCode = 1;
try {
  const emulator = await startEmulator(root);
  const device = emulator.device;
  cleanups.push(emulator.close);
  activeDevice = device;
  cleanups.push(startImeLog(device, root));
  process.stdout.write(
    `Android target: ${device.serial} Android ${device.shell(["getprop", "ro.build.version.release"])} (fresh judge emulator — not physical-device evidence)\n`,
  );
  const daemon = await startIsolatedDaemon(path.join(root, "daemon"));
  cleanups.push(daemon.close);
  device.reverse(daemon.port);
  device.install(buildResult.paseoApk);
  if (!buildResult.companionApk) fail(`visual host APK unavailable: ${buildResult.companionError}`);
  device.install(buildResult.companionApk);

  // The companion's complete log for this run (uid-filtered), read by the log checks.
  const companionUid = device.uid(COMPANION_PACKAGE);
  const companionLogPath = path.join(root, "companion-logcat.txt");
  const companionLogFile = openSync(companionLogPath, "w");
  const companionLog = spawn(
    tools.adb,
    ["-s", device.serial, "logcat", "-v", "threadtime", `--uid=${companionUid}`],
    { env: androidEnv(), stdio: ["ignore", companionLogFile, companionLogFile] },
  );
  closeSync(companionLogFile);
  cleanups.push(trackChild(companionLog, "companion logcat"));
  const companionLines = () => readFileSync(companionLogPath, "utf8").split("\n");

  const client = await connectClient(daemon.port);
  cleanups.push(() => client.close());
  const cwd = await makeTemp("paseo-af1-project-");
  cleanups.push(() => rm(cwd, { recursive: true, force: true }));
  const created = await client.createWorkspace({
    source: { kind: "directory", path: cwd },
    title: "AF1 judge",
  });
  if (!created.workspace) fail(created.error ?? "workspace creation failed");
  const agent = await client.createAgent({
    provider: "pi",
    model: "pi-workspace-oracle/scripted",
    thinkingOptionId: "off",
    cwd,
    workspaceId: created.workspace.id,
    title: "AF1 judge visual",
  });
  const pi = piCaller({ client, agentId: agent.id, cwd, piDir: daemon.piDir });

  async function present(name, title, html) {
    const file = path.join(cwd, name);
    await writeFile(file, html, "utf8");
    const outcome = await pi.call("visual_present", { mode: "new", title, file });
    if (outcome.details?.status !== "rendered")
      fail(`present not rendered: ${JSON.stringify(outcome.details)}`);
    return outcome.details;
  }
  async function stateOf(id) {
    return (await pi.call("visual_inspect", { id })).details.state ?? {};
  }
  async function waitForState(id, key, expected, label) {
    let last = null;
    try {
      return await waitFor(
        label,
        async () => {
          last = (await stateOf(id))[key];
          return last === expected ? last : null;
        },
        { timeout: 20_000, interval: 1000 },
      );
    } catch {
      fail(
        `${label}: visual state ${key}=${JSON.stringify(last)}, expected ${JSON.stringify(expected)}`,
      );
    }
  }
  /**
   * A fresh UI hierarchy (observation only). When both dump paths fail, stale UiAutomation clients
   * are listed and cleared and the dump is taken once more; a second failure stops the check.
   */
  function dump() {
    try {
      return device.dump();
    } catch (error) {
      const stale = (device.tryShell(["ps", "-A", "-o", "PID,NAME"]) ?? "")
        .split("\n")
        .filter((row) => /uiautomator|app_process/.test(row))
        .map((row) => row.trim());
      process.stdout.write(
        `UI dump failed (${error.message}); stale clients: ${stale.join(" | ") || "none"}; retrying once\n`,
      );
      device.tryShell(["pkill", "-f", "uiautomator"]);
      device.tryShell(["pkill", "-f", "NoIdleDump"]);
      return device.dump();
    }
  }
  function findId(id) {
    const nodes = dump();
    if (device.handleAnr(nodes)) return null;
    return nodes.find((node) => node.id === id && node.bounds) ?? null;
  }
  function screenSummary() {
    return dump()
      .filter((node) => node.id && !node.id.startsWith("android:") && !node.id.includes(":id/"))
      .map((node) => node.id)
      .slice(0, 12)
      .join(",");
  }
  async function dismissOverlays() {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const nodes = dump();
      const sidebarClose = nodes.find((node) => node.id === "sidebar-close" && node.bounds);
      if (sidebarClose) {
        const [x1, y1, x2, y2] = sidebarClose.bounds;
        device.tap((x1 + x2) / 2, (y1 + y2) / 2);
      } else if (nodes.some((node) => node.id === "command-center-input")) {
        device.key(4);
      } else {
        return;
      }
      await sleep(1000);
    }
    fail(`an overlay still covers the conversation: ${screenSummary()}`);
  }
  async function openConversation() {
    device.deepLink(`paseo:///h/${daemon.serverId}/agent/${agent.id}`, PASEO_PACKAGE);
    await sleep(3000);
    process.stdout.write(`after deep link: ${screenSummary()}\n`);
    if (!findId("message-input-root")) {
      await device.tapId("menu-button", 30_000);
      await sleep(2000);
    }
    await device.waitForId("message-input-root", 60_000);
    await dismissOverlays();
    if (!findId("message-input-root")) fail(`conversation not displayed: ${screenSummary()}`);
  }
  async function openDirectConnectionForm() {
    await device.waitForId("welcome-screen", 90_000);
    await sleep(2000);
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await device.tapId("welcome-direct-connection", 30_000);
      try {
        await device.waitForId("direct-host-input", 20_000);
        return;
      } catch {
        process.stdout.write(
          `direct connection form did not open (attempt ${attempt}); retrying\n`,
        );
        device.key(4);
        await sleep(2000);
        if (!findId("welcome-screen")) device.start(`${PASEO_PACKAGE}/.MainActivity`);
      }
    }
    fail("the direct connection form never opened");
  }
  /**
   * Flat-color regions of the keyboard witness in an independent screencap. A region is the
   * longest run of rows that are mostly its color, so a partly scrolled or partly covered witness
   * still yields a tappable box inside the visible part.
   */
  async function regions() {
    const { data, info } = await sharp(await device.screencap())
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const kind = (r, g, b) => {
      if (r < 70 && g > 190 && b < 70) return "text";
      if (r > 190 && g > 190 && b < 70) return "number";
      if (r < 70 && g < 70 && b > 190) return "notes";
      if (r < 70 && g > 190 && b > 190) return "blank";
      return null;
    };
    const runs = {};
    const step = 4;
    for (let y = 0; y < info.height; y += step) {
      const counts = {};
      const spans = {};
      for (let x = 0; x < info.width; x += step) {
        const offset = (y * info.width + x) * 4;
        const name = kind(data[offset], data[offset + 1], data[offset + 2]);
        if (!name) continue;
        counts[name] = (counts[name] ?? 0) + 1;
        const span = (spans[name] ??= { minX: x, maxX: x });
        span.maxX = x;
      }
      for (const [name, count] of Object.entries(counts)) {
        if (count * step < 0.6 * info.width) continue;
        const list = (runs[name] ??= []);
        const last = list.at(-1);
        if (last && y - last.maxY <= 2 * step) {
          last.maxY = y;
          last.minX = Math.min(last.minX, spans[name].minX);
          last.maxX = Math.max(last.maxX, spans[name].maxX);
        } else {
          list.push({ minY: y, maxY: y, minX: spans[name].minX, maxX: spans[name].maxX });
        }
      }
    }
    const boxes = {};
    for (const [name, list] of Object.entries(runs)) {
      const best = list.toSorted(
        (left, right) => right.maxY - right.minY - (left.maxY - left.minY),
      )[0];
      if (best && best.maxY - best.minY >= 40) boxes[name] = best;
    }
    return boxes;
  }
  async function region(name) {
    await dismissOverlays();
    return waitFor(
      `the ${name} region of the keyboard witness on screen`,
      async () => (await regions())[name] ?? null,
      { timeout: 30_000, interval: 1000 },
    );
  }
  async function tapRegion(name) {
    const box = await region(name);
    device.tap((box.minX + box.maxX) / 2, (box.minY + box.maxY) / 2);
  }
  /** Paseo's own composer field (inside message-input-root, in Paseo's package). */
  function composer() {
    const nodes = dump();
    const rootNode = nodes.find((node) => node.id === "message-input-root" && node.bounds);
    if (!rootNode) return null;
    const [rx1, ry1, rx2, ry2] = rootNode.bounds;
    return (
      nodes.find(
        (node) =>
          node.pkg === PASEO_PACKAGE &&
          node.cls === "android.widget.EditText" &&
          node.bounds &&
          node.bounds[0] >= rx1 &&
          node.bounds[1] >= ry1 &&
          node.bounds[2] <= rx2 &&
          node.bounds[3] <= ry2,
      ) ?? null
    );
  }
  /**
   * The system keyboard reaches the wanted visibility and keeps it for at least 1.5 s (a keyboard
   * that flickers up and is hidden again by the platform does not count as shown).
   */
  async function waitKeyboard(shown, label, timeout = 8_000) {
    let since = null;
    await waitFor(
      label,
      () => {
        if (keyboardShown(device) !== shown) {
          since = null;
          return false;
        }
        since ??= Date.now();
        return Date.now() - since >= 1_500;
      },
      { timeout: timeout + 1_500, interval: 300 },
    );
  }

  /** The first judge keyboard log entry after a mark that satisfies a predicate. */
  async function waitIme(mark, predicate, label) {
    return waitFor(label, () => imeLog().slice(mark).find(predicate) ?? null, {
      timeout: 10_000,
      interval: 400,
    });
  }
  /** The editor the keyboard is bound to after a tap: the last START with a real input type. */
  async function boundEditor(mark, label) {
    await waitIme(mark, (entry) => entry.kind === "START" && editable(entry), label);
    await sleep(800);
    return imeLog()
      .slice(mark)
      .findLast((entry) => entry.kind === "START" && editable(entry));
  }
  /**
   * AF1 K1: the keyboard for a visual's field is served by Paseo's own window. HyperOS does not
   * show a keyboard for another app's embedded window, so the visual host app must never become
   * the keyboard's client.
   */
  function requirePaseoEditor(editor, mark) {
    const foreign = imeLog()
      .slice(mark)
      .find((entry) => entry.kind === "START" && entry.package === COMPANION_PACKAGE);
    if (foreign)
      fail(`the visual host app became the keyboard client (${foreign.line}); Paseo must serve it`);
    if (editor.package !== PASEO_PACKAGE)
      fail(`keyboard bound to ${editor.package}, expected Paseo (${PASEO_PACKAGE})`);
  }
  function editable(entry) {
    return entry.package !== "none" && Number.parseInt(entry.inputType ?? "0", 16) !== 0;
  }
  /**
   * The state every keyboard check starts from: no keyboard on screen and the conversation shown.
   * The keyboard is dismissed by tapping a non-editable part of the keyboard witness when it is on
   * screen, and with Back only otherwise (Back can also navigate, which is checked separately).
   */
  async function settle() {
    if (keyboardShown(device)) {
      const blank = (await regions()).blank;
      if (blank) {
        device.tap((blank.minX + blank.maxX) / 2, (blank.minY + blank.maxY) / 2);
        try {
          await waitKeyboard(false, "keyboard hidden by tapping outside the field", 5_000);
        } catch {
          process.stdout.write("settle: tapping outside the field left the keyboard shown\n");
        }
      }
      if (keyboardShown(device)) {
        device.key(4);
        await waitKeyboard(false, "keyboard hidden before the next check");
      }
    }
    if (!findId("message-input-root")) {
      process.stdout.write(`settle: conversation not shown (${screenSummary()}); reopening\n`);
      device.start(`${PASEO_PACKAGE}/.MainActivity`);
      await sleep(3000);
      if (!findId("message-input-root")) await openConversation();
    }
  }

  await required("Paseo Android app connects to the isolated daemon", async () => {
    device.start(`${PASEO_PACKAGE}/.MainActivity`);
    await openDirectConnectionForm();
    await device.typeInto("direct-host-input", "127.0.0.1");
    await device.typeInto("direct-port-input", String(daemon.port));
    device.key(66);
    await waitFor(
      "connection to leave the welcome screen",
      () => !findId("welcome-screen") && !findId("add-host-modal"),
      { timeout: 60_000, interval: 1000 },
    );
    await device.waitForId("menu-button", 60_000);
    await openConversation();
  });

  const witness = await readFile(path.join(fixtures, "ime.html"), "utf8");
  const keyboardVisual = await required(
    "prerequisite: a real Pi visual with editable fields is displayed on Android",
    async () => {
      const details = await present("ime.html", "Keyboard witness", witness);
      for (const name of ["text", "number", "notes", "blank"]) await region(name);
      return details;
    },
  );

  if (prerequisiteOnly) {
    exitCode = 0;
  } else {
    const paseoPid = device.pid(PASEO_PACKAGE);
    const anrBaseline = device.anrCount;
    selectJudgeIme(device);
    await settle();
    const id = keyboardVisual.id;

    await check(
      "keyboard opens for a visual's text field; typed text reaches only the visual",
      async () => {
        await settle();
        if (keyboardShown(device)) fail("a keyboard was already shown before the tap");
        const draftBefore = composer()?.text ?? fail("composer not found");
        const mark = imeLog().length;
        await tapRegion("text");
        await waitKeyboard(true, "soft keyboard shown after tapping the visual's text field");
        await waitIme(mark, (entry) => entry.kind === "SHOWN", "judge keyboard input view shown");
        const editor = await boundEditor(mark, "keyboard bound to the visual's text field");
        requirePaseoEditor(editor, mark);
        const type = Number.parseInt(editor.inputType, 16);
        if ((type & 0xf) !== 0x1 || (type & 0x20000) !== 0)
          fail(`text field inputType ${editor.inputType} is not single-line text`);
        await imeCommand(device, "commit", "Hello");
        await waitForState(id, "text", "Hello", "committed text in the visual");
        await imeCommand(device, "compose", " wor");
        await imeCommand(device, "finish");
        await imeCommand(device, "delete", "1");
        await imeCommand(device, "commit", "rld");
        await waitForState(id, "text", "Hello world", "composed, deleted and committed text");
        const before = await imeCommand(device, "before", "100");
        const seen = Buffer.from(before.before ?? "", "base64").toString("utf8");
        if (seen !== "Hello world")
          fail(
            `the keyboard reads ${JSON.stringify(seen)} before the cursor, expected "Hello world"`,
          );
        const draftAfter = composer()?.text ?? fail("composer not found after typing");
        if (draftAfter !== draftBefore)
          fail(
            `composer draft changed: ${JSON.stringify(draftBefore)} -> ${JSON.stringify(draftAfter)}`,
          );
      },
      settle,
    );

    await check(
      "numeric and multi-line fields pass their input kind; Enter makes a new line",
      async () => {
        await settle();
        let mark = imeLog().length;
        await tapRegion("number");
        await waitKeyboard(true, "soft keyboard shown for the numeric field");
        const numeric = await boundEditor(mark, "keyboard bound to the numeric field");
        requirePaseoEditor(numeric, mark);
        if ((Number.parseInt(numeric.inputType, 16) & 0xf) !== 0x2)
          fail(`numeric field inputType ${numeric.inputType} is not TYPE_CLASS_NUMBER`);
        await imeCommand(device, "commit", "42");
        await waitForState(id, "number", "42", "number typed into the numeric field");
        await settle();
        mark = imeLog().length;
        await tapRegion("notes");
        await waitKeyboard(true, "soft keyboard shown for the multi-line field");
        const notes = await boundEditor(mark, "keyboard bound to the multi-line field");
        requirePaseoEditor(notes, mark);
        const type = Number.parseInt(notes.inputType, 16);
        if ((type & 0xf) !== 0x1 || (type & 0x20000) === 0)
          fail(`multi-line field inputType ${notes.inputType} is not multi-line text`);
        await imeCommand(device, "commit", "line1");
        await imeCommand(device, "enter");
        await imeCommand(device, "commit", "line2");
        await waitForState(id, "notes", "line1\nline2", "two lines in the multi-line field");
      },
      settle,
    );

    await check(
      "contenteditable text is edited through Paseo's keyboard client",
      async () => {
        await settle();
        const html = await readFile(path.join(fixtures, "ime-editable.html"), "utf8");
        const editableVisual = await present("ime-editable.html", "Editable witness", html);
        try {
          const mark = imeLog().length;
          await tapRegion("text");
          await waitKeyboard(true, "keyboard shown for a contenteditable element");
          const editor = await boundEditor(mark, "keyboard bound to contenteditable");
          requirePaseoEditor(editor, mark);
          await imeCommand(device, "commit", "Editable ");
          await imeCommand(device, "compose", "alpa");
          await imeCommand(device, "finish");
          await imeCommand(device, "delete", "1");
          await imeCommand(device, "commit", "ha");
          await waitForState(editableVisual.id, "text", "Editable alpha", "contenteditable text");
          const before = await imeCommand(device, "before", "100");
          if (Buffer.from(before.before ?? "", "base64").toString("utf8") !== "Editable alpha")
            fail("contenteditable text before the cursor differs from the visual");
        } finally {
          await settle();
          const reopened = await pi.call("visual_present", { mode: "open", id });
          if (reopened.details?.status !== "rendered")
            fail("the field-kind witness did not reopen after contenteditable");
        }
      },
      settle,
    );

    await check(
      "blur and Back hide the keyboard; the conversation and the visual stay",
      async () => {
        await settle();
        const before = await stateOf(id);
        await tapRegion("text");
        await waitKeyboard(true, "soft keyboard shown for the text field");
        await tapRegion("blank");
        await waitKeyboard(
          false,
          "keyboard hidden after tapping a non-editable area of the visual",
        );
        await tapRegion("text");
        await waitKeyboard(true, "soft keyboard shown again for the text field");
        device.key(4);
        await waitKeyboard(false, "keyboard hidden by Back");
        await sleep(1500);
        if (!findId("message-input-root")) fail("Back left the conversation");
        const focus =
          (device.tryShell(["dumpsys", "window", "displays"]) ?? "").match(
            /mCurrentFocus=Window\{[^ ]+ [^ ]+ ([^/}\s]+)/,
          )?.[1] ?? "";
        if (focus !== PASEO_PACKAGE) fail(`focus left Paseo after Back: ${focus || "none"}`);
        await region("text");
        const after = await stateOf(id);
        if (JSON.stringify(after) !== JSON.stringify(before))
          fail(
            `visual state changed by blur/Back: ${JSON.stringify(before)} -> ${JSON.stringify(after)}`,
          );
      },
      settle,
    );

    await check(
      "the composer gets the keyboard back; its text lands only in the draft",
      async () => {
        await settle();
        const before = await stateOf(id);
        const field = composer() ?? fail("composer not found");
        const mark = imeLog().length;
        const [x1, y1, x2, y2] = field.bounds;
        device.tap((x1 + x2) / 2, (y1 + y2) / 2);
        await waitIme(
          mark,
          (entry) => entry.kind === "START" && entry.package === PASEO_PACKAGE,
          "keyboard bound to Paseo's composer",
        );
        await waitKeyboard(true, "soft keyboard shown for the composer");
        await imeCommand(device, "commit", "draft");
        await waitFor(
          "typed text in the composer",
          () => (composer()?.text ?? "").includes("draft"),
          { timeout: 10_000, interval: 700 },
        );
        const after = await stateOf(id);
        if (JSON.stringify(after) !== JSON.stringify(before))
          fail(
            `visual state changed while typing into the composer: ${JSON.stringify(before)} -> ${JSON.stringify(after)}`,
          );
        device.key(4);
        await waitKeyboard(false, "keyboard hidden after the composer check");
      },
      settle,
    );
    releaseJudgeIme(device);
    await settle();

    // R1/R4/R5/R3: a hung document while renderer termination is slow (debug seam, 12 s). The
    // recovery visual is presented right after the hang report, while the termination runs.
    device.shell(["setprop", SLOW_PROPERTY, String(SLOW_RENDERER_MS)]);
    let hangReportedAt = null;
    let hangLogMark = companionLines().length;
    await check(
      "hung document with slow renderer termination reports DOCUMENT_UNRESPONSIVE within 12 s",
      async () => {
        await settle();
        const hang = await readFile(path.join(fixtures, "hang.html"), "utf8");
        const presented = await present("hang.html", "Hang witness", hang);
        hangLogMark = companionLines().length;
        await pi.call("visual_act", { id: presented.id, action: "freeze", value: {} });
        await sleep(1500);
        const started = Date.now();
        const outcome = await pi.callAny("visual_inspect", { id: presented.id });
        const elapsed = Date.now() - started;
        hangReportedAt = Date.now();
        if (!outcome.isError) fail("inspecting a hung document succeeded");
        const code = errorCodeOf(outcome);
        if (code !== "DOCUMENT_UNRESPONSIVE")
          fail(`expected DOCUMENT_UNRESPONSIVE, got ${code} after ${elapsed} ms`);
        if (elapsed > 12_000) fail(`DOCUMENT_UNRESPONSIVE took ${elapsed} ms (limit 12000)`);
        if (device.pid(PASEO_PACKAGE) !== paseoPid) fail("Paseo process restarted");
      },
    );

    await check(
      "a new visual renders with correct pixels within 30 s of the hang report",
      async () => {
        const started = hangReportedAt ?? Date.now();
        const pixels = await readFile(path.join(fixtures, "client-pixels-touch.html"), "utf8");
        const file = path.join(cwd, "recovery.html");
        await writeFile(file, pixels, "utf8");
        let rendered = null;
        for (let attempt = 1; attempt <= 2 && !rendered; attempt += 1) {
          const outcome = await pi.callAny("visual_present", {
            mode: "new",
            title: `Recovery pixels ${attempt}`,
            file,
          });
          if (!outcome.isError && outcome.details?.status === "rendered")
            rendered = outcome.details;
          else if (outcome.isError)
            process.stdout.write(`recovery attempt ${attempt}: explicit ${errorCodeOf(outcome)}\n`);
          else
            fail(
              `recovery present neither rendered nor failed: ${JSON.stringify(outcome.details)}`,
            );
        }
        if (!rendered) fail("no visual rendered after two presents");
        const elapsed = Date.now() - started;
        if (elapsed > 30_000) fail(`recovery took ${elapsed} ms after the hang report`);
        await dismissOverlays();
        const motif = await waitFor(
          "recovered visual on the device screen",
          async () => decodeMotif(await device.screencap()),
          { timeout: 30_000, interval: 1000 },
        );
        const shot = await pi.call("visual_inspect", { id: rendered.id, screenshot: true });
        if ((await decodeMotif(shot.png))?.code !== motif.code)
          fail("capture after recovery mismatched the screen");
        if (device.pid(PASEO_PACKAGE) !== paseoPid) fail("Paseo process restarted");
      },
      settle,
    );
    device.tryShell(["setprop", SLOW_PROPERTY, "0"]);

    await check("the slow-termination seam ran and main-thread stalls are logged", async () => {
      const seam = await waitFor(
        "the debug slow-renderer seam delayed a renderer termination",
        () =>
          companionLines()
            .slice(hangLogMark)
            .map((line) =>
              line.match(/debug slow renderer: terminate delayed (\d+) ms on thread (.+?)\s*$/),
            )
            .find((match) => match && Number(match[1]) === SLOW_RENDERER_MS) ?? null,
        { timeout: 20_000, interval: 1000 },
      );
      process.stdout.write(`slow termination ran on thread ${seam[2]}\n`);
      if (seam[2] === "main") {
        const stall = await waitFor(
          "a main-thread stall diagnostic for the slow termination",
          () =>
            companionLines()
              .slice(hangLogMark)
              .map((line) => line.match(/main thread stalled (\d+) ms during (\w+)/))
              .find((match) => match && Number(match[1]) >= SLOW_RENDERER_MS - 2_000) ?? null,
          { timeout: 30_000, interval: 1000 },
        );
        process.stdout.write(`stall diagnostic: ${stall[0]}\n`);
      }
    });

    await check(
      "a blocked main thread is reported while it lasts and afterwards, with operation and stack",
      async () => {
        await settle();
        const reopened = await pi.call("visual_present", { mode: "open", id });
        if (reopened.details?.status !== "rendered") fail("the keyboard witness did not reopen");
        await sleep(2_000);
        const mark = companionLines().length;
        device.shell(["setprop", BLOCK_PROPERTY, String(BLOCK_MS)]);
        try {
          const block = await waitFor(
            "the debug main-thread block ran",
            () =>
              companionLines()
                .slice(mark)
                .find((line) => line.includes(`debug block main: ${BLOCK_MS} ms`)) ?? null,
            { timeout: 15_000, interval: 500 },
          );
          const blockStart = logTime(block);
          const stalls = await waitFor(
            "stall reports covering the whole block",
            () => {
              const lines = companionLines().slice(mark);
              const found = lines
                .map((line, index) => ({
                  line,
                  index,
                  match: line.match(/main thread stalled (\d+) ms during (\w+)/),
                }))
                .filter((entry) => entry.match);
              const after = found.some((entry) => {
                const at = logTime(entry.line);
                return (
                  Number(entry.match[1]) >= BLOCK_MS - 1_000 &&
                  blockStart !== null &&
                  at !== null &&
                  at >= blockStart + BLOCK_MS
                );
              });
              return after ? { lines, found } : null;
            },
            { timeout: 25_000, interval: 1_000 },
          );
          for (const { line, index, match } of stalls.found) {
            if (!OPERATIONS.has(match[2])) fail(`stall report names an unknown operation: ${line}`);
            const frames = stalls.lines
              .slice(index + 1, index + 16)
              .some((next) => /PaseoVisualHost/.test(next) && /\bat [\w.$<>]+\(/.test(next));
            if (!frames) fail(`stall report without stack frames: ${line}`);
          }
          const during = stalls.found.find(
            ({ line, match }) =>
              Number(match[1]) >= 4_000 &&
              blockStart !== null &&
              logTime(line) !== null &&
              logTime(line) < blockStart + BLOCK_MS,
          );
          if (!during)
            fail(
              `no stall report of at least 4000 ms while the block lasted: ${stalls.found.map((entry) => entry.line).join(" | ")}`,
            );
          process.stdout.write(
            `stall reports: ${stalls.found.map((entry) => entry.match[0]).join("; ")}\n`,
          );
        } finally {
          device.tryShell(["setprop", BLOCK_PROPERTY, "0"]);
        }
        await sleep(1_000);
        const after = await pi.callAny("visual_inspect", { id });
        if (after.isError)
          fail(`the visual stopped answering after the block: ${JSON.stringify(after.details)}`);
      },
      async () => {
        device.tryShell(["setprop", BLOCK_PROPERTY, "0"]);
        await settle();
      },
    );

    await check("no calls into destroyed WebViews and no ANR during feature checks", async () => {
      const destroyed = companionLines().filter((line) =>
        line.includes("attempted to call on a destroyed WebView"),
      );
      if (destroyed.length > 0)
        fail(`companion called a destroyed WebView ${destroyed.length} time(s): ${destroyed[0]}`);
      if (device.anrCount > anrBaseline)
        fail(`${device.anrCount - anrBaseline} ANR dialog(s) during feature checks`);
      if (device.pid(PASEO_PACKAGE) !== paseoPid) fail("Paseo process restarted");
    });
    exitCode = failed === 0 ? 0 : 1;
  }
} catch (error) {
  process.stdout.write(`AF1 flow stopped: ${error.message}\n`);
} finally {
  for (const cleanup of cleanups.toReversed()) {
    try {
      await cleanup();
    } catch (error) {
      process.stdout.write(`cleanup warning: ${error.message}\n`);
    }
  }
  process.stdout.write(`AF1 checks passed: ${passed}, failed: ${failed}. Evidence: ${root}\n`);
  process.exitCode = exitCode;
}
if (!existsSync(root)) process.exitCode = 1;
