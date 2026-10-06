# Testing the visual workspace, agent speech and detours

Status: B1 conversation-detour candidate on top of landed V2-D, V2-A and S1. A listed command is not a passing receipt; acceptance requires the independent judge and an Accepted planc certificate, and physical HyperOS 3 / Android 16 verification is a separate later check.

## Isolation and prerequisites

Use the acquired implementation workspace or an isolated judge workspace. Never connect to or restart production daemon 6767, modify `/Applications/Paseo.app`, or use the user's Pi agent directory, settings, auth or sessions.

Required inputs are the paired fork, pinned lockfile/toolchain, Pi SDK 1.0.0, TypeBox 1.3.27, private warm npm cache, pinned Electron 44.2.0 archive cache, and the judge-selected installed Chrome for browser regressions. Android checks additionally need the private JDK 17, Android SDK 36 (build-tools 36.0.0, android-36 arm64 system image), the cached Gradle 8.14.3 distribution and Gradle user home under `/Users/lizavasilyeva/.cache/pi-paseo-workspace/`, all used offline. No paid model calls, provider credentials, online fallback or global-cache repair.

The task-owned npm cache is `/Users/lizavasilyeva/.cache/pi-paseo-workspace/npm`; Electron archives are under `/Users/lizavasilyeva/.cache/pi-paseo-workspace/electron`. Supply `npm_config_cache` to every diagnostic npm invocation. Omitting it makes installed-pair tests inherit npm's global cache; an EACCES there is an invocation error, not permission to chown the cache.

## Required Root

From the workspace root:

```sh
node qa/pi-workspace/judge-b1.mjs
```

The immutable B1 judge runs the shared preparation (locked offline dependencies, reviewed patches, producer and desktop builds, pinned Electron, app/desktop typechecks, prerequisite guards, the B1 harness prerequisite and the Android APK builds), then the default eight-tool `tool-contract.mjs`, package QA and pack, the V1 browser, V2-D desktop, B1 browser flow (`b1/run-b1.mjs`), V2-A Android and both S1 flows. The B1 flow drives the real Paseo Pi provider on an isolated daemon and browser app with the deterministic provider and checks the actual Pi JSONL tree, the model request trace, the daemon timeline API and the rendered timeline: mixed-batch refusal, open, detour work, return, reload, repeated return, nesting, input sent right after a transition, a daemon and Pi restart mid-detour, and judge-forced tree cancellation. One run takes roughly two hours; the judge AVD lock (`android-avd-judge/judge.lock`) prevents overlapping emulator runs and must not be removed while a judge runs.

The S1 judge `node qa/pi-workspace/judge-s1.mjs`, the Android visual judge `node qa/pi-workspace/judge-v2-android.mjs` and the desktop-only judge `node qa/pi-workspace/judge-v2-desktop.mjs` remain available.

Targeted B1 runs: `node qa/pi-workspace/tool-contract.mjs`; `node qa/pi-workspace/b1/run-b1.mjs` (about 10 minutes, no emulator; `--prerequisite` checks only the harness). Targeted S1 runs: `node qa/pi-workspace/s1/run-s1.mjs` (desktop); `node qa/pi-workspace/android/build.mjs <out.json>` then `node qa/pi-workspace/s1/run-s1-android.mjs --build <out.json>`.

The standalone V1 browser regression remains `node qa/pi-workspace/run-visual.mjs`. It is not Electron or Android proof. The desktop runner `node qa/pi-workspace/run-desktop.mjs` requires its prepared builds and pinned Electron; it is a targeted diagnostic, not a substitute for Root submission.

## Focused development checks

Rebuild producers before diagnosing consumer types:

```sh
npm --offline --cache /Users/lizavasilyeva/.cache/pi-paseo-workspace/npm run build:server
npm --offline --cache /Users/lizavasilyeva/.cache/pi-paseo-workspace/npm run build:main --workspace=@getpaseo/desktop
npm --offline --cache /Users/lizavasilyeva/.cache/pi-paseo-workspace/npm run typecheck --workspace=@getpaseo/app
npm --offline --cache /Users/lizavasilyeva/.cache/pi-paseo-workspace/npm run typecheck --workspace=@getpaseo/desktop
npm --offline --cache /Users/lizavasilyeva/.cache/pi-paseo-workspace/npm --prefix packages/pi-workspace test
npm --offline --cache /Users/lizavasilyeva/.cache/pi-paseo-workspace/npm --prefix packages/pi-workspace run pack:dry-run
```

The companion visual host builds alone with the cached Gradle distribution (environment as in `qa/pi-workspace/android/lib.mjs`: private `JAVA_HOME`, `ANDROID_HOME`, `GRADLE_USER_HOME`), signed with the key of the Paseo APK it will run beside:

```sh
gradle -p packages/visual-host-android --offline --no-daemon assembleRelease \
  -PpaseoSigningStore=<keystore> -PpaseoSigningAlias=<alias> -PpaseoSigningPassword=<password>
```

Native module changes need a rebuilt Paseo APK; Metro JS updates alone are not Android evidence.

The package default QA includes strict source/test typecheck, type-escape audit, source/tool/speak/branch tests, real SDK/RPC scripted-provider checks (including detours against a minimal attached test host), paired-artifact tests, and the explicitly listed host/controller/speech/dictation/desktop feature suites plus the Pi provider detour settlement and agent-manager timeline-replacement suites. It does not run the whole monorepo suite. Use `test:unit`, `test:sdk`, `test:rpc`, `test:package` and `test:host` for targeted work. A single Vitest invocation may name related owned test files with `--bail=1 --maxWorkers=1`.

Use root `npm run format:files -- <exact changed paths>`, `format:check:files` and `lint` scripts. Never weaken lint/type rules, edit generated validators manually, run the complete upstream test suite, or use the unavailable macOS `timeout` command. The feature preload is compiled by the existing desktop tsconfig and has electron-only runtime imports.

The Pi package stays TypeScript-loaded and no-emit checked with strict ESNext/Bundler resolution; `skipLibCheck` remains false. SDK/RPC and installed-pair execution verify actual runtime loading independently of typechecking.

## Diagnostics and evidence

The package harness creates temporary HOME, project, agent and session directories. It supplies `PI_OFFLINE=1`, `PI_TELEMETRY=0`, `PI_SKIP_VERSION_CHECK=1`, `CI=1` and offline npm settings. RPC tests split JSONL on newline only and wait for settlement. Scripted-provider traces stay in test-owned files and do not invoke a network model.

Paired-artifact tests pack the fork protocol and Pi package, install both into an empty temporary directory, verify artifact/source identity and absence of workspace links, and execute the installed extension through real Pi. The upstream same-numbered protocol package is not interchangeable.

The real desktop oracle decodes a private motif absent from published state, checks multiple displays, observes TCP/UDP egress sinks, verifies renderer termination with a preserved composer draft, and relaunches with isolated userData. The Android oracle decodes the same motif from independent `adb` screencaps and from the Pi image, observes sinks reached through the emulator host alias, and treats any ANR dialog during feature checks as a failure. Read the complete saved log; neither exit 1 alone nor a source inspection identifies a valid feature failure. Supervisor-mediated probes may save full stdout/stderr outside the repository. Keep their unit/workspace binding and exact command with the receipt.

No flake or unsupported target is silently waived. Physical HyperOS 3 / Android 16 evidence (including dictation and audible playback with a real microphone and speaker, and detours on the phone) and deployment remain later gates. Do not mark those as passed from browser, Electron or emulator output.
