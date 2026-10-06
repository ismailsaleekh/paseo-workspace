// Judge-owned AF1 test keyboard: offline build (private JDK 17, d8, aapt2, zipalign, apksigner),
// cached by source hash, plus device helpers that drive it. Emulator only; never installed on a
// physical phone.
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import path from "node:path";
import { completeLogLines } from "./log-lines.mjs";
import {
  androidEnv,
  cache,
  fail,
  repository,
  sleep,
  tools,
  trackChild,
  waitFor,
} from "../android/lib.mjs";

export const IME_PACKAGE = "sh.paseo.judge.ime";
export const IME_COMPONENT = `${IME_PACKAGE}/.JudgeIme`;
const source = path.join(repository, "qa/pi-workspace/af1/judge-ime");
const sources = [
  "AndroidManifest.xml",
  "res/xml/method.xml",
  "src/sh/paseo/judge/ime/JudgeIme.java",
].map((file) => path.join(source, file));

function run(command, args, cwd) {
  execFileSync(command, args, {
    cwd,
    env: androidEnv(),
    stdio: ["ignore", "ignore", "pipe"],
    timeout: 120_000,
    killSignal: "SIGKILL",
  });
}

function classFiles(dir) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...classFiles(full));
    else if (entry.name.endsWith(".class")) found.push(full);
  }
  return found;
}

/** Builds (or reuses) the judge keyboard APK and returns its path. */
export function judgeImeApk() {
  const hash = createHash("sha256");
  for (const file of sources) hash.update(readFileSync(file));
  const digest = hash.digest("hex").slice(0, 16);
  const out = path.join(cache, "judge-tools", `judge-ime-${digest}`);
  const apk = path.join(out, "judge-ime.apk");
  if (existsSync(apk)) return apk;
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const buildTools = path.join(tools.sdk, "build-tools/36.0.0");
  const androidJar = path.join(tools.sdk, "platforms/android-36/android.jar");
  const classes = path.join(out, "classes");
  mkdirSync(classes);
  run(
    path.join(tools.javaHome, "bin/javac"),
    ["--release", "11", "-nowarn", "-cp", androidJar, "-d", classes, sources[2]],
    out,
  );
  run(
    path.join(buildTools, "d8"),
    ["--release", "--min-api", "30", "--lib", androidJar, "--output", out, ...classFiles(classes)],
    out,
  );
  const compiled = path.join(out, "res.zip");
  run(tools.aapt2, ["compile", "--dir", path.join(source, "res"), "-o", compiled], out);
  const unsigned = path.join(out, "unsigned.apk");
  run(
    tools.aapt2,
    [
      "link",
      "-I",
      androidJar,
      "--manifest",
      sources[0],
      "--min-sdk-version",
      "30",
      "--target-sdk-version",
      "36",
      "-o",
      unsigned,
      compiled,
    ],
    out,
  );
  run("/usr/bin/zip", ["-q", "-j", unsigned, path.join(out, "classes.dex")], out);
  const aligned = path.join(out, "aligned.apk");
  run(path.join(buildTools, "zipalign"), ["-f", "-p", "4", unsigned, aligned], out);
  const keystore = path.join(cache, "judge-tools", "judge-ime.keystore");
  if (!existsSync(keystore)) {
    run(
      path.join(tools.javaHome, "bin/keytool"),
      [
        "-genkeypair",
        "-keystore",
        keystore,
        "-storetype",
        "PKCS12",
        "-storepass",
        "judge-ime",
        "-keypass",
        "judge-ime",
        "-alias",
        "judge",
        "-keyalg",
        "RSA",
        "-keysize",
        "2048",
        "-validity",
        "3650",
        "-dname",
        "CN=Paseo judge keyboard",
      ],
      out,
    );
  }
  run(
    tools.apksigner,
    ["sign", "--ks", keystore, "--ks-pass", "pass:judge-ime", "--out", apk, aligned],
    out,
  );
  if (!existsSync(apk)) fail("judge keyboard APK was not produced");
  return apk;
}

/**
 * Installs, enables and selects the judge keyboard, and lets it show with the hardware keyboard.
 * `adb install` reports Success before Android's input-method service has registered the new
 * keyboard: its package monitor runs asynchronously (measured 149–868 ms on the API 36 AVD), and
 * `ime enable` sent before that fails with "Unknown input method". Wait, bounded, until the service
 * lists the keyboard; a keyboard that never registers fails loudly.
 */
export async function selectJudgeIme(device) {
  device.install(judgeImeApk());
  await waitFor(
    "judge keyboard registered with the input-method service",
    () => (device.tryShell(["ime", "list", "-a", "-s"]) ?? "").split("\n").includes(IME_COMPONENT),
    { timeout: 30_000, interval: 250 },
  );
  device.shell(["settings", "put", "secure", "show_ime_with_hard_keyboard", "1"]);
  device.shell(["ime", "enable", IME_COMPONENT]);
  device.shell(["ime", "set", IME_COMPONENT]);
  const current = device.shell(["settings", "get", "secure", "default_input_method"]);
  if (current !== IME_COMPONENT) fail(`judge keyboard not selected (default is ${current})`);
}

/** Restores the emulator's default keyboard behavior for later flows. */
export function releaseJudgeIme(device) {
  device.tryShell(["ime", "reset"]);
  device.tryShell(["settings", "put", "secure", "show_ime_with_hard_keyboard", "0"]);
}

/** The system currently shows the soft keyboard. */
export function keyboardShown(device) {
  return (device.tryShell(["dumpsys", "input_method"]) ?? "").includes("mInputShown=true");
}

let imeLogPath = null;
/**
 * Records the judge keyboard's log for the whole flow into an append-only file (the device's ring
 * buffer can rotate during a long run). Returns a cleanup.
 */
export function startImeLog(device, dir) {
  imeLogPath = path.join(dir, "judge-keyboard-logcat.txt");
  const file = openSync(imeLogPath, "w");
  const child = spawn(
    tools.adb,
    ["-s", device.serial, "logcat", "-v", "raw", "-s", "PaseoJudgeIme:I"],
    { env: androidEnv(), stdio: ["ignore", file, file] },
  );
  closeSync(file);
  return trackChild(child, "judge keyboard logcat");
}

/** All judge keyboard log lines so far, parsed, in order. */
export function imeLog() {
  if (!imeLogPath) fail("judge keyboard log not started");
  return completeLogLines(readFileSync(imeLogPath, "utf8"))
    .map((line) => line.trim())
    .filter((line) => /^(CREATED|START|SHOWN|HIDDEN|RESULT)\b/.test(line))
    .map((line) =>
      Object.assign(
        { kind: line.split(" ")[0], line },
        Object.fromEntries([...line.matchAll(/(\w+)=(\S+)/g)].map((match) => [match[1], match[2]])),
      ),
    );
}

let commandId = 0;
/** Applies one keyboard command through the current InputConnection; fails unless applied. */
export async function imeCommand(device, op, text = null) {
  commandId += 1;
  const id = `c${commandId}`;
  const args = [
    "am",
    "broadcast",
    "-a",
    "sh.paseo.judge.ime.COMMAND",
    "-p",
    IME_PACKAGE,
    "--es",
    "id",
    id,
    "--es",
    "op",
    op,
  ];
  if (text !== null) {
    if (/['\\]/.test(text)) fail(`unsupported keyboard text ${JSON.stringify(text)}`);
    args.push("--es", "text", `'${text}'`);
  }
  device.shell(args);
  const result = await waitFor(
    `judge keyboard ${op} ${id}`,
    () => imeLog().find((entry) => entry.kind === "RESULT" && entry.id === id) ?? null,
    { timeout: 10_000, interval: 300 },
  );
  if (result.ok !== "true") fail(`judge keyboard ${op} was not applied: ${result.line}`);
  await sleep(300);
  return result;
}
