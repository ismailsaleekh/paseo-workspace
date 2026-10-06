#!/usr/bin/env node
// Judge-owned S1 desktop flow: real Pi -> isolated daemon with local speech -> real Electron
// desktop app. Dictation is fed from deterministic `say` WAVs through Chromium's fake microphone;
// playback is observed through an injected WebAudio tap and checked by an independent local
// speech recogniser. --prerequisite only proves the harness reaches existing dictation.
import { execFileSync, spawn } from "node:child_process";
import {
  closeSync,
  existsSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { _electron as electron } from "@playwright/test";
import { connectClient, freePort, sleep, stopChild, waitFor } from "../android/lib.mjs";

const repository = process.cwd();
const prerequisiteOnly = process.argv.includes("--prerequisite");
const cache = path.join(homedir(), ".cache", "pi-paseo-workspace");
const models = path.join(cache, "speech-models/local-speech");
const TOOLS =
  "visual_present,visual_update,visual_act,visual_inspect,visual_list,speak,branch_open,branch_return,hello";

function fail(message) {
  throw new Error(message);
}
let passed = 0;
async function check(label, body) {
  process.stdout.write(`S1 CHECK ${label}\n`);
  try {
    const value = await body();
    passed += 1;
    process.stdout.write(`S1 PASS ${label}\n`);
    return value;
  } catch (error) {
    process.stdout.write(`S1 FAIL ${label}: ${error.stack ?? error.message}\n`);
    throw error;
  }
}

// ---------- text comparison ----------
function words(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9' ]+/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}
/** Phrase containment on normalised words, so engine punctuation ("No, wait,") never matters. */
function hasPhrase(text, phrase) {
  return ` ${words(text).join(" ")} `.includes(` ${words(phrase).join(" ")} `);
}
function wordErrorRate(reference, hypothesis) {
  const r = words(reference);
  const h = words(hypothesis);
  const row = Array.from({ length: h.length + 1 }, (_, index) => index);
  for (let i = 1; i <= r.length; i += 1) {
    let previous = row[0];
    row[0] = i;
    for (let j = 1; j <= h.length; j += 1) {
      const current = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, previous + (r[i - 1] === h[j - 1] ? 0 : 1));
      previous = current;
    }
  }
  if (r.length === 0) return h.length === 0 ? 0 : 1;
  return row[h.length] / r.length;
}

// ---------- fixtures ----------
const root = await mkdtemp(path.join(tmpdir(), "paseo-s1-judge-"));
process.stdout.write(`S1 evidence directory: ${root}\n`);
const SHORT_TEXT =
  "Please keep exactly these words. Forty two blue cubes, no wait, forty three blue cubes.";
const LONG_SENTENCES = [
  "This is a long dictation about a slow walk along the northern harbour.",
  "The morning was grey and the water moved in small patient waves against the stone.",
  "A fisherman was mending a green net while two gulls argued over a crust of bread.",
  "Further along the quay a bakery opened its shutters and the smell of cinnamon drifted out.",
  "I stopped to read an old sign about the ferries that used to cross to the island.",
  "The sign explained that the crossing took most of an hour in calm weather.",
  "In winter the boats sometimes waited for days until the storms had passed.",
  "Children used to wave from the deck while their parents counted the cargo.",
  "Now the pier is quiet and only a few tourists photograph the rusted bollards.",
  "I walked past the lifeboat station where volunteers were painting the doors.",
  "One of them told me the station had been rebuilt after a fire many years ago.",
  "She said the new roof was made of copper that would turn green with time.",
  "At the end of the harbour there is a small museum with model ships in glass cases.",
  "The curator showed me a map drawn by hand with every rock and channel marked.",
  "He explained that sailors trusted these maps more than any printed chart.",
  "After the museum I climbed the hill behind the town to see the whole bay.",
  "From the top the boats looked like toys and the houses like a row of sugar cubes.",
  "The wind was stronger there and it carried the sound of a church bell.",
  "I sat on a bench for a while and watched the clouds open over the sea.",
  "A narrow band of sunlight crossed the water and lit the far cliffs.",
  "Walking down again I passed a garden full of late roses and tall sunflowers.",
  "An old dog followed me for a few minutes before turning back to its gate.",
  "By the time I reached the harbour the tide had come in and covered the steps.",
  "The fishermen were loading crates of crabs onto a blue van.",
  "I bought a coffee and a warm roll from the bakery and ate it by the water.",
  "It was the kind of quiet morning that makes the rest of the week feel easier.",
  "Before leaving I wrote a few notes about the ferries and the hand drawn map.",
  "In the afternoon I took the coastal path toward the next village.",
  "The path followed the edge of the cliffs and dipped into small sheltered coves.",
  "In one cove a family was building a sandcastle with towers and a moat.",
  "The youngest child kept running to the waves with a bucket and running back.",
  "Further on the path climbed through a field of sheep that ignored me completely.",
  "A wooden stile led into a wood of twisted oaks bent by years of wind.",
  "Under the trees it was suddenly quiet and the air smelled of moss and rain.",
  "I found a stream and followed it down to a stone bridge covered in ivy.",
  "On the bridge a man was painting a watercolour of the valley below.",
  "He said he came every Thursday and had painted the same view for ten summers.",
  "Each picture was different because the light was never quite the same.",
  "We talked about the weather and about the best place to buy honey nearby.",
  "He recommended a farm shop at the top of the lane with a red door.",
  "The shop was run by an elderly couple who kept bees behind the barn.",
  "They sold jars of heather honey, fresh eggs and loaves of brown bread.",
  "I bought a small jar and a postcard showing the village in the snow.",
  "From the farm the lane wound down past cottages with slate roofs.",
  "Smoke rose from a few chimneys even though the day was not cold.",
  "At the village square a market was packing away its last stalls.",
  "A woman was folding tablecloths embroidered with blue and yellow flowers.",
  "Children chased pigeons around a fountain that no longer had any water.",
  "I rested on the church steps and watched the shadows grow longer.",
  "The bus back to the harbour came every hour and the next one was due soon.",
  "While waiting I wrote down the names of the coves and the farm with the red door.",
  "The bus was almost empty and the driver hummed along to the radio.",
  "Through the window the sea looked darker now and the first lights came on.",
  "By the time we reached the harbour the bakery was closing for the evening.",
  "I walked once more along the quay and listened to the halyards ringing on the masts.",
  "My final words for this dictation are purple lighthouse and silver anchor.",
];
const LONG_TEXT = LONG_SENTENCES.join(" ");
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

function synthesize(name, text) {
  const file = path.join(root, `${name}.wav`);
  execFileSync("/usr/bin/say", ["-v", "Samantha", "-o", file, "--data-format=LEI16@16000", text]);
  return file;
}
function referenceTranscript(wavOrPcm) {
  const out = execFileSync(
    process.execPath,
    [path.join(repository, "qa/pi-workspace/s1/stt-reference.cjs"), ...wavOrPcm],
    {
      cwd: repository,
      encoding: "utf8",
      maxBuffer: 16 << 20,
    },
  );
  return JSON.parse(out.trim().split("\n").at(-1)).text;
}

// ---------- daemon ----------
const paseoHome = path.join(root, "paseo");
const home = path.join(root, "home");
const piDir = path.join(root, "pi");
const trace = path.join(root, "model.jsonl");
const busyMarker = path.join(root, "busy");
for (const dir of [paseoHome, home, piDir]) await mkdir(dir, { recursive: true });
const port = await freePort();
const metroPort = await freePort([port]);
writeFileSync(
  path.join(paseoHome, "config.json"),
  `${JSON.stringify({
    version: 1,
    daemon: { mcp: { enabled: false } },
    agents: {
      providers: {
        claude: { enabled: false },
        codex: { enabled: false },
        copilot: { enabled: false },
        opencode: { enabled: false },
        omp: { enabled: false },
        pi: {
          enabled: true,
          env: {
            HOME: home,
            PI_CODING_AGENT_DIR: piDir,
            PI_WORKSPACE_ORACLE_TRACE: trace,
            PI_WORKSPACE_S1_BUSY_MARKER: busyMarker,
          },
          command: [
            "/usr/local/bin/pi",
            "--no-extensions",
            "--no-skills",
            "--no-prompt-templates",
            "--no-context-files",
            "--offline",
            "--tools",
            TOOLS,
            "-e",
            path.join(repository, "packages/pi-workspace/extensions/workspace.ts"),
            "-e",
            path.join(repository, "qa/pi-workspace/scripted-provider.mjs"),
            "-e",
            path.join(repository, "qa/pi-workspace/fixtures/s1-busy.mjs"),
          ],
        },
      },
    },
  })}\n`,
);

const cleanups = [];
let exitCode = 1;
try {
  if (!existsSync(path.join(models, "kokoro-en-v0_19/model.onnx"))) {
    fail(`HARNESS_PREPARATION_FAILED: task speech model cache missing at ${models}`);
  }
  const daemonLog = openSync(path.join(root, "daemon.log"), "w");
  const daemon = spawn(
    process.execPath,
    [
      path.join(repository, "node_modules/tsx/dist/cli.mjs"),
      "scripts/supervisor-entrypoint.ts",
      "--dev",
    ],
    {
      cwd: path.join(repository, "packages/server"),
      env: {
        PATH: process.env.PATH ?? "",
        HOME: home,
        TMPDIR: process.env.TMPDIR ?? tmpdir(),
        LANG: "en_US.UTF-8",
        PI_OFFLINE: "1",
        PI_TELEMETRY: "0",
        PI_SKIP_VERSION_CHECK: "1",
        PASEO_HOME: paseoHome,
        PASEO_SERVER_ID: `srv_s1_judge_${port}`,
        PASEO_LISTEN: `127.0.0.1:${port}`,
        PASEO_CORS_ORIGINS: `http://localhost:${metroPort}`,
        PASEO_RELAY_ENABLED: "0",
        PASEO_DICTATION_ENABLED: "1",
        PASEO_DICTATION_STT_PROVIDER: "local",
        PASEO_VOICE_MODE_ENABLED: "0",
        PASEO_VOICE_TTS_PROVIDER: "local",
        PASEO_LOCAL_MODELS_DIR: models,
        PASEO_LOCAL_SPEECH_AUTO_DOWNLOAD: "0",
        PASEO_NODE_ENV: "development",
        NODE_ENV: "development",
      },
      stdio: ["ignore", daemonLog, daemonLog],
    },
  );
  closeSync(daemonLog);
  cleanups.push(() => stopChild(daemon, "S1 daemon"));
  const status = await waitFor(
    "isolated speech daemon",
    async () => {
      if (daemon.exitCode !== null) fail("daemon exited");
      const response = await fetch(`http://127.0.0.1:${port}/api/status`);
      return response.ok ? response.json() : null;
    },
    { timeout: 90_000, interval: 1000 },
  );
  const client = await connectClient(port);
  cleanups.push(() => client.close());
  const cwd = await mkdtemp(path.join(tmpdir(), "paseo-s1-project-"));
  const expectedCwd = await realpath(cwd);
  cleanups.push(() => rm(cwd, { recursive: true, force: true }));
  const created = await client.createWorkspace({
    source: { kind: "directory", path: cwd },
    title: "S1 judge",
  });
  if (!created.workspace) fail(created.error ?? "workspace creation failed");
  const agent = await client.createAgent({
    provider: "pi",
    model: "pi-workspace-oracle/scripted",
    thinkingOptionId: "off",
    cwd,
    workspaceId: created.workspace.id,
    title: "S1 voice",
  });

  // Pi writes the session file with the first prompt; before the judge prompts, no entry exists.
  let prompted = false;
  function sessionEntries() {
    if (!prompted) return [];
    const sessionRoot = path.join(piDir, "sessions");
    for (const relative of readdirSync(sessionRoot, { recursive: true })) {
      if (!String(relative).endsWith(".jsonl")) continue;
      const lines = readFileSync(path.join(sessionRoot, String(relative)), "utf8")
        .trim()
        .split("\n");
      const header = JSON.parse(lines[0]);
      if (header.cwd === cwd || header.cwd === expectedCwd)
        return lines.slice(1).map((line) => JSON.parse(line));
    }
    fail("Pi session not found");
  }
  function toolResults(name) {
    return sessionEntries()
      .filter(
        (entry) =>
          entry.type === "message" &&
          entry.message?.role === "toolResult" &&
          entry.message.toolName === name,
      )
      .map((entry) => entry.message);
  }
  function requests() {
    return existsSync(trace)
      ? readFileSync(trace, "utf8")
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line))
      : [];
  }
  function userTexts() {
    return sessionEntries()
      .filter((entry) => entry.type === "message" && entry.message?.role === "user")
      .map((entry) => {
        const content = entry.message.content;
        return typeof content === "string"
          ? content
          : content.map((part) => part.text ?? "").join(" ");
      });
  }

  // ---------- Metro + Electron ----------
  const metroLog = openSync(path.join(root, "metro.log"), "w");
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
      stdio: ["ignore", metroLog, metroLog],
    },
  );
  closeSync(metroLog);
  cleanups.push(() => stopChild(metro, "Metro"));
  await waitFor("Metro", async () => (await fetch(`http://127.0.0.1:${metroPort}/status`)).ok, {
    timeout: 120_000,
    interval: 1000,
  });
  const { warmMetro } = await import(
    path.join(repository, "packages/app/e2e/support/metro-warmup.mjs")
  );
  await warmMetro(metroPort);

  const tapScript = `(() => {
    if (window.top !== window) return;
    const tap = (window.__paseoJudgeAudio = { started: [], stops: [], ended: [], suspends: [] });
    const start = AudioBufferSourceNode.prototype.start;
    AudioBufferSourceNode.prototype.start = function (...args) {
      const buffer = this.buffer;
      const entry = { at: Date.now(), duration: buffer ? buffer.duration : 0, sampleRate: buffer ? buffer.sampleRate : 0, samples: buffer ? buffer.getChannelData(0).slice() : null };
      tap.started.push(entry);
      this.addEventListener("ended", () => tap.ended.push(Date.now()));
      return start.apply(this, args);
    };
    const stop = AudioBufferSourceNode.prototype.stop;
    AudioBufferSourceNode.prototype.stop = function (...args) { tap.stops.push(Date.now()); return stop.apply(this, args); };
    for (const name of ["suspend", "close"]) {
      const original = AudioContext.prototype[name];
      AudioContext.prototype[name] = function (...args) { tap.suspends.push({ name, at: Date.now() }); return original.apply(this, args); };
    }
  })();`;

  let desktop = null;
  async function launchDesktop(wav) {
    if (desktop) {
      await desktop.app.close();
      desktop = null;
    }
    const runtime = await mkdtemp(path.join(root, "desktop-"));
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
        PASEO_HOME: paseoHome,
        EXPO_DEV_URL: `http://localhost:${metroPort}`,
        PASEO_DISABLE_SINGLE_INSTANCE_LOCK: "1",
        PASEO_ELECTRON_USER_DATA_DIR: path.join(runtime, "user-data"),
        PASEO_ORACLE_DESKTOP_MAIN: path.join(repository, "packages/desktop/dist/main.js"),
        // Test-harness switches: stable English labels and a file-backed fake microphone (the
        // macOS audio service sandbox cannot read the fixture file unless it is relaxed); output is
        // muted at the device so judge runs stay silent while WebAudio still renders and is tapped.
        // The judge window opens unfocused behind the operator's windows: occlusion must not mark it
        // hidden (Chromium's testing switches), or presence would depend on the desktop layout.
        PASEO_ELECTRON_FLAGS: `--lang=en-US --disable-features=AudioServiceSandbox --use-fake-ui-for-media-stream --use-fake-device-for-media-stream --use-file-for-fake-audio-capture=${wav}%noloop --autoplay-policy=no-user-gesture-required --mute-audio --disable-backgrounding-occluded-windows --disable-renderer-backgrounding`,
      },
      timeout: 120_000,
    });
    await app.context().addInitScript(tapScript);
    const page = await app.firstWindow({ timeout: 120_000 });
    await page.route(/:(6767|6768)\b/, (route) => route.abort());
    await page.waitForLoadState("domcontentloaded");
    const now = new Date().toISOString();
    const host = {
      serverId: status.serverId,
      label: "localhost",
      connections: [
        { id: `direct:127.0.0.1:${port}`, type: "directTcp", endpoint: `127.0.0.1:${port}` },
      ],
      preferredConnectionId: `direct:127.0.0.1:${port}`,
      createdAt: now,
      updatedAt: now,
    };
    await page.evaluate((entry) => {
      localStorage.setItem("@paseo:e2e", "1");
      localStorage.setItem("@paseo:daemon-registry", JSON.stringify([entry]));
      localStorage.removeItem("@paseo:settings");
    }, host);
    await page.goto(
      `http://localhost:${metroPort}/h/${encodeURIComponent(status.serverId)}/agent/${encodeURIComponent(agent.id)}`,
    );
    await page.getByTestId("message-input-root").waitFor({ timeout: 90_000 });
    desktop = { app, page };
    return desktop;
  }
  cleanups.push(async () => desktop?.app.close());

  const composer = () =>
    desktop.page.getByTestId("message-input-root").getByRole("textbox").first();
  async function composerValue() {
    return composer().inputValue();
  }
  async function dictate({ byTestId, seconds }) {
    const page = desktop.page;
    if (byTestId) await page.getByTestId("dictation-toggle").click({ timeout: 15_000 });
    else
      await page
        .getByRole("button", { name: "Start dictation", exact: true })
        .click({ timeout: 15_000 });
    await sleep(seconds * 1000);
    const before = await composerValue();
    if (byTestId) await page.getByTestId("dictation-insert").click({ timeout: 15_000 });
    else
      await page
        .getByRole("button", { name: "Insert transcription", exact: true })
        .first()
        .click({ timeout: 15_000 });
    return waitFor(
      "dictated text in the composer",
      async () => {
        const value = await composerValue();
        return value !== before ? value : null;
      },
      { timeout: 60_000, interval: 500 },
    );
  }
  async function tap() {
    return desktop.page.evaluate(() => {
      const t = window.__paseoJudgeAudio;
      return {
        started: t.started.map(({ at, duration, sampleRate }) => ({ at, duration, sampleRate })),
        stops: t.stops,
        ended: t.ended,
        suspends: t.suspends,
      };
    });
  }
  async function tappedPcm(fromIndex) {
    const { base64, sampleRate } = await desktop.page.evaluate((index) => {
      const entries = window.__paseoJudgeAudio.started
        .slice(index)
        .filter((entry) => entry.samples);
      const rate = entries[0]?.sampleRate ?? 0;
      const total = entries.reduce((sum, entry) => sum + entry.samples.length, 0);
      const joined = new Float32Array(total);
      let offset = 0;
      for (const entry of entries) {
        joined.set(entry.samples, offset);
        offset += entry.samples.length;
      }
      let binary = "";
      const bytes = new Uint8Array(joined.buffer);
      for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
      return { base64: btoa(binary), sampleRate: rate };
    }, fromIndex);
    const file = path.join(root, `pcm-${Date.now()}.b64`);
    writeFileSync(file, base64);
    return { file, sampleRate };
  }
  async function speak(text) {
    prompted = true;
    await client.sendAgentMessage(
      agent.id,
      `oracle-call:${JSON.stringify({ name: "speak", arguments: { text } })}`,
    );
  }

  const shortWav = synthesize("short", SHORT_TEXT);
  await launchDesktop(shortWav);

  await check(
    "prerequisite: existing desktop dictation inserts fake-microphone speech",
    async () => {
      await composer().fill("prerequisite ");
      const value = await dictate({ byTestId: false, seconds: 10 });
      if (!hasPhrase(value, "blue cubes")) fail(`unexpected dictation result: ${value}`);
      await composer().fill("");
    },
  );

  if (prerequisiteOnly) {
    exitCode = 0;
  } else {
    const shortReference = referenceTranscript([shortWav]);

    await check("faithful dictation mixed with typing (stable test ids)", async () => {
      await composer().fill("typed before ");
      const value = await dictate({ byTestId: true, seconds: 10 });
      await composer().press("End");
      await composer().pressSequentially(" typed after");
      const final = await composerValue();
      if (!final.startsWith("typed before ")) fail(`typed prefix lost: ${final}`);
      if (!final.endsWith(" typed after")) fail(`typed suffix lost: ${final}`);
      const dictated = value.slice("typed before ".length);
      const wer = wordErrorRate(shortReference, dictated);
      if (wer > 0.1)
        fail(
          `dictation differs from the engine reference (WER ${wer.toFixed(2)}): ${dictated} vs ${shortReference}`,
        );
      if (!hasPhrase(dictated, "no wait")) fail("the spoken correction was not kept");
      await composer().fill("");
    });

    await check(
      "speak plays the exact text on the active desktop and completes after playback",
      async () => {
        await composer().fill("draft stays put");
        const before = (await tap()).started.length;
        const calls = toolResults("speak").length;
        await speak(SPEAK_SHORT);
        const finish = await client.waitForFinish(agent.id, 90_000);
        if (finish.status !== "idle") fail(`agent finished ${finish.status}`);
        const results = toolResults("speak");
        if (results.length !== calls + 1) fail("speak result missing");
        const result = results.at(-1);
        if (result.isError || result.details?.status !== "completed")
          fail(`speak did not complete: ${JSON.stringify(result.details)}`);
        const observed = await tap();
        const played = observed.started.slice(before);
        if (played.length === 0) fail("no audio buffers were started by the client");
        const seconds = played.reduce((sum, entry) => sum + entry.duration, 0);
        if (seconds < 2) fail(`played only ${seconds.toFixed(2)} s of audio`);
        const { file, sampleRate } = await tappedPcm(before);
        const heard = referenceTranscript(["--pcm", String(sampleRate), file]);
        const wer = wordErrorRate(SPEAK_SHORT, heard);
        if (wer > 0.25 || !hasPhrase(heard, "zebra") || !hasPhrase(heard, "telescope"))
          fail(`played audio does not say the supplied text (WER ${wer.toFixed(2)}): ${heard}`);
        if ((await composerValue()) !== "draft stays put")
          fail("speech changed the composer draft");
      },
    );

    await check("stop playback is immediate and never cancels the agent or the draft", async () => {
      const before = (await tap()).started.length;
      const calls = toolResults("speak").length;
      await speak(SPEAK_LONG);
      await waitFor("long utterance playing", async () => (await tap()).started.length > before, {
        timeout: 30_000,
        interval: 200,
      });
      await sleep(1500);
      const clickedAt = Date.now();
      await desktop.page.getByTestId("speech-stop").click({ timeout: 5000 });
      const result = await waitFor(
        "stopped speak result",
        () => (toolResults("speak").length === calls + 1 ? toolResults("speak").at(-1) : null),
        { timeout: 10_000, interval: 100 },
      );
      if (result.isError || result.details?.status !== "stopped")
        fail(`speak not reported stopped: ${JSON.stringify(result.details)}`);
      const observed = await tap();
      const silencedAt = Math.min(
        ...observed.stops.filter((at) => at >= clickedAt),
        ...observed.suspends.filter((s) => s.at >= clickedAt).map((s) => s.at),
      );
      if (!Number.isFinite(silencedAt) || silencedAt - clickedAt > 300)
        fail(`audio not silenced within 300 ms (${silencedAt - clickedAt} ms)`);
      const startsAfter = observed.started.filter((entry) => entry.at > clickedAt + 50).length;
      await sleep(3000);
      if ((await tap()).started.filter((entry) => entry.at > clickedAt + 50).length > startsAfter)
        fail("late audio started after stop");
      const finish = await client.waitForFinish(agent.id, 30_000);
      if (finish.status !== "idle") fail(`agent run was disturbed: ${finish.status}`);
      if ((await composerValue()) !== "draft stays put") fail("stop changed the composer draft");
    });

    await check("microphone and playback are independent", async () => {
      const before = (await tap()).started.length;
      await speak(SPEAK_LONG);
      await waitFor("utterance playing", async () => (await tap()).started.length > before, {
        timeout: 30_000,
        interval: 200,
      });
      const stopsBefore = (await tap()).stops.length;
      await desktop.page.getByTestId("dictation-toggle").click({ timeout: 10_000 });
      await sleep(2000);
      if ((await tap()).stops.length !== stopsBefore)
        fail("starting dictation stopped speech playback");
      await desktop.page.getByTestId("speech-stop").click({ timeout: 5000 });
      await sleep(1000);
      if (!(await desktop.page.getByTestId("dictation-insert").isVisible()))
        fail("stopping playback stopped dictation");
      await desktop.page.getByTestId("dictation-cancel").click({ timeout: 5000 });
      await client.waitForFinish(agent.id, 30_000);
      await composer().fill("");
    });

    await check("dictated input while the agent is busy is queued and delivered once", async () => {
      writeFileSync(busyMarker, "busy");
      prompted = true;
      await client.sendAgentMessage(
        agent.id,
        `oracle-call:${JSON.stringify({ name: "hello", arguments: {} })}`,
      );
      await waitFor(
        "busy tool running",
        () =>
          requests().some((request) => JSON.stringify(request.response).includes('"name":"hello"')),
        { timeout: 30_000, interval: 300 },
      );
      const dictated = await dictate({ byTestId: true, seconds: 10 });
      await composer().press(process.platform === "darwin" ? "Meta+Enter" : "Control+Enter");
      await sleep(1000);
      rmSync(busyMarker, { force: true });
      await waitFor(
        "queued dictation delivered",
        () => userTexts().some((text) => hasPhrase(text, "blue cubes")),
        { timeout: 60_000, interval: 500 },
      );
      const finish = await client.waitForFinish(agent.id, 60_000);
      if (finish.status !== "idle") fail(`agent finished ${finish.status}`);
      const delivered = userTexts().filter((text) => hasPhrase(text, "blue cubes"));
      if (delivered.length !== 1) fail(`dictated input delivered ${delivered.length} times`);
      if (wordErrorRate(dictated, delivered[0]) > 0.05)
        fail("delivered text differs from the composer text");
      if (!toolResults("hello").some((result) => !result.isError))
        fail("the busy tool was interrupted");
    });

    const longWav = synthesize("long", LONG_TEXT);
    const longReference = referenceTranscript([longWav]);
    const longSeconds = Number(
      execFileSync("/usr/bin/afinfo", [longWav], { encoding: "utf8" }).match(
        /estimated duration: ([0-9.]+)/,
      )[1],
    );
    await launchDesktop(longWav);

    await check("long dictation (minutes) arrives complete and faithful", async () => {
      if (longSeconds < 180) fail(`long fixture too short (${longSeconds}s)`);
      await composer().fill("");
      const value = await dictate({ byTestId: true, seconds: Math.ceil(longSeconds) + 6 });
      const wer = wordErrorRate(longReference, value);
      if (wer > 0.08)
        fail(`long dictation differs from the engine reference (WER ${wer.toFixed(3)})`);
      if (!hasPhrase(value, "purple lighthouse") || !hasPhrase(value, "silver anchor"))
        fail("the end of the long dictation is missing");
      if (!(hasPhrase(value, "northern harbour") || hasPhrase(value, "northern harbor")))
        fail("the start of the long dictation is missing");
    });
    exitCode = 0;
  }
} catch (error) {
  process.stdout.write(`S1 flow stopped: ${error.message}\n`);
} finally {
  for (const cleanup of cleanups.toReversed()) {
    try {
      await cleanup();
    } catch (error) {
      process.stdout.write(`cleanup warning: ${error.message}\n`);
    }
  }
  process.stdout.write(`S1 checks passed: ${passed}. Evidence: ${root}\n`);
  process.exitCode = exitCode;
}
