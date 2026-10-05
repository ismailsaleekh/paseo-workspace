#!/usr/bin/env node
// Judge-owned S1 Android flow: real Pi -> isolated daemon with local speech -> real Paseo Android
// app on a fresh emulator (or an explicitly named device). Agent speech is observed through the
// platform's own playback state for the Paseo UID (`dumpsys audio` players), independently of the
// app; tool results come from the persisted Pi session. With the desktop app also open, speech
// must play on exactly one client. Dictation on Android needs a real microphone and is a
// separate physical-device gate.
import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { _electron as electron } from "@playwright/test";
import {
  Device,
  PASEO_PACKAGE,
  connectClient,
  fail,
  freePort,
  makeTemp,
  readResults,
  repository,
  rm,
  sleep,
  startEmulator,
  startIsolatedDaemon,
  waitFor,
  writeFile,
} from "../android/lib.mjs";

const argv = process.argv.slice(2);
const option = (name) => {
  const index = argv.indexOf(name);
  return index === -1 ? null : argv[index + 1];
};
const buildResult = JSON.parse(
  await readFile(option("--build") ?? fail("--build <result.json> required"), "utf8"),
);
const serial = option("--serial");
const withDesktop = !argv.includes("--skip-desktop");
const models = path.join(homedir(), ".cache", "pi-paseo-workspace", "speech-models/local-speech");

const SPEAK_SHORT =
  "The zebra counted many kumquats near the old brass telescope. Then it whistled a quiet song.";
const SPEAK_LONG = [
  "This utterance is deliberately long so that playback can be interrupted.",
  "A lighthouse keeper once kept a diary of every passing ship and every change in the wind.",
  "He wrote about herring boats, about fog that arrived without warning, and about a cat named Pepper.",
  "On calm evenings he played the violin for the gulls, who never applauded.",
  "His notebooks are now kept in a small library beside the harbour wall.",
  "Visitors can read them by the window while the tide goes out across the sand.",
].join(" ");
// Starts with a capital: Android applies sentence auto-capitalisation to injected key events.
const DRAFT = "Draft stays put";

let passed = 0;
let activeDevice = null;
const root = await makeTemp("paseo-s1-android-");
process.stdout.write(`S1 Android evidence directory: ${root}\n`);
async function check(label, body) {
  process.stdout.write(`S1 ANDROID CHECK ${label}\n`);
  try {
    const value = await body();
    passed += 1;
    process.stdout.write(`S1 ANDROID PASS ${label}\n`);
    return value;
  } catch (error) {
    process.stdout.write(`S1 ANDROID FAIL ${label}: ${error.stack ?? error.message}\n`);
    if (activeDevice) {
      try {
        await writeFile(
          path.join(root, `failure-${passed + 1}.png`),
          await activeDevice.screencap(),
        );
        const visible = activeDevice
          .dump()
          .filter((node) => node.text || node.id)
          .map((node) => `${node.id} ${JSON.stringify(node.text)}`);
        await writeFile(path.join(root, `failure-${passed + 1}.txt`), `${visible.join("\n")}\n`);
        await writeFile(
          path.join(root, `failure-${passed + 1}-audio.txt`),
          activeDevice.tryShell(["dumpsys", "audio"]) ?? "dumpsys audio unavailable",
        );
      } catch (artifactError) {
        process.stdout.write(`failure artifacts unavailable: ${artifactError.message}\n`);
      }
    }
    throw error;
  }
}

/** Playback states AudioService reports for one UID (AudioPlaybackConfiguration players). */
function playerStates(dump, uid) {
  const section = dump.split(/\n\s*players:\s*\n/)[1];
  if (section === undefined) fail("dumpsys audio has no players section");
  const block = section.split(/\n\s*\n/)[0];
  return block
    .split("\n")
    .filter((line) => line.includes("AudioPlaybackConfiguration") && line.includes(`u/pid:${uid}/`))
    .map((line) => line.match(/\bstate:(\w+)/)?.[1] ?? "unknown");
}

const cleanups = [];
let exitCode = 1;
try {
  let device;
  if (serial) {
    device = new Device(serial);
    if (device.tryShell(["getprop", "sys.boot_completed"]) !== "1")
      fail(`device ${serial} is not ready`);
  } else {
    const emulator = await startEmulator(root);
    device = emulator.device;
    cleanups.push(emulator.close);
  }
  activeDevice = device;
  process.stdout.write(
    `Android target: ${device.serial} Android ${device.shell(["getprop", "ro.build.version.release"])} (${serial ? "named device" : "fresh judge emulator — not physical-device evidence"})\n`,
  );
  const metroPort = withDesktop ? await freePort() : null;
  const daemon = await startIsolatedDaemon(path.join(root, "daemon"), {
    ...(metroPort ? { corsOrigin: `http://localhost:${metroPort}` } : {}),
    speechModels: models,
  });
  cleanups.push(daemon.close);
  device.reverse(daemon.port);
  device.install(buildResult.paseoApk);
  if (buildResult.companionApk) device.install(buildResult.companionApk);
  const uid = device.uid(PASEO_PACKAGE);

  const client = await connectClient(daemon.port);
  cleanups.push(() => client.close());
  const cwd = await makeTemp("paseo-s1-android-project-");
  cleanups.push(() => rm(cwd, { recursive: true, force: true }));
  const created = await client.createWorkspace({
    source: { kind: "directory", path: cwd },
    title: "S1 Android judge",
  });
  if (!created.workspace) fail(created.error ?? "workspace creation failed");
  const agent = await client.createAgent({
    provider: "pi",
    model: "pi-workspace-oracle/scripted",
    thinkingOptionId: "off",
    cwd,
    workspaceId: created.workspace.id,
    title: "S1 Android speech",
  });

  // ---------- independent observations ----------
  const audioStates = () => playerStates(device.shell(["dumpsys", "audio"]), uid);
  const androidPlaying = () => audioStates().includes("started");
  // Pi creates the session file with the first prompt, so before it no result can exist.
  let prompted = 0;
  async function speakResults() {
    if (prompted === 0) return [];
    return (await readResults(daemon.piDir, cwd)).filter((result) => result.toolName === "speak");
  }
  async function sendSpeak(text) {
    const before = (await speakResults()).length;
    await client.sendAgentMessage(
      agent.id,
      `oracle-call:${JSON.stringify({ name: "speak", arguments: { text } })}`,
    );
    prompted += 1;
    return before;
  }
  async function speakResult(before, timeout) {
    return waitFor(
      "speak tool result",
      async () => {
        const results = await speakResults();
        return results.length > before ? results[before] : null;
      },
      { timeout, interval: 250 },
    );
  }
  async function settled() {
    const finish = await client.waitForFinish(agent.id, 60_000);
    if (finish.status !== "idle") fail(`agent run finished ${finish.status}`);
  }

  // ---------- Android UI helpers (harness only) ----------
  function screenSummary() {
    return device
      .dump()
      .filter((node) => node.id && !node.id.startsWith("android:") && !node.id.includes(":id/"))
      .map((node) => node.id)
      .slice(0, 12)
      .join(",");
  }
  async function dismissOverlays() {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const nodes = device.dump();
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
    if (!device.find("message-input-root")) {
      await device.tapId("menu-button", 30_000);
      await sleep(2000);
    }
    await device.waitForId("message-input-root", 60_000);
    await dismissOverlays();
    if (!device.find("message-input-root")) fail(`conversation not displayed: ${screenSummary()}`);
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
        if (!device.find("welcome-screen")) device.start(`${PASEO_PACKAGE}/.MainActivity`);
      }
    }
    fail("the direct connection form never opened");
  }
  function inside(outer, inner) {
    return (
      inner[0] >= outer[0] && inner[1] >= outer[1] && inner[2] <= outer[2] && inner[3] <= outer[3]
    );
  }
  function composerNode() {
    const nodes = device.dump();
    const rootNode = nodes.find((node) => node.id === "message-input-root" && node.bounds);
    if (!rootNode) return null;
    return (
      nodes.find(
        (node) =>
          node.cls === "android.widget.EditText" &&
          node.bounds &&
          inside(rootNode.bounds, node.bounds),
      ) ?? null
    );
  }
  async function typeDraft(text) {
    const node = await waitFor("composer text field", () => composerNode(), { timeout: 30_000 });
    const [x1, y1, x2, y2] = node.bounds;
    device.tap((x1 + x2) / 2, (y1 + y2) / 2);
    await sleep(600);
    device.key(123);
    for (let index = 0; index < node.text.length + 4; index += 1) device.key(67);
    for (const character of text) {
      device.shell(["input", "text", character === " " ? "%s" : character]);
      await sleep(160);
    }
    await sleep(500);
    hideKeyboard();
    await sleep(500);
    const typed = composerNode()?.text ?? "";
    if (typed !== text) fail(`composer draft is ${JSON.stringify(typed)}, expected ${text}`);
  }
  function hideKeyboard() {
    if (/mInputShown=true/.test(device.shell(["dumpsys", "input_method"]))) device.key(4);
  }
  function draftText() {
    return composerNode()?.text ?? null;
  }

  await check("Paseo Android app connects to the isolated speech daemon", async () => {
    device.start(`${PASEO_PACKAGE}/.MainActivity`);
    await openDirectConnectionForm();
    await device.typeInto("direct-host-input", "127.0.0.1");
    await device.typeInto("direct-port-input", String(daemon.port));
    device.key(66);
    await waitFor(
      "connection to leave the welcome screen",
      () => !device.find("welcome-screen") && !device.find("add-host-modal"),
      { timeout: 60_000, interval: 1000 },
    );
    await device.waitForId("menu-button", 60_000);
    await openConversation();
    if (androidPlaying()) fail("Paseo is already playing audio before any speech");
  });

  await check("speak plays on the Android client and completes only after playback", async () => {
    await typeDraft(DRAFT);
    const before = await sendSpeak(SPEAK_SHORT);
    const startedAt = await waitFor(
      "Android playback for the Paseo UID",
      () => (androidPlaying() ? Date.now() : null),
      { timeout: 30_000, interval: 150 },
    );
    if ((await speakResults()).length > before)
      fail("speak resolved before its audio started playing");
    const result = await speakResult(before, 90_000);
    const resolvedAt = Date.now();
    if (result.isError || result.details?.status !== "completed")
      fail(`speak did not complete: ${JSON.stringify(result.details)}`);
    if (typeof result.details?.client !== "string" || result.details.client.length === 0)
      fail("speak result names no client");
    if (!(result.details?.durationMs >= 2000))
      fail(`implausible playback duration: ${JSON.stringify(result.details)}`);
    if (resolvedAt - startedAt < 2000)
      fail(`speak resolved ${resolvedAt - startedAt} ms after playback started`);
    await sleep(1500);
    if (androidPlaying()) fail("Paseo kept an active player after the utterance finished");
    await settled();
    if (draftText() !== DRAFT) fail(`speech changed the composer draft: ${draftText()}`);
  });

  await check(
    "speech-stop silences Android playback at once; agent and draft unaffected",
    async () => {
      const before = await sendSpeak(SPEAK_LONG);
      await waitFor("long utterance playing", () => androidPlaying(), {
        timeout: 30_000,
        interval: 150,
      });
      await sleep(1500);
      const stopNode = await device.waitForId("speech-stop", 5000);
      const [x1, y1, x2, y2] = stopNode.bounds;
      device.tap((x1 + x2) / 2, (y1 + y2) / 2);
      const tappedAt = Date.now();
      // Sampling resolution is one dumpsys call: every sample begun ≥ 1 s after the tap must be silent.
      const samples = [];
      while (Date.now() - tappedAt < 4000) {
        const at = Date.now();
        samples.push({ offset: at - tappedAt, playing: androidPlaying() });
      }
      const late = samples.filter((sample) => sample.offset >= 1000 && sample.playing);
      if (late.length > 0)
        fail(
          `audio still playing after stop: ${JSON.stringify(samples.map((s) => [s.offset, s.playing]))}`,
        );
      const result = await speakResult(before, 10_000);
      if (result.isError || result.details?.status !== "stopped")
        fail(`speak not reported stopped: ${JSON.stringify(result.details)}`);
      await settled();
      if (draftText() !== DRAFT) fail(`stop changed the composer draft: ${draftText()}`);
    },
  );

  await check("no client shows the conversation: speak fails with CLIENT_UNAVAILABLE", async () => {
    device.key(3);
    await sleep(3000);
    const before = await sendSpeak(SPEAK_SHORT);
    const result = await speakResult(before, 20_000);
    if (!result.isError || result.details?.error?.code !== "CLIENT_UNAVAILABLE")
      fail(`expected CLIENT_UNAVAILABLE: ${JSON.stringify(result.details)}`);
    if (androidPlaying()) fail("a backgrounded Paseo played speech");
    await settled();
  });

  if (withDesktop) {
    const tapScript = `(() => {
      if (window.top !== window) return;
      const tap = (window.__paseoJudgeAudio = { started: [] });
      const start = AudioBufferSourceNode.prototype.start;
      AudioBufferSourceNode.prototype.start = function (...args) {
        tap.started.push({ at: Date.now(), duration: this.buffer ? this.buffer.duration : 0 });
        return start.apply(this, args);
      };
    })();`;
    const desktopStarts = async (page) =>
      page.evaluate(() => window.__paseoJudgeAudio.started.length);

    const page = await check("desktop app opens the same conversation", async () => {
      const log = openSync(path.join(root, "metro.log"), "w");
      const metro = spawn(
        process.execPath,
        [
          path.join(repository, "node_modules/expo/bin/cli"),
          "start",
          "--web",
          "--port",
          String(metroPort),
          "--offline",
        ],
        {
          cwd: path.join(repository, "packages/app"),
          env: {
            PATH: process.env.PATH ?? "",
            HOME: process.env.HOME ?? "",
            TMPDIR: process.env.TMPDIR ?? "",
            CI: "1",
            BROWSER: "none",
            EXPO_NO_DOTENV: "1",
            PASEO_WEB_PLATFORM: "electron",
            EXPO_PUBLIC_LOCAL_DAEMON: "127.0.0.1:9",
          },
          stdio: ["ignore", log, log],
        },
      );
      closeSync(log);
      cleanups.push(async () => metro.kill("SIGTERM"));
      await waitFor("Metro", async () => (await fetch(`http://127.0.0.1:${metroPort}/status`)).ok, {
        timeout: 120_000,
        interval: 1000,
      });
      const { warmMetro } = await import(
        path.join(repository, "packages/app/e2e/support/metro-warmup.mjs")
      );
      await warmMetro(metroPort);
      const runtime = await makeTemp("paseo-s1-android-desktop-");
      cleanups.push(() => rm(runtime, { recursive: true, force: true }));
      const app = await electron.launch({
        executablePath: path.join(
          repository,
          "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron",
        ),
        args: [path.join(repository, "qa/pi-workspace/electron-quiet.cjs")],
        cwd: repository,
        env: {
          PATH: process.env.PATH ?? "",
          TMPDIR: process.env.TMPDIR ?? "",
          HOME: path.join(runtime, "home"),
          PASEO_HOME: path.join(root, "daemon", "paseo"),
          EXPO_DEV_URL: `http://localhost:${metroPort}`,
          PASEO_DISABLE_SINGLE_INSTANCE_LOCK: "1",
          PASEO_ELECTRON_USER_DATA_DIR: path.join(runtime, "user-data"),
          PASEO_ORACLE_DESKTOP_MAIN: path.join(repository, "packages/desktop/dist/main.js"),
          PASEO_ELECTRON_FLAGS:
            "--lang=en-US --autoplay-policy=no-user-gesture-required --mute-audio --disable-backgrounding-occluded-windows --disable-renderer-backgrounding",
        },
        timeout: 120_000,
      });
      cleanups.push(() => app.close());
      await app.context().addInitScript(tapScript);
      const window = await app.firstWindow({ timeout: 120_000 });
      await window.route(/:(6767|6768)\b/, (route) => route.abort());
      await window.waitForLoadState("domcontentloaded");
      const now = new Date().toISOString();
      const host = {
        serverId: daemon.serverId,
        label: "localhost",
        connections: [
          {
            id: `direct:127.0.0.1:${daemon.port}`,
            type: "directTcp",
            endpoint: `127.0.0.1:${daemon.port}`,
          },
        ],
        preferredConnectionId: `direct:127.0.0.1:${daemon.port}`,
        createdAt: now,
        updatedAt: now,
      };
      await window.evaluate((entry) => {
        localStorage.setItem("@paseo:e2e", "1");
        localStorage.setItem("@paseo:daemon-registry", JSON.stringify([entry]));
        localStorage.removeItem("@paseo:settings");
      }, host);
      await window.goto(
        `http://localhost:${metroPort}/h/${encodeURIComponent(daemon.serverId)}/agent/${encodeURIComponent(agent.id)}`,
      );
      await window.getByTestId("message-input-root").waitFor({ timeout: 90_000 });
      return window;
    });

    await check("Android in the background: speech plays on the desktop only", async () => {
      await page.getByTestId("message-input-root").click();
      await sleep(6000);
      const desktopBefore = await desktopStarts(page);
      const before = await sendSpeak(SPEAK_SHORT);
      let androidHeard = false;
      const result = await waitFor(
        "speak result with the desktop playing",
        async () => {
          if (androidPlaying()) androidHeard = true;
          const results = await speakResults();
          return results.length > before ? results[before] : null;
        },
        { timeout: 90_000, interval: 300 },
      );
      if (result.isError || result.details?.status !== "completed")
        fail(`desktop speak did not complete: ${JSON.stringify(result.details)}`);
      if ((await desktopStarts(page)) === desktopBefore) fail("the desktop played no audio");
      if (androidHeard) fail("the backgrounded Android client played speech");
      await settled();
    });

    await check(
      "conversation shown on desktop and Android: speech plays on exactly one",
      async () => {
        device.start(`${PASEO_PACKAGE}/.MainActivity`);
        await openConversation();
        await sleep(6000);
        const desktopBefore = await desktopStarts(page);
        const before = await sendSpeak(SPEAK_SHORT);
        let androidHeard = false;
        const result = await waitFor(
          "speak result with both clients displaying",
          async () => {
            if (androidPlaying()) androidHeard = true;
            const results = await speakResults();
            return results.length > before ? results[before] : null;
          },
          { timeout: 90_000, interval: 300 },
        );
        if (result.isError || result.details?.status !== "completed")
          fail(`speak with two clients did not complete: ${JSON.stringify(result.details)}`);
        const desktopHeard = (await desktopStarts(page)) > desktopBefore;
        if (desktopHeard === androidHeard)
          fail(
            `speech must play on exactly one client (desktop ${desktopHeard}, Android ${androidHeard})`,
          );
        await settled();
      },
    );
  }
  exitCode = 0;
} catch (error) {
  process.stdout.write(`S1 Android flow stopped: ${error.message}\n`);
} finally {
  for (const cleanup of cleanups.toReversed()) {
    try {
      await cleanup();
    } catch (error) {
      process.stdout.write(`cleanup warning: ${error.message}\n`);
    }
  }
  process.stdout.write(`S1 Android checks passed: ${passed}. Evidence: ${root}\n`);
  process.exitCode = exitCode;
}
