#!/usr/bin/env node
// Judge-owned B1 check: native Pi conversation detours through branch_open/branch_return on the
// real Paseo Pi provider, plus the default eight-tool contract and V1/V2-D/V2-A/S1 regressions.
// Physical-device and deployment evidence are separate gates.
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";

const cache = path.join(homedir(), ".cache", "pi-paseo-workspace");
const npmCache = path.join(cache, "npm");
const repository = process.cwd();
const work = mkdtempSync(path.join(tmpdir(), "paseo-b1-judge-"));
const buildResult = path.join(work, "android-build.json");
function run(name, command, args, extraEnv = {}) {
  process.stdout.write(`CHECK ${name}\n`);
  const result = spawnSync(command, args, {
    cwd: repository,
    stdio: "inherit",
    env: {
      ...process.env,
      npm_config_cache: npmCache,
      npm_config_offline: "true",
      PI_OFFLINE: "1",
      PI_TELEMETRY: "0",
      ...extraEnv,
    },
  });
  const ok = !result.error && result.signal === null && result.status === 0;
  if (!ok)
    process.stderr.write(
      `FAIL ${name}: ${result.error?.message ?? `exit=${result.status} signal=${result.signal}`}\n`,
    );
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
    "B1 harness prerequisite",
    process.execPath,
    ["qa/pi-workspace/b1/run-b1.mjs", "--prerequisite"],
  ],
  [
    "Android builds (Paseo release APK; visual host when provided)",
    process.execPath,
    ["qa/pi-workspace/android/build.mjs", buildResult],
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
  `B1 native conversation detours: ${checks.length - failures}/${checks.length} checks passed. Physical-device and deployment gates are separate.\n`,
);
process.exitCode = failures === 0 ? 0 : 1;
