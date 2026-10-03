#!/usr/bin/env node
// Judge-owned V1 check. It does not certify native capture, speech, branches or deployment.
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";

const cache = path.join(homedir(), ".cache", "pi-paseo-workspace", "npm");
const repository = process.cwd();
function run(name, command, args) {
  process.stdout.write(`CHECK ${name}\n`);
  const result = spawnSync(command, args, {
    cwd: repository,
    stdio: "inherit",
    env: {
      ...process.env,
      npm_config_cache: cache,
      npm_config_offline: "true",
      PI_OFFLINE: "1",
      PI_TELEMETRY: "0",
    },
  });
  const passed = !result.error && result.signal === null && result.status === 0;
  if (!passed)
    process.stderr.write(
      `FAIL ${name}: ${result.error?.message ?? `exit=${result.status} signal=${result.signal}`}\n`,
    );
  return passed;
}

const preparation = [
  {
    name: "locked offline dependency preparation",
    args: ["ci", "--offline", "--ignore-scripts", "--no-audit", "--no-fund", "--cache", cache],
  },
  { name: "pinned upstream dependency patches", args: ["run", "postinstall"] },
  { name: "server dependency build", args: ["run", "build:server"] },
  { name: "app dependency build", args: ["run", "build:app-deps"] },
  {
    name: "app typecheck including independent oracle",
    args: ["run", "typecheck", "--workspace=@getpaseo/app"],
  },
];
for (const check of preparation) {
  if (!run(check.name, "npm", check.args)) {
    throw new Error(
      `HARNESS_PREPARATION_FAILED: ${check.name}; this is not an acceptable missing-feature baseline`,
    );
  }
}

const checks = [
  {
    name: "existing Pi/Paseo/composer prerequisite guards",
    command: process.execPath,
    args: ["qa/pi-workspace/guards.mjs"],
  },
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
    name: "real Pi to app interaction and persistence",
    command: process.execPath,
    args: ["qa/pi-workspace/run-visual.mjs"],
  },
];
let failures = 0;
for (const check of checks) {
  if (!run(check.name, check.command, check.args)) failures += 1;
}
process.stdout.write(
  `V1 connected visual core: ${checks.length - failures}/${checks.length} checks passed. Full workspace remains subject to later gates.\n`,
);
process.exitCode = failures === 0 ? 0 : 1;
