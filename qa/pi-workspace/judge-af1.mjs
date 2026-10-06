#!/usr/bin/env node
// Judge-owned AF1 check: keyboard input into Android visuals, prompt DOCUMENT_UNRESPONSIVE with a
// slow renderer termination, recovery and companion log hygiene on the real Paseo Android app,
// plus the default eight-tool contract and V1/V2-D/B1/V2-A/S1 regressions. Physical-device and
// deployment evidence are separate gates.
import { spawnSync } from "node:child_process";
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";

const cache = path.join(homedir(), ".cache", "pi-paseo-workspace");
const npmCache = path.join(cache, "npm");
const repository = process.cwd();
const work = mkdtempSync(path.join(tmpdir(), "paseo-af1-judge-"));
const buildResult = path.join(work, "android-build.json");
// Every step's complete output is kept outside the (disposable) checkout; stdout carries only the
// step outcomes and the lines that explain a failure, so a short stdout prefix stays diagnostic.
const logs = path.join(
  cache,
  "judge-logs",
  `af1-${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}`,
);
mkdirSync(logs, { recursive: true });
process.stdout.write(`AF1 judge logs: ${logs}\n`);
let step = 0;
function run(name, command, args, extraEnv = {}) {
  step += 1;
  const logPath = path.join(
    logs,
    `${String(step).padStart(2, "0")}-${name.replace(/[^a-z0-9]+/gi, "-").slice(0, 60)}.log`,
  );
  process.stdout.write(`CHECK ${name}\n`);
  const log = openSync(logPath, "w");
  const result = spawnSync(command, args, {
    cwd: repository,
    stdio: ["ignore", log, log],
    timeout: args.includes("qa/pi-workspace/android/build.mjs") ? 45 * 60_000 : 20 * 60_000,
    killSignal: "SIGKILL",
    env: {
      ...process.env,
      npm_config_cache: npmCache,
      npm_config_offline: "true",
      PI_OFFLINE: "1",
      PI_TELEMETRY: "0",
      ...extraEnv,
    },
  });
  closeSync(log);
  const ok = !result.error && result.signal === null && result.status === 0;
  const lines = readFileSync(logPath, "utf8").split("\n");
  // Only failures and per-flow summaries reach stdout (planc keeps the first 4 KB).
  const outcomes = lines.filter((line) =>
    /^(AF1|ANDROID|S1|S1 ANDROID|B1) FAIL|checks passed|flow stopped|^FAIL /.test(line),
  );
  for (const line of outcomes) process.stdout.write(`  ${line.slice(0, 300)}\n`);
  if (ok) {
    process.stdout.write(`PASS ${name}\n`);
  } else {
    const explaining = lines
      .filter((line) => /Error|FAIL|failed|not satisfied|expected|✖|×/.test(line))
      .slice(-12);
    for (const line of explaining) process.stdout.write(`  | ${line.slice(0, 300)}\n`);
    process.stdout.write(
      `FAIL ${name}: ${result.error?.message ?? `exit=${result.status} signal=${result.signal}`} (log ${logPath})\n`,
    );
  }
  return ok;
}

const preparation = [
  [
    "locked offline dependency preparation",
    "npm",
    ["ci", "--offline", "--ignore-scripts", "--no-audit", "--no-fund", "--cache", npmCache],
  ],
  ["pinned upstream dependency patches", "npm", ["run", "postinstall"]],
  ["server dependency build", "npm", ["run", "build:server"]],
  ["app dependency build", "npm", ["run", "build:app-deps"]],
  ["desktop main build", "npm", ["run", "build:main", "--workspace=@getpaseo/desktop"]],
  [
    "pinned Electron 44.2.0 from the verified private cache",
    process.execPath,
    ["node_modules/electron/install.js"],
    { electron_config_cache: path.join(cache, "electron") },
  ],
  [
    "app typecheck including independent oracles",
    "npm",
    ["run", "typecheck", "--workspace=@getpaseo/app"],
  ],
  ["desktop typecheck", "npm", ["run", "typecheck", "--workspace=@getpaseo/desktop"]],
  [
    "existing Pi/Paseo/composer prerequisite guards",
    process.execPath,
    ["qa/pi-workspace/guards.mjs"],
  ],
  [
    "Android builds (Paseo release APK; visual host when provided)",
    process.execPath,
    ["qa/pi-workspace/android/build.mjs", buildResult],
  ],
  [
    "AF1 incremental log reader guard",
    process.execPath,
    ["--test", "--test-force-exit", "qa/pi-workspace/af1/log-lines.test.mjs"],
  ],
  [
    "AF1 harness prerequisite",
    process.execPath,
    ["qa/pi-workspace/af1/run-af1-android.mjs", "--prerequisite", "--build", buildResult],
  ],
];
for (const [name, command, args, env] of preparation) {
  if (!run(name, command, args, env)) {
    throw new Error(
      `HARNESS_PREPARATION_FAILED: ${name}; this is not an acceptable missing-feature baseline`,
    );
  }
}

const checks = [
  [
    "all eight real tools and unavailable-host behavior",
    process.execPath,
    ["qa/pi-workspace/tool-contract.mjs"],
  ],
  ["visual package deterministic QA", "npm", ["--prefix", "packages/pi-workspace", "run", "test"]],
  [
    "visual package installable artifact",
    "npm",
    ["--prefix", "packages/pi-workspace", "run", "pack:dry-run"],
  ],
  [
    "V1 real Pi to browser interaction and persistence",
    process.execPath,
    ["qa/pi-workspace/run-visual.mjs"],
  ],
  [
    "V2-D real Pi to isolated Electron displays",
    process.execPath,
    ["qa/pi-workspace/run-desktop.mjs"],
  ],
  [
    "B1 native Pi detours through the real Paseo Pi provider",
    process.execPath,
    ["qa/pi-workspace/b1/run-b1.mjs"],
  ],
  [
    "AF1 keyboard input, prompt unresponsive reporting and recovery on the real Android app",
    process.execPath,
    ["qa/pi-workspace/af1/run-af1-android.mjs", "--build", buildResult],
  ],
  [
    "V2-A real Pi to the contained Android visual host, with desktop cross-display",
    process.execPath,
    ["qa/pi-workspace/android/run-android.mjs", "--build", buildResult],
  ],
  [
    "S1 faithful dictation and agent speech on the real desktop app",
    process.execPath,
    ["qa/pi-workspace/s1/run-s1.mjs"],
  ],
  [
    "S1 agent speech on the real Android app; one playback client with desktop open",
    process.execPath,
    ["qa/pi-workspace/s1/run-s1-android.mjs", "--build", buildResult],
  ],
];
let failures = 0;
for (const [name, command, args] of checks) if (!run(name, command, args)) failures += 1;
process.stdout.write(
  `AF1 Android phone fixes: ${checks.length - failures}/${checks.length} checks passed. Physical-device and deployment gates are separate.\n`,
);
process.exitCode = failures === 0 ? 0 : 1;
