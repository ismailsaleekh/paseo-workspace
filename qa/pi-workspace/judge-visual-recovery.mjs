// Supervisor-owned narrow recovery judge. No running app/daemon/auth/history or model-provider use.
import { spawnSync } from "node:child_process";
import {
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
const mode = process.argv[2];
if (mode !== "feature" && mode !== "guard") throw new Error("Choose feature or guard");
const cache = "/Users/lizavasilyeva/work/paseo-env";
const logsRoot = path.join(cache, "bg-jobs/visual-recovery/judge-logs");
mkdirSync(logsRoot, { recursive: true });
const logs = mkdtempSync(path.join(logsRoot, mode + "-"));
const home = path.join(logs, "home");
mkdirSync(path.join(home, "agent"), { recursive: true });
const temp = realpathSync(tmpdir());
const env = {
  PATH: process.env.PATH,
  HOME: home,
  TMPDIR: temp,
  TMP: temp,
  TEMP: temp,
  CI: "1",
  PI_CODING_AGENT_DIR: path.join(home, "agent"),
  PI_OFFLINE: "1",
  PI_SKIP_VERSION_CHECK: "1",
  PI_TELEMETRY: "0",
  npm_config_cache: path.join(cache, "npm"),
  npm_config_offline: "true",
  npm_config_userconfig: path.join(home, "user.npmrc"),
  npm_config_globalconfig: path.join(home, "global.npmrc"),
};
writeFileSync(env.npm_config_userconfig, "");
writeFileSync(env.npm_config_globalconfig, "");
console.log("Visual recovery logs: " + logs);
const receipt = [];
function step(name, command, args, minutes) {
  const file = path.join(logs, name + ".log");
  const fd = openSync(file, "w");
  const started = Date.now();
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    env,
    stdio: ["ignore", fd, fd],
    timeout: minutes * 60000,
    killSignal: "SIGKILL",
  });
  closeSync(fd);
  const ok = !result.error && result.signal === null && result.status === 0;
  receipt.push({
    name,
    command,
    args,
    ok,
    exit: result.status,
    signal: result.signal,
    error: result.error?.message,
    elapsedMs: Date.now() - started,
    file,
  });
  writeFileSync(path.join(logs, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n");
  console.log(`${ok ? "PASS" : "FAIL"} ${name}`);
  if (!ok) console.log(readFileSync(file, "utf8").slice(-6000));
  return ok;
}
const preparation = [
  ["dependencies", "npm", ["ci", "--offline", "--ignore-scripts", "--no-audit", "--no-fund"], 15],
  ["patches", "npm", ["run", "postinstall"], 5],
  ["relay-build", "npm", ["run", "build:relay"], 10],
  ["client-build", "npm", ["run", "build:client"], 15],
];
for (const [name, command, args, minutes] of preparation)
  if (!step(name, command, args, minutes)) throw new Error("HARNESS_PREPARATION_FAILED " + name);
const checks =
  mode === "feature"
    ? [
        [
          "visual-bootstrap-recovery",
          process.execPath,
          [
            "node_modules/vitest/vitest.mjs",
            "run",
            "qa/pi-workspace/visual-recovery.test.mjs",
            "--maxWorkers=1",
          ],
          5,
        ],
      ]
    : [
        ["client-typecheck", "npm", ["run", "typecheck", "--workspace=@getpaseo/client"], 10],
        ["client-lint", "npm", ["run", "lint", "--", "packages/client/src/daemon-client.ts"], 5],
        [
          "client-format",
          "npm",
          ["run", "format:check:files", "--", "packages/client/src/daemon-client.ts"],
          5,
        ],
        [
          "existing-connection-guards",
          process.execPath,
          [
            "node_modules/vitest/vitest.mjs",
            "run",
            "packages/client/src/daemon-client.test.ts",
            "packages/client/src/daemon-client-transport.test.ts",
            "packages/client/src/daemon-client.background-jobs.test.ts",
            "packages/client/src/connection/owned.test.ts",
            "--maxWorkers=1",
            "--bail=1",
          ],
          10,
        ],
      ];
let failed = 0;
for (const [name, command, args, minutes] of checks)
  if (!step(name, command, args, minutes)) failed += 1;
console.log(`Visual recovery ${mode}: ${checks.length - failed}/${checks.length} checks passed`);
process.exitCode = failed ? 1 : 0;
