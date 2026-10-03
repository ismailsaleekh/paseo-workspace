#!/usr/bin/env node
// Judge-owned prerequisite bundle. Passing it does not implement the workspace feature.
import { spawnSync } from "node:child_process";

const checks = [
  {
    name: "Pi extension/tool-loop harness",
    args: ["qa/pi-workspace/tool-contract.mjs", "--self-check"],
  },
  { name: "Pi native tree primitives", args: ["qa/pi-workspace/pi-tree-primitive.mjs"] },
  { name: "Pi tool-batch yielding", args: ["qa/pi-workspace/pi-yield-primitive.mjs"] },
  { name: "Existing composer preservation", args: ["qa/pi-workspace/composer-primitive.mjs"] },
  {
    name: "Actual isolated Paseo/Pi loop",
    args: ["--import", "tsx", "qa/pi-workspace/daemon-primitive.mjs"],
  },
];
let failures = 0;
for (const check of checks) {
  process.stdout.write(`CHECK ${check.name}\n`);
  const result = spawnSync(process.execPath, check.args, {
    cwd: process.cwd(),
    stdio: "inherit",
    timeout: 180000,
    env: { ...process.env, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0" },
  });
  if (result.error || result.signal || result.status !== 0) {
    failures += 1;
    process.stderr.write(
      `FAIL ${check.name}: ${result.error?.message ?? `exit=${result.status} signal=${result.signal}`}\n`,
    );
  }
}
process.stdout.write(`Prerequisite guards: ${checks.length - failures}/${checks.length} passed\n`);
process.exitCode = failures === 0 ? 0 : 1;
