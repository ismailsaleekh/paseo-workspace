#!/usr/bin/env node
// Judge-owned V2-A check: real Pi -> isolated daemon -> real Paseo Android app with the
// no-INTERNET visual host on a fresh emulator, plus desktop cross-display and V1/V2-D
// regressions. Emulator evidence is not physical-device evidence; the operator's HyperOS
// phone is verified separately. Speech, detours and deployment are later gates.
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";

const cache = path.join(homedir(), ".cache", "pi-paseo-workspace");
const npmCache = path.join(cache, "npm");
const repository = process.cwd();
const work = mkdtempSync(path.join(tmpdir(), "paseo-v2a-judge-"));
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
    "Android harness prerequisite on a fresh emulator",
    process.execPath,
    ["qa/pi-workspace/android/run-android.mjs", "--build", buildResult, "--prerequisite"],
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
    "five real visual tools and unavailable-host behavior",
    process.execPath,
    ["qa/pi-workspace/tool-contract.mjs", "--phase", "visual"],
  ],
  ["visual package deterministic QA", "npm", ["--prefix", "packages/pi-workspace", "run", "test"]],
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
    "V2-A real Pi to the contained Android visual host, with desktop cross-display",
    process.execPath,
    ["qa/pi-workspace/android/run-android.mjs", "--build", buildResult],
  ],
];
let failures = 0;
for (const [name, command, args] of checks) if (!run(name, command, args)) failures += 1;
process.stdout.write(
  `V2-A Android visual containment: ${checks.length - failures}/${checks.length} checks passed. Physical HyperOS verification, speech, detours and deployment remain later gates.\n`,
);
process.exitCode = failures === 0 ? 0 : 1;
