#!/usr/bin/env node
// Judge-owned VS2 runner: (1) web lane, installed Chrome against the web bridge (also used by the
// iOS and Android displays): an agent action during fast typing on a slow link; (2) desktop lane,
// real Electron 44.2.0 running the checkout desktop main: fast typing, cross-window convergence,
// conflicts and an agent action during typing. Both lanes always run; the exit code is 0 only when
// both pass. The Playwright harness owns daemon/Metro teardown in each lane.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const repository = process.cwd();
const cache = path.join(homedir(), ".cache", "pi-paseo-workspace");
const chromeApp = "/Applications/Google Chrome.app";
const cli = path.join(repository, "node_modules", "@playwright", "test", "cli.js");
const electronDist = path.join(repository, "node_modules", "electron", "dist");
const required = [
  cli,
  path.join(chromeApp, "Contents/MacOS/Google Chrome"),
  path.join(electronDist, "Electron.app/Contents/MacOS/Electron"),
  path.join(repository, "packages/desktop/dist/main.js"),
];
for (const file of required) {
  if (!existsSync(file)) throw new Error(`HARNESS_PREPARATION_FAILED: missing ${file}`);
}
const chromeVersion = spawnSync(
  "/usr/bin/plutil",
  ["-extract", "CFBundleShortVersionString", "raw", path.join(chromeApp, "Contents/Info.plist")],
  { encoding: "utf8" },
);
if (chromeVersion.status !== 0)
  throw new Error(`Cannot identify the selected Chrome build: ${chromeVersion.stderr}`);
const electronVersion = readFileSync(path.join(electronDist, "version"), "utf8").trim();
if (electronVersion !== "44.2.0")
  throw new Error(`HARNESS_PREPARATION_FAILED: Electron ${electronVersion}, expected 44.2.0`);

const inheritedEnvironment = new Set([
  "PATH",
  "HOME",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "SHELL",
  "USER",
  "LOGNAME",
]);
function environment(extra) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => inheritedEnvironment.has(name)),
  );
  return Object.assign(env, {
    CI: "1",
    EXPO_OFFLINE: "1",
    PI_OFFLINE: "1",
    PI_TELEMETRY: "0",
    PI_SKIP_VERSION_CHECK: "1",
    npm_config_cache: path.join(cache, "npm"),
    npm_config_offline: "true",
    ...extra,
  });
}
const lanes = [
  {
    name: "web",
    banner: `Browser target: installed Google Chrome ${chromeVersion.stdout.trim()} (web bridge; not Electron or native phone)`,
    spec: "e2e/browser/pi-workspace-state-sync-action.spec.ts",
    env: environment({}),
  },
  {
    name: "desktop",
    banner: `Desktop target: real Electron ${electronVersion} (not Android)`,
    spec: "e2e/browser/pi-workspace-state-sync-desktop.spec.ts",
    env: environment({
      E2E_DESKTOP_RUNTIME: "1",
      // Bundle-time local-daemon override: an unreachable discard port, never production 6767.
      EXPO_PUBLIC_LOCAL_DAEMON: "127.0.0.1:9",
    }),
  },
];

let active = null;
function runLane(lane) {
  process.stdout.write(`VS2 ${lane.name} lane. ${lane.banner}\n`);
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [
        cli,
        "test",
        lane.spec,
        "--project=browser",
        "--workers=1",
        "--retries=0",
        "--global-timeout=1200000",
      ],
      { cwd: path.join(repository, "packages/app"), env: lane.env, stdio: "inherit" },
    );
    active = child;
    child.on("error", (error) => {
      process.stderr.write(`VS2 ${lane.name} lane could not start: ${error.message}\n`);
      active = null;
      resolve(false);
    });
    child.on("close", (code, signal) => {
      if (signal) process.stderr.write(`VS2 ${lane.name} lane terminated by ${signal}\n`);
      active = null;
      resolve(code === 0 && signal === null);
    });
  });
}
process.on("SIGINT", () => active?.kill("SIGINT"));
process.on("SIGTERM", () => active?.kill("SIGTERM"));

const results = [];
for (const lane of lanes) results.push(await runLane(lane));
const passed = results.filter(Boolean).length;
process.stdout.write(`VS2 lanes passed: ${passed}/${lanes.length}\n`);
process.exitCode = passed === lanes.length ? 0 : 1;
