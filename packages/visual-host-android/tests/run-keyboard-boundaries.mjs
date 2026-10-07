#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import {
  androidEnv,
  cache,
  repository,
  requireToolchain,
  startEmulator,
  tools,
} from "../../../qa/pi-workspace/android/lib.mjs";

const root = mkdtempSync("/tmp/af1-native-boundaries-");
process.stdout.write(`Native boundary evidence: ${root}\n`);
let step = 0;
function run(label, command, args, timeout = 120_000) {
  step += 1;
  const logPath = path.join(root, `${step}-${label}.log`);
  const log = openSync(logPath, "w");
  const offline = {
    npm_config_cache: path.join(cache, "npm"),
    npm_config_offline: "true",
    PI_OFFLINE: "1",
    PI_TELEMETRY: "0",
  };
  // Node helpers derive the SDK cache from homedir(). Native-build HOME belongs only to the
  // JVM/Android tools; forwarding it into a Node helper relocates its cache to a nonexistent tree.
  const env = command === process.execPath ? { ...process.env, ...offline } : androidEnv(offline);
  let result;
  try {
    result = spawnSync(command, args, {
      cwd: repository,
      env,
      stdio: ["ignore", log, log],
      timeout,
      killSignal: "SIGKILL",
    });
  } finally {
    closeSync(log);
  }
  if (result.error || result.signal || result.status !== 0) {
    const outcome = result.error?.message ?? `exit=${result.status} signal=${result.signal}`;
    throw new Error(`Native boundary step ${label} failed (${outcome}); log ${logPath}`);
  }
  process.stdout.write(`NATIVE BOUNDARIES COMMAND PASS ${label}\n`);
  return readFileSync(logPath, "utf8");
}

function classes(directory) {
  const result = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...classes(file));
    else if (entry.name.endsWith(".class")) result.push(file);
  }
  return result;
}

requireToolchain();
const buildOption = process.argv.indexOf("--build");
let buildPath;
if (buildOption !== -1) {
  buildPath = process.argv[buildOption + 1];
  if (!buildPath) throw new Error("--build requires a result path");
} else {
  buildPath = path.join(root, "build.json");
  run(
    "product-build",
    process.execPath,
    ["qa/pi-workspace/android/build.mjs", buildPath],
    45 * 60_000,
  );
}
const build = JSON.parse(readFileSync(buildPath, "utf8"));
if (
  !build.paseoApk ||
  !build.companionApk ||
  !existsSync(build.paseoApk) ||
  !existsSync(build.companionApk)
) {
  throw new Error("Native boundary tests require both freshly built product APKs");
}
const source = path.join(
  repository,
  "packages/visual-host-android/tests/KeyboardBoundaryInstrumentation.java",
);
const compiled = path.join(root, "classes");
mkdirSync(compiled);
const androidJar = path.join(tools.sdk, "platforms/android-36/android.jar");
const buildTools = path.join(tools.sdk, "build-tools/36.0.0");
run("javac", path.join(tools.javaHome, "bin/javac"), [
  "--release",
  "11",
  "-cp",
  androidJar,
  "-d",
  compiled,
  source,
]);
run("dex", path.join(buildTools, "d8"), [
  "--release",
  "--min-api",
  "30",
  "--lib",
  androidJar,
  "--output",
  root,
  ...classes(compiled),
]);
const signingStore = path.join(repository, "packages/app/android/app/debug.keystore");
if (!existsSync(signingStore)) throw new Error("Product build signing store is missing");
const targets = [
  { suffix: "client", target: "sh.paseo.debug", apk: build.paseoApk, cases: 8 },
  { suffix: "companion", target: "sh.paseo.debug.visualhost", apk: build.companionApk, cases: 8 },
];
for (const target of targets) {
  const directory = path.join(root, target.suffix);
  mkdirSync(directory);
  target.testPackage = `sh.paseo.visualhost.boundaries.${target.suffix}`;
  const manifest = path.join(directory, "AndroidManifest.xml");
  writeFileSync(
    manifest,
    `<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="${target.testPackage}">
    <uses-sdk android:minSdkVersion="30" android:targetSdkVersion="36" />
    <application android:label="Native keyboard boundaries" android:allowBackup="false">
      <activity android:name="sh.paseo.visualhost.tests.KeyboardBoundaryInstrumentation$HostActivity"
        android:exported="true" android:theme="@android:style/Theme.Material.Light.NoActionBar" />
    </application>
    <instrumentation android:name="sh.paseo.visualhost.tests.KeyboardBoundaryInstrumentation" android:targetPackage="${target.target}" />
  </manifest>`,
  );
  const unsigned = path.join(directory, "unsigned.apk");
  run(`link-${target.suffix}`, tools.aapt2, [
    "link",
    "-I",
    androidJar,
    "--manifest",
    manifest,
    "-o",
    unsigned,
  ]);
  run(`zip-${target.suffix}`, "/usr/bin/zip", [
    "-q",
    "-j",
    unsigned,
    path.join(root, "classes.dex"),
  ]);
  const aligned = path.join(directory, "aligned.apk");
  run(`align-${target.suffix}`, path.join(buildTools, "zipalign"), [
    "-f",
    "-p",
    "4",
    unsigned,
    aligned,
  ]);
  target.testApk = path.join(directory, "test.apk");
  run(`sign-${target.suffix}`, tools.apksigner, [
    "sign",
    "--ks",
    signingStore,
    "--ks-key-alias",
    "androiddebugkey",
    "--ks-pass",
    "pass:android",
    "--out",
    target.testApk,
    aligned,
  ]);
}

const emulator = await startEmulator(root);
try {
  const serial = emulator.device.serial;
  // The shared helper creates and locks only the dedicated wiped judge AVD. Never accept an
  // externally supplied adb serial (especially a physical device) in this test runner.
  for (const target of targets) {
    run(
      `install-product-${target.suffix}`,
      tools.adb,
      ["-s", serial, "install", "-r", target.apk],
      300_000,
    );
    run(
      `install-test-${target.suffix}`,
      tools.adb,
      ["-s", serial, "install", "-r", target.testApk],
      300_000,
    );
    const result = run(
      `instrument-${target.suffix}`,
      tools.adb,
      [
        "-s",
        serial,
        "shell",
        "am",
        "instrument",
        "-w",
        "-r",
        `${target.testPackage}/sh.paseo.visualhost.tests.KeyboardBoundaryInstrumentation`,
      ],
      180_000,
    );
    run(
      `native-diagnostics-${target.suffix}`,
      tools.adb,
      ["-s", serial, "logcat", "-d", "-v", "threadtime", "-s", "PaseoVisualHost:D"],
      30_000,
    );
    if (
      !result.includes("INSTRUMENTATION_RESULT: boundary_result=PASS") ||
      !result.includes(`INSTRUMENTATION_RESULT: boundary_cases=${target.cases}`) ||
      !result.includes("INSTRUMENTATION_CODE: -1")
    ) {
      throw new Error(`Native ${target.suffix} boundary instrumentation failed; evidence ${root}`);
    }
    process.stdout.write(`NATIVE BOUNDARIES PASS ${target.suffix} cases=${target.cases}\n`);
  }
  process.stdout.write("NATIVE BOUNDARIES PASS targets=2 cases=16\n");
} finally {
  await emulator.close();
}
