// Supervisor-owned consumer judge. The package input must be frozen from an audited candidate.
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  closeSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
const repository = process.cwd();
const mode = process.argv[2];
if (mode !== "feature" && mode !== "guard") throw new Error("Choose feature or guard");
const cache = "/Users/lizavasilyeva/work/paseo-env";
const logsRoot = path.join(cache, "bg-jobs/paseo-judge-logs");
mkdirSync(logsRoot, { recursive: true });
const logs = mkdtempSync(path.join(logsRoot, mode + "-"));
console.log(`Paseo background jobs ${mode} logs: ${logs}`);
const manifest = JSON.parse(
  readFileSync(path.join(repository, "qa/pi-background-jobs/package-input.json"), "utf8"),
);
if (
  manifest.schemaVersion !== "pi-paseo.background-package-input.v1" ||
  !path.isAbsolute(manifest.root) ||
  !Array.isArray(manifest.files) ||
  manifest.files.length === 0
)
  throw new Error("Invalid pinned package input");
const inputRoot = realpathSync(manifest.root);
function verifyInput() {
  const expected = new Set();
  for (const entry of manifest.files) {
    if (
      typeof entry.path !== "string" ||
      entry.path === "" ||
      path.isAbsolute(entry.path) ||
      entry.path.split(/[\\/]/).includes("..") ||
      !/^[0-9a-f]{64}$/.test(entry.sha256)
    )
      throw new Error("Invalid package input file identity");
    if (expected.has(entry.path)) throw new Error("Duplicate package input file");
    expected.add(entry.path);
    const file = path.join(inputRoot, entry.path);
    const info = lstatSync(file);
    if (!info.isFile() || info.isSymbolicLink())
      throw new Error(`Input is not a regular owned file: ${entry.path}`);
    if (createHash("sha256").update(readFileSync(file)).digest("hex") !== entry.sha256)
      throw new Error(`Package input changed: ${entry.path}`);
  }
  const actual = readdirSync(inputRoot, { recursive: true, withFileTypes: true })
    .filter((entry) => !entry.isDirectory())
    .map((entry) => path.relative(inputRoot, path.join(entry.parentPath, entry.name)));
  if (actual.length !== expected.size || actual.some((file) => !expected.has(file)))
    throw new Error("Package input inventory changed");
}
verifyInput();
const home = path.join(logs, "isolated-home");
mkdirSync(path.join(home, "agent"), { recursive: true });
const inherited = new Set(["PATH", "TMPDIR", "LANG", "LC_ALL", "SHELL", "USER", "LOGNAME"]);
const temporaryRoot = realpathSync(tmpdir());
const env = {
  ...Object.fromEntries(Object.entries(process.env).filter(([name]) => inherited.has(name))),
  HOME: home,
  TMPDIR: temporaryRoot,
  TMP: temporaryRoot,
  TEMP: temporaryRoot,
  PI_CODING_AGENT_DIR: path.join(home, "agent"),
  PASEO_HOME: path.join(home, "paseo"),
  PASEO_SUPERVISED: "0",
  npm_config_cache: path.join(cache, "npm"),
  npm_config_offline: "true",
  electron_config_cache: path.join(cache, "electron"),
  PI_OFFLINE: "1",
  PI_SKIP_VERSION_CHECK: "1",
  PI_TELEMETRY: "0",
  CI: "1",
  EXPO_OFFLINE: "1",
};
const receipt = [];
function step(name, command, args, timeout = 15 * 60000) {
  const file = path.join(logs, name + ".log");
  const fd = openSync(file, "w");
  const started = Date.now();
  const outcome = spawnSync(command, args, {
    cwd: repository,
    env,
    stdio: ["ignore", fd, fd],
    timeout,
    killSignal: "SIGKILL",
  });
  closeSync(fd);
  const ok = outcome.error === undefined && outcome.signal === null && outcome.status === 0;
  receipt.push({
    name,
    command,
    args,
    ok,
    exit: outcome.status,
    signal: outcome.signal,
    error: outcome.error?.message,
    elapsedMs: Date.now() - started,
    file,
  });
  writeFileSync(path.join(logs, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n");
  console.log(`${ok ? "PASS" : "FAIL"} ${name}`);
  if (!ok)
    console.log(
      readFileSync(file, "utf8")
        .split("\n")
        .filter((line) => /Error|FAIL|failed|expected|actual|✖/.test(line))
        .slice(-15)
        .map((line) => line.slice(0, 400))
        .join("\n"),
    );
  return ok;
}
const prepare = [
  [
    "offline-dependencies",
    "npm",
    ["ci", "--offline", "--ignore-scripts", "--no-audit", "--no-fund"],
  ],
  ["patches", "npm", ["run", "postinstall"]],
  ["server-build", "npm", ["run", "build:server"]],
  ["app-dependencies", "npm", ["run", "build:app-deps"]],
  ["app-typecheck", "npm", ["run", "typecheck", "--workspace=@getpaseo/app"]],
];
for (const [name, command, args] of prepare)
  if (!step(name, command, args)) throw new Error(`HARNESS_PREPARATION_FAILED ${name}`);
const checks =
  mode === "feature"
    ? [
        [
          "jobs-wire-authority",
          process.execPath,
          ["--import", "tsx", "qa/pi-background-jobs/wire-primitive.mjs", inputRoot],
        ],
        [
          "jobs-native-renderer",
          process.execPath,
          ["qa/pi-background-jobs/run-browser.mjs", inputRoot],
        ],
      ]
    : [
        [
          "held-parent-prerequisite",
          process.execPath,
          ["--import", "tsx", "qa/pi-background-jobs/held-parent-primitive.mjs", inputRoot],
        ],
        [
          "delegate-result-prerequisite",
          process.execPath,
          ["--import", "tsx", "qa/pi-background-jobs/delegate-primitive.mjs", inputRoot],
        ],
        [
          "existing-pi-provider",
          process.execPath,
          [
            "node_modules/vitest/vitest.mjs",
            "run",
            "--config",
            "packages/server/vitest.config.ts",
            "packages/server/src/server/agent/providers/pi/agent.test.ts",
            "packages/server/src/server/agent/providers/pi/cli-runtime.test.ts",
            "packages/server/src/server/agent/providers/pi/branch-transition.test.ts",
            "packages/server/src/server/authorization/index.test.ts",
            "--bail=1",
          ],
        ],
        [
          "existing-session-permission-gate",
          process.execPath,
          [
            "node_modules/vitest/vitest.mjs",
            "run",
            "--config",
            "packages/server/vitest.config.ts",
            "packages/server/src/server/session.test.ts",
            "-t",
            "session authorization permissions",
            "--bail=1",
          ],
        ],
      ];
let failed = 0;
for (const [name, command, args] of checks) if (!step(name, command, args)) failed += 1;
verifyInput();
console.log(
  `Paseo background jobs ${mode}: ${checks.length - failed}/${checks.length} checks passed. Electron/Android/attended and deployment gates remain separate.`,
);
process.exitCode = failed === 0 ? 0 : 1;
