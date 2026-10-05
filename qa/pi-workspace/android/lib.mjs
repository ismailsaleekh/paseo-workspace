// Judge-owned Android helpers for the V2-A oracle. Private toolchain, dedicated judge AVD,
// isolated daemon, adb/uiautomator driving and independent pixel decoding. No product code.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createSocket } from "node:dgram";
import {
  existsSync,
  readdirSync,
  readFileSync,
  openSync,
  closeSync,
  writeFileSync,
  rmSync,
  mkdirSync,
} from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import sharp from "sharp";
import { WebSocket } from "ws";

export const repository = process.cwd();
export const cache = path.join(homedir(), ".cache", "pi-paseo-workspace");
const sdk = path.join(cache, "android-sdk");
export const tools = {
  javaHome: path.join(cache, "jdk-17/Contents/Home"),
  sdk,
  adb: path.join(sdk, "platform-tools/adb"),
  emulator: path.join(sdk, "emulator/emulator"),
  avdmanager: path.join(sdk, "cmdline-tools/latest/bin/avdmanager"),
  aapt2: path.join(sdk, "build-tools/36.0.0/aapt2"),
  apksigner: path.join(sdk, "build-tools/36.0.0/apksigner"),
  systemImage: "system-images;android-36;google_apis;arm64-v8a",
  avdHome: path.join(cache, "android-avd-judge"),
  avd: "pi-paseo-judge",
  gradleUserHome: path.join(cache, "gradle"),
};
/**
 * Judge-owned no-idle UI dumper (`no-idle-dump/NoIdleDump.java`), compiled offline with the private
 * JDK 17 and d8 into a cache keyed by the source hash.
 */
let noIdleDumperJar = null;
function noIdleDumper() {
  if (noIdleDumperJar) return noIdleDumperJar;
  const source = path.join(repository, "qa/pi-workspace/android/no-idle-dump/NoIdleDump.java");
  const digest = createHash("sha256").update(readFileSync(source)).digest("hex").slice(0, 16);
  const outDir = path.join(cache, "judge-tools", `no-idle-dump-${digest}`);
  const jar = path.join(outDir, "no-idle-dump.jar");
  if (!existsSync(jar)) {
    const androidJar = path.join(sdk, "platforms/android-36/android.jar");
    const classes = path.join(outDir, "classes");
    mkdirSync(classes, { recursive: true });
    execFileSync(
      path.join(tools.javaHome, "bin/javac"),
      ["--release", "8", "-nowarn", "-cp", androidJar, "-d", classes, source],
      { env: androidEnv(), stdio: ["ignore", "ignore", "pipe"] },
    );
    execFileSync(
      path.join(sdk, "build-tools/36.0.0/d8"),
      [
        "--release",
        "--min-api",
        "30",
        "--lib",
        androidJar,
        "--output",
        jar,
        path.join(classes, "NoIdleDump.class"),
      ],
      { env: androidEnv(), stdio: ["ignore", "ignore", "pipe"] },
    );
  }
  noIdleDumperJar = jar;
  return jar;
}

export const PASEO_PACKAGE = "sh.paseo.debug";
export const COMPANION_PACKAGE = "sh.paseo.debug.visualhost";
export const SINK_HOST_FROM_EMULATOR = "10.0.2.2";

export function fail(message) {
  throw new Error(message);
}
export function preparationFailure(message) {
  return new Error(`HARNESS_PREPARATION_FAILED: ${message}`);
}

export function cachedGradle() {
  const dists = path.join(tools.gradleUserHome, "wrapper/dists/gradle-8.14.3-bin");
  if (!existsSync(dists))
    throw preparationFailure(`cached Gradle 8.14.3 distribution missing in ${dists}`);
  for (const entry of readdirSync(dists)) {
    const candidate = path.join(dists, entry, "gradle-8.14.3/bin/gradle");
    if (existsSync(candidate)) return candidate;
  }
  throw preparationFailure("cached Gradle 8.14.3 binary missing");
}

export function androidEnv(extra = {}) {
  const home = path.join(cache, "native-build-home");
  const tmp = path.join(cache, "native-tmp");
  return {
    PATH: `${tools.javaHome}/bin:${path.dirname(tools.adb)}:${process.env.PATH ?? ""}`,
    JAVA_HOME: tools.javaHome,
    ANDROID_HOME: sdk,
    ANDROID_SDK_ROOT: sdk,
    ANDROID_USER_HOME: path.join(cache, "android-user"),
    ANDROID_AVD_HOME: tools.avdHome,
    ANDROID_EMULATOR_HOME: path.join(cache, "android-user"),
    GRADLE_USER_HOME: tools.gradleUserHome,
    HOME: home,
    TMPDIR: tmp,
    LANG: "en_US.UTF-8",
    LC_ALL: "en_US.UTF-8",
    ...extra,
  };
}

export function requireToolchain() {
  for (const [name, file] of Object.entries({
    java: path.join(tools.javaHome, "bin/java"),
    adb: tools.adb,
    emulator: tools.emulator,
    avdmanager: tools.avdmanager,
    aapt2: tools.aapt2,
    apksigner: tools.apksigner,
    platform: path.join(sdk, "platforms/android-36/android.jar"),
    image: path.join(sdk, "system-images/android-36/google_apis/arm64-v8a/system.img"),
  })) {
    if (!existsSync(file))
      throw preparationFailure(`private Android toolchain is missing ${name}: ${file}`);
  }
  cachedGradle();
}

export function ensureJudgeAvd() {
  const ini = path.join(tools.avdHome, `${tools.avd}.ini`);
  if (existsSync(ini)) return;
  // avdmanager silently falls back to ANDROID_USER_HOME/avd when ANDROID_AVD_HOME is missing.
  mkdirSync(tools.avdHome, { recursive: true });
  const env = androidEnv();
  execFileSync(
    tools.avdmanager,
    ["create", "avd", "-n", tools.avd, "-k", tools.systemImage, "-d", "pixel_7", "--force"],
    {
      env,
      input: "no\n",
      stdio: ["pipe", "ignore", "pipe"],
    },
  );
  const config = path.join(tools.avdHome, `${tools.avd}.avd/config.ini`);
  if (!existsSync(config))
    throw preparationFailure(`judge AVD was not created in ${tools.avdHome}`);
  const lines = execFileSync("cat", [config], { encoding: "utf8" })
    .split("\n")
    .filter(
      (line) =>
        !/^(hw\.ramSize|hw\.cpu\.ncore|hw\.gpu\.enabled|hw\.gpu\.mode|hw\.keyboard|disk\.dataPartition\.size)=/.test(
          line,
        ),
    );
  lines.push(
    "hw.ramSize=4096",
    "hw.cpu.ncore=4",
    "hw.gpu.enabled=yes",
    "hw.gpu.mode=swiftshader_indirect",
    "hw.keyboard=yes",
    "disk.dataPartition.size=8G",
  );
  writeFileSync(config, `${lines.filter(Boolean).join("\n")}\n`);
}

export async function freePort(exclude = []) {
  for (;;) {
    const port = await new Promise((resolve, reject) => {
      const server = createServer();
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        server.close(() => resolve(typeof address === "object" && address ? address.port : 0));
      });
    });
    if (port && port !== 6767 && port !== 6768 && !exclude.includes(port)) return port;
  }
}

async function portInUse(port) {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(true));
    server.listen(port, "127.0.0.1", () => server.close(() => resolve(false)));
  });
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function waitFor(label, probe, { timeout = 30_000, interval = 500 } = {}) {
  const started = Date.now();
  let last;
  for (;;) {
    try {
      const value = await probe();
      if (value) return value;
    } catch (error) {
      last = error;
    }
    if (Date.now() - started > timeout) {
      throw new Error(
        `${label} not satisfied within ${timeout} ms${last ? `: ${last.message}` : ""}`,
      );
    }
    await sleep(interval);
  }
}

/** Boots a fresh judge emulator (wiped data, no snapshot) and returns a Device. */
export async function startEmulator(logDir) {
  ensureJudgeAvd();
  const lock = path.join(tools.avdHome, "judge.lock");
  try {
    closeSync(openSync(lock, "wx"));
  } catch {
    throw preparationFailure(`judge AVD is in use (${lock}); remove it only if no judge runs`);
  }
  let consolePort = 5600;
  while (
    consolePort < 5680 &&
    ((await portInUse(consolePort)) || (await portInUse(consolePort + 1)))
  )
    consolePort += 2;
  if (consolePort >= 5680) throw preparationFailure("no free emulator console port");
  const serial = `emulator-${consolePort}`;
  const logPath = path.join(logDir, "emulator.log");
  const log = openSync(logPath, "w");
  const child = spawn(
    tools.emulator,
    [
      "-avd",
      tools.avd,
      "-no-window",
      "-no-audio",
      "-no-boot-anim",
      "-no-snapshot",
      "-wipe-data",
      "-port",
      String(consolePort),
      "-gpu",
      "swiftshader_indirect",
      "-netdelay",
      "none",
      "-netspeed",
      "full",
    ],
    { env: androidEnv(), stdio: ["ignore", log, log] },
  );
  closeSync(log);
  const device = new Device(serial);
  const close = async () => {
    spawnSync(tools.adb, ["-s", serial, "emu", "kill"], { env: androidEnv(), timeout: 15_000 });
    await Promise.race([new Promise((resolve) => child.once("exit", resolve)), sleep(20_000)]);
    if (child.exitCode === null) child.kill("SIGKILL");
    rmSync(lock, { force: true });
  };
  try {
    await waitFor(
      "emulator boot",
      () => device.tryShell(["getprop", "sys.boot_completed"]) === "1",
      { timeout: 300_000, interval: 2000 },
    );
    for (const setting of [
      "window_animation_scale",
      "transition_animation_scale",
      "animator_duration_scale",
    ]) {
      device.shell(["settings", "put", "global", setting, "0"]);
    }
    device.shell(["settings", "put", "secure", "show_ime_with_hard_keyboard", "0"]);
    device.shell(["settings", "put", "global", "package_verifier_enable", "0"]);
    device.shell(["settings", "put", "global", "verifier_verify_adb_installs", "0"]);
    // A wiped first boot keeps the system busy for a while; let it settle before timing the app.
    await sleep(20_000);
  } catch (error) {
    await close();
    throw preparationFailure(`emulator did not boot (${logPath}): ${error.message}`);
  }
  return { device, close };
}

export class Device {
  constructor(serial) {
    this.serial = serial;
    /** "App isn't responding" dialogs dismissed with Wait; the flow decides which phases allow them. */
    this.anrCount = 0;
  }
  /** Dismisses a system ANR dialog by choosing Wait (never Close), counting it. */
  handleAnr(nodes) {
    const wait = nodes.find((node) => node.id === "android:id/aerr_wait" && node.bounds);
    if (!wait) return false;
    const title = nodes.find((node) => node.id === "android:id/alertTitle")?.text ?? "unknown app";
    this.anrCount += 1;
    process.stdout.write(`ANR dialog (${title}) dismissed with Wait; count ${this.anrCount}\n`);
    const [x1, y1, x2, y2] = wait.bounds;
    this.tap((x1 + x2) / 2, (y1 + y2) / 2);
    return true;
  }
  run(args, options = {}) {
    return execFileSync(tools.adb, ["-s", this.serial, ...args], {
      env: androidEnv(),
      encoding: options.encoding ?? "utf8",
      maxBuffer: 64 << 20,
      timeout: options.timeout ?? 60_000,
    });
  }
  shell(args) {
    return this.run(["shell", ...args])
      .replace(/\r/g, "")
      .trim();
  }
  tryShell(args) {
    try {
      return this.shell(args);
    } catch {
      return null;
    }
  }
  install(apk) {
    const out = this.run(["install", "-r", "-g", apk], { timeout: 300_000 });
    if (!out.includes("Success")) fail(`install failed for ${apk}: ${out}`);
  }
  uninstall(pkg) {
    this.run(["uninstall", pkg], { timeout: 120_000 });
  }
  installed(pkg) {
    return this.shell(["pm", "list", "packages", pkg]).split("\n").includes(`package:${pkg}`);
  }
  reverse(port) {
    if (port === 6767 || port === 6768) fail("refusing to expose a production daemon port");
    this.run(["reverse", `tcp:${port}`, `tcp:${port}`]);
  }
  pid(pkg) {
    const value = this.tryShell(["pidof", pkg]);
    return value ? value.split(/\s+/)[0] : null;
  }
  /** The package's application UID. Android 16 prints `appId=`; older releases print `userId=`. */
  uid(pkg) {
    const dump = this.shell(["dumpsys", "package", pkg]);
    const match = dump.match(/^\s*appId=(\d+)/m) ?? dump.match(/^\s*userId=(\d+)/m);
    if (!match) fail(`no application uid for ${pkg} in dumpsys package output`);
    return Number(match[1]);
  }
  requestedPermissions(pkg) {
    const dump = this.shell(["dumpsys", "package", pkg]);
    const section = dump.split("requested permissions:")[1] ?? "";
    const block = section.split(/\n\s*(install permissions|runtime permissions|User \d+):/)[0];
    return block
      .split("\n")
      .map((line) => line.trim().split(":")[0])
      .filter((line) => line.startsWith("android.permission.") || line.includes(".permission."));
  }
  processUids() {
    const rows = this.shell(["ps", "-A", "-o", "PID,UID,NAME"]).split("\n").slice(1);
    return rows
      .map((row) => row.trim().split(/\s+/))
      .map(([pid, uid, name]) => ({ pid, uid, name }));
  }
  key(code) {
    this.shell(["input", "keyevent", String(code)]);
  }
  tap(x, y) {
    this.shell(["input", "tap", String(Math.round(x)), String(Math.round(y))]);
  }
  start(component) {
    this.shell(["am", "start", "-W", "-n", component]);
  }
  deepLink(uri, pkg) {
    this.shell(["am", "start", "-W", "-a", "android.intent.action.VIEW", "-d", `'${uri}'`, pkg]);
  }
  forceStop(pkg) {
    this.shell(["am", "force-stop", pkg]);
  }
  async screencap() {
    return this.run(["exec-out", "screencap", "-p"], { encoding: "buffer", timeout: 30_000 });
  }
  /**
   * A fresh UI hierarchy, never a stale file. `uiautomator dump` first needs one second without
   * accessibility events; while a Paseo turn runs, its ticking timer can prevent that, and the
   * standard dump then writes nothing ("could not get idle state"). In that case the same tree is
   * dumped without the idle wait through the shell UiAutomation (`NoIdleDump`).
   */
  dump() {
    const file = "/sdcard/judge-ui.xml";
    this.shell(["rm", "-f", file]);
    const standard = this.tryShell(["uiautomator", "dump", file]);
    if (!(standard && standard.includes("dumped"))) {
      if (!this.noIdleReady) {
        this.run(["push", noIdleDumper(), "/data/local/tmp/judge-no-idle-dump.jar"]);
        const size = this.shell(["wm", "size"]);
        const match =
          size.match(/Override size: (\d+)x(\d+)/) ?? size.match(/Physical size: (\d+)x(\d+)/);
        if (!match) fail(`cannot read the display size: ${size}`);
        this.displaySize = `${match[1]} ${match[2]}`;
        this.noIdleReady = true;
      }
      const noIdle = this.tryShell([
        `CLASSPATH=/system/framework/android.test.runner.jar:/system/framework/uiautomator.jar:/data/local/tmp/judge-no-idle-dump.jar app_process /system/bin NoIdleDump ${file} ${this.displaySize}`,
      ]);
      if (!(noIdle && noIdle.includes("dumped")))
        fail(`UI hierarchy dump failed: ${standard ?? "no output"} / ${noIdle ?? "no output"}`);
    }
    const xml = this.run(["exec-out", "cat", file]);
    const nodes = [];
    for (const match of xml.matchAll(/<node ([^>]*?)\/?>/g)) {
      const attrs = Object.fromEntries(
        [...match[1].matchAll(/([\w-]+)="([^"]*)"/g)].map((m) => [m[1], m[2]]),
      );
      const bounds = (attrs.bounds ?? "").match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/);
      nodes.push({
        text: decodeXml(attrs.text ?? ""),
        id: attrs["resource-id"] ?? "",
        cls: attrs.class ?? "",
        pkg: attrs.package ?? "",
        focused: attrs.focused === "true",
        bounds: bounds ? bounds.slice(1).map(Number) : null,
      });
    }
    return nodes;
  }
  find(id) {
    const nodes = this.dump();
    if (this.handleAnr(nodes)) return null;
    return nodes.find((node) => node.id === id && node.bounds) ?? null;
  }
  async waitForId(id, timeout = 30_000) {
    return waitFor(`element ${id}`, () => this.find(id), { timeout, interval: 700 });
  }
  async tapId(id, timeout = 30_000) {
    const node = await this.waitForId(id, timeout);
    const [x1, y1, x2, y2] = node.bounds;
    this.tap((x1 + x2) / 2, (y1 + y2) / 2);
  }
  /** React Native text inputs miss bulk adb text; type slowly and verify the native value. */
  async typeInto(id, text) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await this.tapId(id);
      await sleep(600);
      this.key(123);
      const current = this.find(id)?.text ?? "";
      for (let index = 0; index < current.length + 4; index += 1) this.key(67);
      await sleep(300);
      for (const character of text) {
        this.shell([
          "input",
          "text",
          character === " " ? "%s" : character.replace(/([\\'"$`&|;<>()])/g, "\\$1"),
        ]);
        await sleep(160);
      }
      await sleep(400);
      if ((this.find(id)?.text ?? "") === text) return;
    }
    fail(`could not type into ${id}`);
  }
}

function decodeXml(value) {
  return value
    .replace(/&#10;/g, "\n")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/** Isolated daemon with the deterministic offline Pi provider; never the operator's homes or ports. */
export async function startIsolatedDaemon(root, options = {}) {
  const port = await freePort();
  const paseoHome = path.join(root, "paseo");
  const piDir = path.join(root, "pi");
  const home = path.join(root, "home");
  for (const dir of [paseoHome, piDir, home]) await mkdir(dir, { recursive: true });
  const trace = path.join(root, "model.jsonl");
  await writeFile(
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
            env: { HOME: home, PI_CODING_AGENT_DIR: piDir, PI_WORKSPACE_ORACLE_TRACE: trace },
            command: [
              "/usr/local/bin/pi",
              "--no-extensions",
              "--no-skills",
              "--no-prompt-templates",
              "--no-context-files",
              "--offline",
              "--tools",
              "visual_present,visual_update,visual_act,visual_inspect,visual_list,speak,branch_open,branch_return",
              "-e",
              path.join(repository, "packages/pi-workspace/extensions/workspace.ts"),
              "-e",
              path.join(repository, "qa/pi-workspace/scripted-provider.mjs"),
            ],
          },
        },
      },
    })}\n`,
  );
  const logPath = path.join(root, "daemon.log");
  const log = openSync(logPath, "w");
  const child = spawn(
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
        PASEO_SERVER_ID: `srv_android_judge_${port}`,
        PASEO_LISTEN: `127.0.0.1:${port}`,
        PASEO_RELAY_ENABLED: "0",
        ...(options.corsOrigin ? { PASEO_CORS_ORIGINS: options.corsOrigin } : {}),
        // S1 flows opt into local speech from the task-owned read-only model copy.
        ...(options.speechModels
          ? {
              PASEO_DICTATION_ENABLED: "1",
              PASEO_DICTATION_STT_PROVIDER: "local",
              PASEO_VOICE_TTS_PROVIDER: "local",
              PASEO_LOCAL_MODELS_DIR: options.speechModels,
            }
          : { PASEO_DICTATION_ENABLED: "0" }),
        PASEO_VOICE_MODE_ENABLED: "0",
        PASEO_LOCAL_SPEECH_AUTO_DOWNLOAD: "0",
        PASEO_NODE_ENV: "development",
        NODE_ENV: "development",
      },
      stdio: ["ignore", log, log],
    },
  );
  closeSync(log);
  const status = await waitFor(
    "isolated daemon",
    async () => {
      if (child.exitCode !== null) throw new Error(`daemon exited (${logPath})`);
      const response = await fetch(`http://127.0.0.1:${port}/api/status`);
      return response.ok ? response.json() : null;
    },
    { timeout: 90_000, interval: 1000 },
  );
  return {
    port,
    serverId: status.serverId,
    piDir,
    trace,
    close: async () => {
      child.kill("SIGTERM");
      await Promise.race([new Promise((resolve) => child.once("exit", resolve)), sleep(10_000)]);
      if (child.exitCode === null) child.kill("SIGKILL");
    },
  };
}

export async function connectClient(port) {
  if (port === 6767 || port === 6768) fail("refusing production daemon port");
  const module = await import(
    pathToFileURL(path.join(repository, "packages/client/dist/daemon-client.js")).href
  );
  const appVersion = JSON.parse(
    await readFile(path.join(repository, "packages/app/package.json"), "utf8"),
  ).version;
  const client = new module.DaemonClient({
    url: `ws://127.0.0.1:${port}/ws`,
    clientId: `android-judge-${randomUUID()}`,
    clientType: "cli",
    appVersion,
    webSocketFactory: (url, options) => new WebSocket(url, { headers: options?.headers }),
  });
  await client.connect();
  return client;
}

/** Reads actual persisted Pi tool results for the isolated session bound to cwd. */
export async function readResults(piDir, cwd) {
  const sessionRoot = path.join(piDir, "sessions");
  const expected = await realpath(cwd);
  const matches = [];
  for (const relative of await readdir(sessionRoot, { recursive: true })) {
    if (!relative.endsWith(".jsonl")) continue;
    const lines = (await readFile(path.join(sessionRoot, relative), "utf8")).trim().split("\n");
    const header = JSON.parse(lines[0] ?? "null");
    if (header?.type === "session" && (header.cwd === cwd || header.cwd === expected))
      matches.push(lines.slice(1));
  }
  if (matches.length !== 1)
    fail(`expected exactly one isolated Pi session, found ${matches.length}`);
  const results = [];
  for (const line of matches[0]) {
    const entry = JSON.parse(line);
    if (entry.type === "message" && entry.message?.role === "toolResult")
      results.push(entry.message);
  }
  return results;
}

export function piDriver({ client, agentId, cwd, piDir }) {
  let count = 0;
  return {
    async call(name, args, expectError = false) {
      await client.sendAgentMessage(
        agentId,
        `oracle-call:${JSON.stringify({ name, arguments: args })}`,
      );
      const finish = await client.waitForFinish(agentId, 60_000);
      if (finish.status !== "idle") fail(`${name}: agent finished ${finish.status}`);
      const results = await readResults(piDir, cwd);
      count += 1;
      if (results.length !== count)
        fail(`${name}: expected ${count} tool results, found ${results.length}`);
      const result = results.at(-1);
      if (result.toolName !== name) fail(`${name}: last result was ${result.toolName}`);
      if (result.isError !== expectError) {
        fail(
          `${name}: isError=${result.isError}, expected ${expectError}: ${JSON.stringify(result.details)}`,
        );
      }
      const images = (result.content ?? []).filter((part) => part.type === "image");
      if (images.length > 1) fail(`${name}: more than one image`);
      if (images[0] && images[0].mimeType !== "image/png")
        fail(`${name}: image is ${images[0].mimeType}`);
      return {
        details: result.details,
        png: images[0]?.data ? Buffer.from(images[0].data, "base64") : null,
      };
    },
  };
}

export function errorCode(outcome) {
  const code = outcome.details?.error?.code;
  if (typeof code !== "string")
    fail(`no structured error code: ${JSON.stringify(outcome.details)}`);
  return code;
}

/**
 * Decodes the private 192-cell motif from a PNG (actual Pi image or independent screencap).
 * Frame detection tolerates GPU colour conversion; cells must still be crisp black or white.
 */
export async function decodeMotif(png) {
  if (!png) fail("no PNG to decode");
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const at = (x, y) => {
    const offset = (y * info.width + x) * 4;
    return [data[offset], data[offset + 1], data[offset + 2]];
  };
  let minX = info.width;
  let minY = info.height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < info.height; y += 1) {
    for (let x = 0; x < info.width; x += 1) {
      const [r, g, b] = at(x, y);
      if (r > 190 && g < 80 && b > 190) {
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
    }
  }
  if (maxX <= minX) return null;
  const scale = (maxX - minX + 1) / 256;
  if (Math.abs((maxY - minY + 1) / scale - 128) > 2) fail("motif frame is clipped or distorted");
  let code = "";
  let byte = 0;
  for (let index = 0; index < 192; index += 1) {
    const x = Math.floor(minX + (8 + (index % 16) * 15 + 7) * scale);
    const y = Math.floor(minY + (8 + Math.floor(index / 16) * 9 + 4) * scale);
    const [r, g, b] = at(x, y);
    const luminance = (r + g + b) / 3;
    if (!(luminance < 70 || luminance > 185))
      fail(`motif cell ${index} is not crisp (${r},${g},${b})`);
    byte = byte * 2 + (luminance > 127 ? 1 : 0);
    if (index % 8 === 7) {
      code += byte.toString(16).padStart(2, "0");
      byte = 0;
    }
  }
  return { code, box: { minX, minY, maxX, maxY }, scale };
}

export async function startSink() {
  const arrivals = [];
  const tcp = createServer((socket) => {
    arrivals.push("tcp:connection");
    socket.once("data", (chunk) =>
      arrivals.push(`tcp:${chunk.toString("latin1").split("\r\n")[0]}`),
    );
    socket.on("error", () => undefined);
    setTimeout(() => socket.destroy(), 200);
  });
  await new Promise((resolve) => tcp.listen(0, "127.0.0.1", resolve));
  const udp = createSocket("udp4");
  udp.on("message", () => arrivals.push("udp:datagram"));
  await new Promise((resolve) => udp.bind(0, "127.0.0.1", resolve));
  return {
    port: tcp.address().port,
    udpPort: udp.address().port,
    arrivals,
    close: async () => {
      udp.close();
      await new Promise((resolve) => tcp.close(() => resolve()));
    },
  };
}

export async function makeTemp(prefix) {
  return mkdtemp(path.join(tmpdir(), prefix));
}
export { rm, writeFile, readFile, mkdir };
