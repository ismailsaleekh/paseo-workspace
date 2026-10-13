// Supervisor-owned UR-01 judge; exact feature/guard modes, isolated state and bounded commands.
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  openSync,
  closeSync,
  readFileSync,
  writeFileSync,
  realpathSync,
} from "node:fs";
import path from "node:path";
const mode = process.argv[2];
if (!["feature", "guard"].includes(mode)) throw new Error("Choose feature or guard");
const prepared = process.argv[3] === "--prepared";
if (process.argv.length > (prepared ? 4 : 3)) throw new Error("Unknown arguments");
const cache = "/Users/lizavasilyeva/work/paseo-env";
const logsRoot = cache + "/review-core/judge-logs";
mkdirSync(logsRoot, { recursive: true });
const root = mkdtempSync(logsRoot + "/" + mode + "-");
console.log("RECEIPT " + root + "/receipt.json");
for (const name of ["home", "pi", "paseo"]) mkdirSync(root + "/" + name, { mode: 0o700 });
const tempRoot = cache + "/review-tmp";
mkdirSync(tempRoot, { recursive: true, mode: 0o700 });
const temp = realpathSync(tempRoot);
const env = {
  PATH: process.env.PATH,
  HOME: root + "/home",
  TMPDIR: temp,
  TMP: temp,
  TEMP: temp,
  CI: "1",
  LANG: "en_US.UTF-8",
  PASEO_HOME: root + "/paseo",
  PI_CODING_AGENT_DIR: root + "/pi",
  PI_OFFLINE: "1",
  PI_SKIP_VERSION_CHECK: "1",
  PI_TELEMETRY: "0",
  EXPO_OFFLINE: "1",
  PASEO_LOCAL_SPEECH_AUTO_DOWNLOAD: "0",
  npm_config_cache: cache + "/npm",
  npm_config_offline: "true",
  npm_config_userconfig: root + "/home/user.npmrc",
  npm_config_globalconfig: root + "/home/global.npmrc",
  electron_config_cache: cache + "/electron",
};
writeFileSync(env.npm_config_userconfig, "");
writeFileSync(env.npm_config_globalconfig, "");
const results = [];
function step(name, program, args, minutes, cwd = process.cwd()) {
  const log = root + "/" + name + ".log",
    fd = openSync(log, "w");
  const start = Date.now();
  const r = spawnSync(program, args, {
    cwd,
    env,
    stdio: ["ignore", fd, fd],
    timeout: minutes * 60000,
    killSignal: "SIGKILL",
  });
  closeSync(fd);
  const ok = r.status === 0 && !r.signal && !r.error;
  results.push({
    name,
    program,
    args,
    cwd,
    ok,
    exit: r.status,
    signal: r.signal,
    error: r.error?.message,
    elapsedMs: Date.now() - start,
    log,
  });
  writeFileSync(
    root + "/receipt.json",
    JSON.stringify({ root, mode, prepared, results, complete: false }, null, 2) + "\n",
  );
  console.log((ok ? "PASS " : "FAIL ") + name);
  if (!ok) console.log(readFileSync(log, "utf8").slice(-7000));
  return ok;
}
if (!prepared) {
  for (const [name, program, args, minutes] of [
    ["dependencies", "npm", ["ci", "--offline", "--ignore-scripts", "--no-audit", "--no-fund"], 15],
    ["patches", "npm", ["run", "postinstall"], 5],
    ["server-build", "npm", ["run", "build:server"], 20],
    ["app-dependencies", "npm", ["run", "build:app-deps"], 15],
  ])
    if (!step(name, program, args, minutes)) throw new Error("HARNESS_PREPARATION_FAILED " + name);
}
const node = process.execPath,
  vitest = path.resolve("node_modules/vitest/vitest.mjs");
let pass = true;
if (mode === "feature") {
  if (
    !step(
      "committed-library-history",
      node,
      [vitest, "run", "qa/pi-workspace/review-core/library.test.mjs", "--maxWorkers=1"],
      5,
    )
  )
    pass = false;
  if (
    !step(
      "native-library-ui",
      node,
      [
        path.resolve("node_modules/@playwright/test/cli.js"),
        "test",
        "e2e/browser/pi-workspace-library.spec.ts",
        "--project=browser",
        "--workers=1",
        "--retries=0",
        "--global-timeout=600000",
      ],
      12,
      path.resolve("packages/app"),
    )
  )
    pass = false;
} else {
  if (
    !step(
      "storage-display-speech-preservation",
      node,
      [
        vitest,
        "run",
        "packages/server/src/server/pi-workspace/storage.test.ts",
        "packages/server/src/server/pi-workspace/service.displays.test.ts",
        "packages/server/src/server/pi-workspace/speech.test.ts",
        "packages/app/src/pi-workspace/speech-player.test.ts",
        "packages/client/src/daemon-client.background-jobs.test.ts",
        "--maxWorkers=1",
        "--bail=1",
      ],
      10,
    )
  )
    pass = false;
  if (
    !step(
      "connection-recovery-preservation",
      node,
      [vitest, "run", "qa/pi-workspace/visual-recovery.test.mjs", "--maxWorkers=1", "--bail=1"],
      5,
    )
  )
    pass = false;
}
writeFileSync(
  root + "/receipt.json",
  JSON.stringify({ root, mode, prepared, results, complete: true, passed: pass }, null, 2) + "\n",
);
process.exitCode = pass ? 0 : 1;
