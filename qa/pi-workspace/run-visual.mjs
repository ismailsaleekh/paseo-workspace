#!/usr/bin/env node
// Judge-owned targeted runner; the existing Playwright harness owns daemon/Metro teardown.
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const repository = process.cwd();
const cache = path.join(homedir(), ".cache", "pi-paseo-workspace");
const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const cli = path.join(repository, "node_modules", "@playwright", "test", "cli.js");
if (!existsSync(cli))
  throw new Error("Prepare the pinned offline dependencies before running the visual oracle");
if (!existsSync(chrome))
  throw new Error("This browser-only oracle explicitly requires installed Google Chrome");
const version = spawnSync(
  "/usr/bin/plutil",
  [
    "-extract",
    "CFBundleShortVersionString",
    "raw",
    "/Applications/Google Chrome.app/Contents/Info.plist",
  ],
  { encoding: "utf8" },
);
if (version.status !== 0)
  throw new Error(`Cannot identify the selected Chrome build: ${version.stderr}`);
process.stdout.write(
  `Browser target: installed Google Chrome ${version.stdout.trim()} (not Electron or native phone)\n`,
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
  PI_OFFLINE: "1",
  PI_TELEMETRY: "0",
  PI_SKIP_VERSION_CHECK: "1",
  npm_config_cache: path.join(cache, "npm"),
  npm_config_offline: "true",
});
const child = spawn(
  process.execPath,
  [
    cli,
    "test",
    "e2e/browser/pi-workspace-visual.spec.ts",
    "--project=browser",
    "--workers=1",
    "--retries=0",
    "--global-timeout=600000",
  ],
  { cwd: path.join(repository, "packages/app"), env, stdio: "inherit" },
);
child.on("error", (error) => {
  process.stderr.write(`Visual oracle could not start: ${error.message}\n`);
  process.exitCode = 1;
});
child.on("close", (code, signal) => {
  if (signal) process.stderr.write(`Visual oracle terminated by ${signal}\n`);
  process.exitCode = code === 0 && signal === null ? 0 : 1;
});
process.on("SIGINT", () => child.kill("SIGINT"));
process.on("SIGTERM", () => child.kill("SIGTERM"));
