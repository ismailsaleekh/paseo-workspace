#!/usr/bin/env node
// Judge-owned Android build step for V2-A: development-variant Paseo release APK (embedded
// bundle, offline Gradle) plus the companion visual host when the candidate provides it.
// Paseo build failure is a harness preparation failure; an absent or invalid companion is a
// recorded feature failure so the Android prerequisite can still be checked.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  COMPANION_PACKAGE,
  PASEO_PACKAGE,
  androidEnv,
  cachedGradle,
  preparationFailure,
  repository,
  requireToolchain,
  tools,
} from "./lib.mjs";

const output = process.argv[2];
if (!output) throw new Error("usage: build.mjs <result.json>");
requireToolchain();
const env = androidEnv({
  APP_VARIANT: "development",
  CI: "1",
  EXPO_OFFLINE: "1",
  EXPO_NO_TELEMETRY: "1",
  EXPO_NO_DOTENV: "1",
});

function step(label, command, args, cwd) {
  process.stdout.write(`ANDROID BUILD ${label}\n`);
  const result = spawnSync(command, args, { cwd, env, stdio: "inherit" });
  return !result.error && result.status === 0;
}

function badging(apk) {
  return execFileSync(tools.aapt2, ["dump", "badging", apk], {
    env,
    encoding: "utf8",
    maxBuffer: 16 << 20,
  });
}
function certificate(apk) {
  const out = execFileSync(tools.apksigner, ["verify", "--print-certs", apk], {
    env,
    encoding: "utf8",
  });
  const digest = out.match(/certificate SHA-256 digest: ([0-9a-f]+)/);
  if (!digest) throw new Error(`no signing certificate in ${apk}`);
  return digest[1];
}
function onlyApk(directory) {
  const apks = existsSync(directory)
    ? readdirSync(directory).filter((name) => name.endsWith(".apk"))
    : [];
  if (apks.length !== 1)
    throw new Error(`expected exactly one APK in ${directory}, found ${apks.length}`);
  return path.join(directory, apks[0]);
}

const app = path.join(repository, "packages/app");
if (
  !step(
    "development prebuild",
    process.execPath,
    [
      path.join(repository, "node_modules/expo/bin/cli"),
      "prebuild",
      "--platform",
      "android",
      "--clean",
      "--no-install",
      "--skip-dependency-update",
      "expo,react-native",
      "--template",
      path.join(repository, "node_modules/expo/template.tgz"),
    ],
    app,
  )
) {
  throw preparationFailure("expo prebuild (android, development variant)");
}
if (
  !step(
    "Paseo release APK",
    path.join(app, "android/gradlew"),
    [
      "--offline",
      "--no-daemon",
      "--console=plain",
      ":app:assembleRelease",
      "-PreactNativeArchitectures=arm64-v8a",
    ],
    path.join(app, "android"),
  )
) {
  throw preparationFailure("Gradle assembleRelease for the Paseo app");
}
const paseoApk = onlyApk(path.join(app, "android/app/build/outputs/apk/release"));
if (!badging(paseoApk).includes(`package: name='${PASEO_PACKAGE}'`)) {
  throw preparationFailure(`Paseo APK is not ${PASEO_PACKAGE}`);
}
const keystore = path.join(app, "android/app/debug.keystore");
if (!existsSync(keystore)) throw preparationFailure("prebuilt debug keystore missing");

const result = {
  paseoApk,
  paseoCertificate: certificate(paseoApk),
  companionApk: null,
  companionError: null,
};
const companionProject = path.join(repository, "packages/visual-host-android");
if (
  !existsSync(path.join(companionProject, "settings.gradle")) &&
  !existsSync(path.join(companionProject, "settings.gradle.kts"))
) {
  result.companionError = "packages/visual-host-android Gradle project is absent";
} else if (
  !step(
    "companion visual host APK",
    cachedGradle(),
    [
      "-p",
      companionProject,
      "--offline",
      "--no-daemon",
      "--console=plain",
      "assembleRelease",
      `-PpaseoSigningStore=${keystore}`,
      "-PpaseoSigningAlias=androiddebugkey",
      "-PpaseoSigningPassword=android",
    ],
    repository,
  )
) {
  result.companionError = "companion Gradle build failed";
} else {
  try {
    const apk = onlyApk(path.join(companionProject, "app/build/outputs/apk/release"));
    const info = badging(apk);
    if (!info.includes(`package: name='${COMPANION_PACKAGE}'`))
      throw new Error(`companion is not ${COMPANION_PACKAGE}`);
    if (/uses-permission: name='android\.permission\.INTERNET'/.test(info)) {
      throw new Error("companion requests android.permission.INTERNET");
    }
    if (certificate(apk) !== result.paseoCertificate)
      throw new Error("companion is not signed with the Paseo signing key");
    result.companionApk = apk;
  } catch (error) {
    result.companionError = error.message;
  }
}
writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`);
process.stdout.write(`ANDROID BUILD RESULT ${JSON.stringify(result)}\n`);
