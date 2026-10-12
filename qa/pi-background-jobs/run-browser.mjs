#!/usr/bin/env node
// Independent targeted native-app renderer witness, with an explicit package fixture input.
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
const repository = process.cwd();
const packageRoot = process.argv[2];
if (!packageRoot || !path.isAbsolute(packageRoot))
  throw new Error("An absolute package fixture root is required");
if (!existsSync(path.join(packageRoot, "dist/extensions/background-tasks.js")))
  throw new Error("Package runtime missing");
const cli = path.join(repository, "node_modules/@playwright/test/cli.js");
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
if (version.status !== 0) throw new Error(`Cannot identify required Chrome: ${version.stderr}`);
console.log(
  `Background jobs browser target: Chrome ${version.stdout.trim()}; not physical phone proof`,
);
const names = new Set(["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "SHELL", "USER", "LOGNAME"]);
const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => names.has(name)));
Object.assign(env, {
  CI: "1",
  EXPO_OFFLINE: "1",
  PI_OFFLINE: "1",
  PI_TELEMETRY: "0",
  PI_SKIP_VERSION_CHECK: "1",
  npm_config_cache: "/Users/lizavasilyeva/work/paseo-env/npm",
  npm_config_offline: "true",
  PASEO_BG_ORACLE_PACKAGE: packageRoot,
});
const child = spawn(
  process.execPath,
  [
    cli,
    "test",
    "e2e/browser/pi-background-jobs.spec.ts",
    "--project=browser",
    "--workers=1",
    "--retries=0",
    "--global-timeout=600000",
  ],
  { cwd: path.join(repository, "packages/app"), env, stdio: "inherit" },
);
child.on("error", (error) => {
  console.error(error);
  process.exitCode = 1;
});
child.on("close", (code, signal) => {
  if (signal) console.error(`Browser witness terminated by ${signal}`);
  process.exitCode = code === 0 && signal === null ? 0 : 1;
});
process.on("SIGINT", () => child.kill("SIGINT"));
process.on("SIGTERM", () => child.kill("SIGTERM"));
