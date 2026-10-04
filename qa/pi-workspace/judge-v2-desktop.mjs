#!/usr/bin/env node
// Judge-owned V2 desktop check. It certifies real Electron containment, actual displayed-client
// capture and multi-display lifecycle on the desktop. It does not certify Android, speech,
// conversation detours or deployment.
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";

const cache = path.join(homedir(), ".cache", "pi-paseo-workspace");
const repository = process.cwd();
function run(name, command, args, extraEnv = {}) {
  process.stdout.write(`CHECK ${name}\n`);
  const result = spawnSync(command, args, {
    cwd: repository,
    stdio: "inherit",
    env: {
      ...process.env,
      npm_config_cache: path.join(cache, "npm"),
      npm_config_offline: "true",
      PI_OFFLINE: "1",
      PI_TELEMETRY: "0",
      ...extraEnv,
    },
  });
  const passed = !result.error && result.signal === null && result.status === 0;
  if (!passed)
    process.stderr.write(
      `FAIL ${name}: ${result.error?.message ?? `exit=${result.status} signal=${result.signal}`}\n`,
    );
  return passed;
}

const npmCache = path.join(cache, "npm");
const preparation = [
  {
    name: "locked offline dependency preparation",
    command: "npm",
    args: ["ci", "--offline", "--ignore-scripts", "--no-audit", "--no-fund", "--cache", npmCache],
  },
  { name: "pinned upstream dependency patches", command: "npm", args: ["run", "postinstall"] },
  { name: "server dependency build", command: "npm", args: ["run", "build:server"] },
  { name: "app dependency build", command: "npm", args: ["run", "build:app-deps"] },
  {
    name: "desktop main build",
    command: "npm",
    args: ["run", "build:main", "--workspace=@getpaseo/desktop"],
  },
  {
    name: "pinned Electron 44.2.0 from the verified private cache",
    command: process.execPath,
    args: ["node_modules/electron/install.js"],
    env: { electron_config_cache: path.join(cache, "electron") },
  },
  {
    name: "app typecheck including independent oracles",
    command: "npm",
    args: ["run", "typecheck", "--workspace=@getpaseo/app"],
  },
  {
    name: "desktop typecheck",
    command: "npm",
    args: ["run", "typecheck", "--workspace=@getpaseo/desktop"],
  },
  {
    name: "existing Pi/Paseo/composer prerequisite guards",
    command: process.execPath,
    args: ["qa/pi-workspace/guards.mjs"],
  },
  {
    name: "isolated real Electron harness prerequisite",
    command: process.execPath,
    args: ["qa/pi-workspace/run-desktop.mjs", "--prerequisite"],
  },
];
for (const step of preparation) {
  if (!run(step.name, step.command, step.args, step.env)) {
    throw new Error(
      `HARNESS_PREPARATION_FAILED: ${step.name}; this is not an acceptable missing-feature baseline`,
    );
  }
}

const checks = [
  {
    name: "five real visual tools and unavailable-host behavior",
    command: process.execPath,
    args: ["qa/pi-workspace/tool-contract.mjs", "--phase", "visual"],
  },
  {
    name: "visual package deterministic QA",
    command: "npm",
    args: ["--prefix", "packages/pi-workspace", "run", "test"],
  },
  {
    name: "visual package installable artifact",
    command: "npm",
    args: ["--prefix", "packages/pi-workspace", "run", "pack:dry-run"],
  },
  {
    name: "V1 real Pi to browser interaction and persistence",
    command: process.execPath,
    args: ["qa/pi-workspace/run-visual.mjs"],
  },
  {
    name: "V2 real Pi to isolated Electron displays, pixels, egress, hang and relaunch",
    command: process.execPath,
    args: ["qa/pi-workspace/run-desktop.mjs"],
  },
];
let failures = 0;
for (const check of checks) {
  if (!run(check.name, check.command, check.args)) failures += 1;
}
process.stdout.write(
  `V2 desktop visual containment: ${checks.length - failures}/${checks.length} checks passed. Android, speech, detours and deployment remain subject to later gates.\n`,
);
process.exitCode = failures === 0 ? 0 : 1;
