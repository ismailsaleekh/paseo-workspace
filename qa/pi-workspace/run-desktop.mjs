#!/usr/bin/env node
// Judge-owned real-Electron runner. The Playwright harness owns the isolated daemon and Metro;
// the spec launches the checkout desktop main with isolated HOME/userData and Electron 44.2.0.
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const repository = process.cwd();
const cache = path.join(homedir(), ".cache", "pi-paseo-workspace");
const cli = path.join(repository, "node_modules", "@playwright", "test", "cli.js");
const electronDist = path.join(repository, "node_modules", "electron", "dist");
const required = [
  cli,
  path.join(electronDist, "Electron.app/Contents/MacOS/Electron"),
  path.join(repository, "packages/desktop/dist/main.js"),
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
];
for (const file of required) {
  if (!existsSync(file)) throw new Error(`HARNESS_PREPARATION_FAILED: missing ${file}`);
}
const electronVersion = readFileSync(path.join(electronDist, "version"), "utf8").trim();
if (electronVersion !== "44.2.0")
  throw new Error(`HARNESS_PREPARATION_FAILED: Electron ${electronVersion}, expected 44.2.0`);
const lane = process.argv.includes("--prerequisite") ? "prerequisite" : "feature";
process.stdout.write(
  `Desktop target: real Electron ${electronVersion}, ${lane} lane (not Android)\n`,
);
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
const env = Object.fromEntries(
  Object.entries(process.env).filter(([name]) => inheritedEnvironment.has(name)),
);
Object.assign(env, {
  CI: "1",
  EXPO_OFFLINE: "1",
  E2E_DESKTOP_RUNTIME: "1",
  // Bundle-time local-daemon override: an unreachable discard port, never production 6767.
  EXPO_PUBLIC_LOCAL_DAEMON: "127.0.0.1:9",
  PI_OFFLINE: "1",
  PI_TELEMETRY: "0",
  PI_SKIP_VERSION_CHECK: "1",
  npm_config_cache: path.join(cache, "npm"),
  npm_config_offline: "true",
});
const grep = lane === "prerequisite" ? "harness prerequisite" : "desktop V2: isolated guest";
const child = spawn(
  process.execPath,
  [
    cli,
    "test",
    "e2e/browser/pi-workspace-desktop.spec.ts",
    "--project=browser",
    "--workers=1",
    "--retries=0",
    "--grep",
    grep,
    "--global-timeout=1200000",
  ],
  { cwd: path.join(repository, "packages/app"), env, stdio: "inherit" },
);
child.on("error", (error) => {
  process.stderr.write(`Desktop oracle could not start: ${error.message}\n`);
  process.exitCode = 1;
});
child.on("close", (code, signal) => {
  if (signal) process.stderr.write(`Desktop oracle terminated by ${signal}\n`);
  process.exitCode = code === 0 && signal === null ? 0 : 1;
});
process.on("SIGINT", () => child.kill("SIGINT"));
process.on("SIGTERM", () => child.kill("SIGTERM"));
