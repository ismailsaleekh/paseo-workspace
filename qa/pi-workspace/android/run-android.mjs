#!/usr/bin/env node
// Judge-owned V2-A Android flow: real Pi -> isolated daemon -> real Paseo Android app on a fresh
// emulator (or an explicitly named device), checked with independent adb screencaps, a
// loopback egress sink and actual persisted Pi tool results. --prerequisite checks only that
// the harness reaches a displayed visual (must pass on the pre-V2-A product).
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { _electron as electron } from "@playwright/test";
import {
  COMPANION_PACKAGE,
  Device,
  PASEO_PACKAGE,
  SINK_HOST_FROM_EMULATOR,
  connectClient,
  decodeMotif,
  errorCode,
  fail,
  freePort,
  makeTemp,
  piDriver,
  repository,
  rm,
  sleep,
  startEmulator,
  startIsolatedDaemon,
  startSink,
  stopChild,
  waitFor,
  writeFile,
} from "./lib.mjs";

const argv = process.argv.slice(2);
const option = (name) => {
  const index = argv.indexOf(name);
  return index === -1 ? null : argv[index + 1];
};
const prerequisiteOnly = argv.includes("--prerequisite");
const buildResult = JSON.parse(
  await readFile(option("--build") ?? fail("--build <result.json> required"), "utf8"),
);
const serial = option("--serial");
const sinkHost = option("--sink-host") ?? SINK_HOST_FROM_EMULATOR;
const fixtures = path.join(repository, "qa/pi-workspace/fixtures");
const egressVectors = [
  "fetch",
  "xhr",
  "websocket",
  "eventSource",
  "image",
  "cssBackground",
  "cssImport",
  "font",
  "svgImage",
  "audio",
  "video",
  "script",
  "stylesheet",
  "prefetch",
  "iframe",
  "beacon",
  "dynamicImport",
  "worker",
  "serviceWorker",
  "form",
  "preconnect",
  "ping",
  "webTransport",
  "webrtc",
  "webrtcNestedFrame",
  "webrtcSrcdocFrame",
];

/** Reads the private motif code from whichever Electron frame displays the touch witness. */
async function readDesktopMotif(app) {
  return app.evaluate(async ({ webContents }) => {
    const script =
      "document.title === 'Touch pixel witness' ? document.getElementById('pattern').textContent : null";
    const bounded = (frame) =>
      Promise.race([
        frame.executeJavaScript(script).catch(() => null),
        new Promise((resolve) => setTimeout(resolve, 1500, null)),
      ]);
    for (const contents of webContents.getAllWebContents()) {
      if (contents.isDestroyed()) continue;
      for (const frame of contents.mainFrame.framesInSubtree) {
        const value = await bounded(frame);
        if (typeof value === "string" && /^[0-9a-f]{48}$/.test(value)) return value;
      }
    }
    return null;
  });
}

let passed = 0;
let activeDevice = null;
async function check(label, body) {
  process.stdout.write(`ANDROID CHECK ${label}\n`);
  try {
    const value = await body();
    passed += 1;
    process.stdout.write(`ANDROID PASS ${label}\n`);
    return value;
  } catch (error) {
    process.stdout.write(`ANDROID FAIL ${label}: ${error.stack ?? error.message}\n`);
    if (activeDevice) {
      try {
        await writeFile(
          path.join(root, `failure-${passed + 1}.png`),
          await activeDevice.screencap(),
        );
        const visible = activeDevice
          .dump()
          .filter((node) => node.text || node.id)
          .map((node) => `${node.id} ${JSON.stringify(node.text)}`);
        await writeFile(path.join(root, `failure-${passed + 1}.txt`), `${visible.join("\n")}\n`);
        process.stdout.write(`failure screen: ${visible.slice(0, 25).join(" | ")}\n`);
      } catch (artifactError) {
        process.stdout.write(`failure artifacts unavailable: ${artifactError.message}\n`);
      }
    }
    throw error;
  }
}

const root = await makeTemp("paseo-android-judge-");
process.stdout.write(`Android evidence directory: ${root}\n`);
const cleanups = [];
let exitCode = 1;
try {
  let device;
  if (serial) {
    device = new Device(serial);
    if (device.tryShell(["getprop", "sys.boot_completed"]) !== "1")
      fail(`device ${serial} is not ready`);
  } else {
    const emulator = await startEmulator(root);
    device = emulator.device;
    cleanups.push(emulator.close);
  }
  activeDevice = device;
  process.stdout.write(
    `Android target: ${device.serial} Android ${device.shell(["getprop", "ro.build.version.release"])} (${serial ? "named device" : "fresh judge emulator — not physical-device evidence"})\n`,
  );
  const desktop = !prerequisiteOnly && !argv.includes("--skip-desktop");
  const metroPort = desktop ? await freePort() : null;
  const daemon = await startIsolatedDaemon(
    path.join(root, "daemon"),
    metroPort ? { corsOrigin: `http://localhost:${metroPort}` } : {},
  );
  cleanups.push(daemon.close);
  device.reverse(daemon.port);
  device.install(buildResult.paseoApk);
  if (buildResult.companionApk) device.install(buildResult.companionApk);

  const client = await connectClient(daemon.port);
  cleanups.push(() => client.close());
  const cwd = await makeTemp("paseo-android-project-");
  cleanups.push(() => rm(cwd, { recursive: true, force: true }));
  const created = await client.createWorkspace({
    source: { kind: "directory", path: cwd },
    title: "Android judge",
  });
  if (!created.workspace) fail(created.error ?? "workspace creation failed");
  const agent = await client.createAgent({
    provider: "pi",
    model: "pi-workspace-oracle/scripted",
    thinkingOptionId: "off",
    cwd,
    workspaceId: created.workspace.id,
    title: "Android judge visual",
  });
  const pi = piDriver({ client, agentId: agent.id, cwd, piDir: daemon.piDir });

  async function present(name, title, html) {
    const file = path.join(cwd, name);
    await writeFile(file, html, "utf8");
    const outcome = await pi.call("visual_present", { mode: "new", title, file });
    if (outcome.details?.status !== "rendered")
      fail(`present not rendered: ${JSON.stringify(outcome.details)}`);
    return outcome.details;
  }
  async function inspect(args = {}, expectError = false) {
    return pi.call("visual_inspect", args, expectError);
  }
  async function screenMotif(previous = null) {
    await dismissOverlays();
    return waitFor(
      "a fresh private motif on the device screen",
      async () => {
        const decoded = await decodeMotif(await device.screencap());
        return decoded && decoded.code !== previous ? decoded : null;
      },
      { timeout: 30_000, interval: 1000 },
    );
  }
  function screenSummary() {
    return device
      .dump()
      .filter((node) => node.id && !node.id.startsWith("android:") && !node.id.includes(":id/"))
      .map((node) => node.id)
      .slice(0, 12)
      .join(",");
  }
  /** Overlays (sidebar, command center) must not cover the conversation being observed. */
  async function dismissOverlays() {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const nodes = device.dump();
      const sidebarClose = nodes.find((node) => node.id === "sidebar-close" && node.bounds);
      if (sidebarClose) {
        const [x1, y1, x2, y2] = sidebarClose.bounds;
        device.tap((x1 + x2) / 2, (y1 + y2) / 2);
      } else if (nodes.some((node) => node.id === "command-center-input")) {
        device.key(4);
      } else {
        return;
      }
      await sleep(1000);
    }
    fail(`an overlay still covers the conversation: ${screenSummary()}`);
  }
  async function openConversation() {
    device.deepLink(`paseo:///h/${daemon.serverId}/agent/${agent.id}`, PASEO_PACKAGE);
    process.stdout.write(`after deep link: ${screenSummary()}\n`);
    // Phone layout: a cold deep link waits for workspace hydration, which the sidebar triggers.
    await sleep(3000);
    if (!device.find("message-input-root")) {
      await device.tapId("menu-button", 30_000);
      await sleep(2000);
    }
    await device.waitForId("message-input-root", 60_000);
    await dismissOverlays();
    if (!device.find("message-input-root")) fail(`conversation not displayed: ${screenSummary()}`);
  }

  /**
   * Harness setup only (never a feature check): on the software-rendered emulator a sheet opened
   * during cold start can stall with a dim backdrop and no content. Dismiss it and tap again.
   */
  async function openDirectConnectionForm() {
    await device.waitForId("welcome-screen", 90_000);
    await sleep(2000);
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await device.tapId("welcome-direct-connection", 30_000);
      try {
        await device.waitForId("direct-host-input", 20_000);
        return;
      } catch {
        process.stdout.write(
          `direct connection form did not open (attempt ${attempt}); retrying\n`,
        );
        device.key(4);
        await sleep(2000);
        if (!device.find("welcome-screen")) device.start(`${PASEO_PACKAGE}/.MainActivity`);
      }
    }
    fail("the direct connection form never opened");
  }

  await check("Paseo Android app connects to the isolated daemon", async () => {
    device.start(`${PASEO_PACKAGE}/.MainActivity`);
    await openDirectConnectionForm();
    await device.typeInto("direct-host-input", "127.0.0.1");
    await device.typeInto("direct-port-input", String(daemon.port));
    device.key(66);
    await waitFor(
      "connection to leave the welcome screen",
      () => !device.find("welcome-screen") && !device.find("add-host-modal"),
      { timeout: 60_000, interval: 1000 },
    );
    await device.waitForId("menu-button", 60_000);
    await openConversation();
  });

  const pixels = await readFile(path.join(fixtures, "client-pixels-touch.html"), "utf8");
  const shown = await check(
    "prerequisite: real Pi visual is displayed on the Android client",
    async () => {
      const details = await present("pixels.html", "Touch pixels", pixels);
      await screenMotif();
      return details;
    },
  );
  if (prerequisiteOnly) {
    exitCode = 0;
  } else {
    const paseoPid = device.pid(PASEO_PACKAGE);
    // Cold-start ANRs on a freshly wiped software-rendered emulator are tolerated above; from here
    // on any "isn't responding" dialog is a product failure.
    const anrBaseline = device.anrCount;

    const androidClient = await check(
      "documents render in the no-INTERNET visual host app",
      async () => {
        if (!buildResult.companionApk)
          fail(`visual host APK unavailable: ${buildResult.companionError}`);
        if (!device.installed(COMPANION_PACKAGE)) fail("visual host app not installed");
        const permissions = device.requestedPermissions(COMPANION_PACKAGE);
        if (permissions.includes("android.permission.INTERNET"))
          fail("visual host requests INTERNET");
        const companionPid = await waitFor(
          "visual host process",
          () => device.pid(COMPANION_PACKAGE),
          { timeout: 15_000 },
        );
        if (device.uid(COMPANION_PACKAGE) === device.uid(PASEO_PACKAGE))
          fail("visual host shares Paseo's UID");
        const inspected = (await inspect({ id: shown.id })).details;
        const display = (inspected.displays ?? []).find((entry) => entry.platform === "android");
        if (!display || !display.active || inspected.client !== display.client) {
          fail(`no active android display: ${JSON.stringify(inspected.displays)}`);
        }
        process.stdout.write(
          `visual host pid ${companionPid}, android display ${display.client}\n`,
        );
        return display.client;
      },
    );

    await check("actual Android pixels twice; stale capture rejected", async () => {
      const first = await screenMotif();
      const shot1 = await inspect({ id: shown.id, screenshot: true });
      if (shot1.details?.screenshot?.client !== androidClient)
        fail("screenshot not labelled with the android client");
      if ((await decodeMotif(shot1.png))?.code !== first.code)
        fail("first capture does not show the displayed motif");
      const { minX, minY, maxX, maxY } = first.box;
      device.tap((minX + maxX) / 2, (minY + maxY) / 2);
      const second = await screenMotif(first.code);
      const shot2 = await inspect({ id: shown.id, screenshot: true });
      if ((await decodeMotif(shot2.png))?.code !== second.code)
        fail("second capture does not show the repainted motif");
      if ((await decodeMotif(shot1.png))?.code === second.code)
        fail("stale capture matched the new motif");
      await writeFile(path.join(root, "android-capture.png"), shot2.png);
    });

    await check("every egress path and privilege blocked; navigation denied", async () => {
      const sink = await startSink();
      try {
        const egress = (await readFile(path.join(fixtures, "egress.html"), "utf8"))
          .replaceAll("__SINK_HOST__", sinkHost)
          .replaceAll("__SINK_PORT__", String(sink.port))
          .replaceAll("__SINK_UDP_PORT__", String(sink.udpPort));
        const presented = await present("egress.html", "Egress witness", egress);
        const state = await waitFor(
          "egress witness completion",
          async () => {
            const value = (await inspect({ id: presented.id })).details.state;
            return value?.done === true ? value : null;
          },
          { timeout: 40_000, interval: 2000 },
        );
        // The witness appends its navigation-like vectors after it publishes done; a later read
        // may already include them. Require every early vector in order, then only declared late
        // vectors in order.
        const early = state.attempted.slice(0, egressVectors.length);
        const late = state.attempted.slice(egressVectors.length);
        if (JSON.stringify(early) !== JSON.stringify(egressVectors))
          fail(`attempted ${JSON.stringify(state.attempted)}`);
        if (
          JSON.stringify(state.lateVectors) !==
          JSON.stringify(["windowOpen", "download", "topNavigation"])
        )
          fail(`late vectors ${JSON.stringify(state.lateVectors)}`);
        if (JSON.stringify(late) !== JSON.stringify(state.lateVectors.slice(0, late.length)))
          fail(`unexpected trailing vectors ${JSON.stringify(late)}`);
        const p = state.privileged;
        for (const key of [
          "require",
          "process",
          "module",
          "paseoDesktop",
          "electron",
          "ipcRenderer",
        ]) {
          if (p[key] !== "undefined") fail(`privileged ${key} = ${p[key]}`);
        }
        if (p.fileFetch !== "blocked") fail(`file fetch ${p.fileFetch}`);
        if (!["denied", "default", "unavailable"].includes(p.notification))
          fail(`notification ${p.notification}`);
        if (!["denied", "unavailable"].includes(p.media)) fail(`microphone ${p.media}`);
        await sleep(6000);
        if (sink.arrivals.length > 0)
          fail(`egress reached the sink: ${JSON.stringify(sink.arrivals)}`);
        const after = (await inspect({ id: presented.id })).details;
        if (
          after.client !== androidClient &&
          !(after.displays ?? []).some((d) => d.platform === "android")
        ) {
          fail("egress document is no longer displayed on Android");
        }
      } finally {
        await sink.close();
      }
    });

    await check("hung document terminated; Paseo stays responsive", async () => {
      const hang = await readFile(path.join(fixtures, "hang.html"), "utf8");
      const presented = await present("hang.html", "Hang witness", hang);
      await pi.call("visual_act", { id: presented.id, action: "freeze", value: {} });
      await sleep(1500);
      const composer = device
        .dump()
        .find((node) => node.cls === "android.widget.EditText" && node.bounds);
      if (!composer) fail("composer input not found");
      const [x1, y1, x2, y2] = composer.bounds;
      device.tap((x1 + x2) / 2, (y1 + y2) / 2);
      await sleep(500);
      for (const character of "draft") {
        device.shell(["input", "text", character]);
        await sleep(150);
      }
      await waitFor(
        "composer accepted typing",
        () =>
          device
            .dump()
            .some((node) => node.cls === "android.widget.EditText" && node.text.includes("draft")),
        { timeout: 10_000 },
      );
      const started = Date.now();
      const unresponsive = await inspect({ id: presented.id }, true);
      if (errorCode(unresponsive) !== "DOCUMENT_UNRESPONSIVE")
        fail(`expected DOCUMENT_UNRESPONSIVE, got ${errorCode(unresponsive)}`);
      if (Date.now() - started > 25_000) fail("unresponsive detection exceeded 25 s");
      if (device.pid(PASEO_PACKAGE) !== paseoPid) fail("Paseo process restarted");
      device.key(111);
      const reopened = await pi.call("visual_present", { mode: "open", id: shown.id });
      if (reopened.details?.status !== "rendered") fail("reopen after hang not rendered");
      const motif = await screenMotif();
      if (
        (await decodeMotif((await inspect({ id: shown.id, screenshot: true })).png))?.code !==
        motif.code
      )
        fail("capture after recovery mismatched");
    });

    await check("background releases the display; foreground restores it", async () => {
      device.key(3);
      await sleep(4000);
      const gone = await inspect({ id: shown.id, screenshot: true, client: androidClient }, true);
      if (errorCode(gone) !== "DISPLAY_UNAVAILABLE")
        fail(`backgrounded capture returned ${errorCode(gone)}`);
      if (gone.png) fail("backgrounded display returned pixels");
      const nobody = await inspect({ id: shown.id }, true);
      if (errorCode(nobody) !== "CLIENT_UNAVAILABLE")
        fail(`no-display inspect returned ${errorCode(nobody)}`);
      device.start(`${PASEO_PACKAGE}/.MainActivity`);
      await waitFor(
        "android display after foreground",
        async () =>
          ((await inspect({ id: shown.id })).details.displays ?? []).some(
            (d) => d.platform === "android",
          ),
        { timeout: 45_000, interval: 3000 },
      );
      const motif = await screenMotif();
      if (
        (await decodeMotif((await inspect({ id: shown.id, screenshot: true })).png))?.code !==
        motif.code
      )
        fail("capture after foreground mismatched");
    });

    await check("visual host death never crashes Paseo; reopen recovers", async () => {
      device.forceStop(COMPANION_PACKAGE);
      await sleep(3000);
      if (device.pid(PASEO_PACKAGE) !== paseoPid) fail("Paseo crashed when the visual host died");
      const reopened = await pi.call("visual_present", { mode: "open", id: shown.id });
      if (reopened.details?.status !== "rendered")
        fail("reopen after visual host death not rendered");
      const motif = await screenMotif();
      if (
        (await decodeMotif((await inspect({ id: shown.id, screenshot: true })).png))?.code !==
        motif.code
      )
        fail("capture after host death mismatched");
    });

    await check(
      "missing visual host: explicit RENDERER_UNAVAILABLE, no in-app fallback",
      async () => {
        device.uninstall(COMPANION_PACKAGE);
        await sleep(3000);
        if (device.pid(PASEO_PACKAGE) !== paseoPid)
          fail("Paseo crashed when the visual host was removed");
        const file = path.join(cwd, "fallback.html");
        await writeFile(file, pixels, "utf8");
        const refused = await pi.call(
          "visual_present",
          { mode: "new", title: "No host", file },
          true,
        );
        if (errorCode(refused) !== "RENDERER_UNAVAILABLE")
          fail(`expected RENDERER_UNAVAILABLE, got ${errorCode(refused)}`);
        await sleep(3000);
        if (await decodeMotif(await device.screencap()))
          fail("a motif is displayed without the visual host (in-app fallback)");
        device.install(buildResult.companionApk);
        const reopened = await pi.call("visual_present", { mode: "open", id: shown.id });
        if (reopened.details?.status !== "rendered") fail("reopen after reinstall not rendered");
        await screenMotif();
      },
    );

    await check("relaunch restores the stored visual into a fresh document", async () => {
      const before = (await inspect({ id: shown.id })).details.state;
      device.forceStop(PASEO_PACKAGE);
      device.start(`${PASEO_PACKAGE}/.MainActivity`);
      await openConversation();
      const reopened = await pi.call("visual_present", { mode: "open", id: shown.id });
      if (reopened.details?.status !== "rendered") fail("reopen after relaunch not rendered");
      const after = (await inspect({ id: shown.id })).details.state;
      if (JSON.stringify(after) !== JSON.stringify(before))
        fail(
          `state changed across relaunch: ${JSON.stringify(before)} -> ${JSON.stringify(after)}`,
        );
      const motif = await screenMotif();
      if (
        (await decodeMotif((await inspect({ id: shown.id, screenshot: true })).png))?.code !==
        motif.code
      )
        fail("capture after relaunch mismatched");
    });

    if (desktop) {
      await check(
        "desktop and Android display the same visual; addressed captures stay per client",
        async () => {
          const metroLog = path.join(root, "metro.log");
          const { openSync, closeSync } = await import("node:fs");
          const log = openSync(metroLog, "w");
          const metro = spawn(
            process.execPath,
            [
              path.join(repository, "node_modules/expo/bin/cli"),
              "start",
              "--web",
              "--port",
              String(metroPort),
              "--offline",
            ],
            {
              cwd: path.join(repository, "packages/app"),
              env: {
                PATH: process.env.PATH ?? "",
                HOME: process.env.HOME ?? "",
                TMPDIR: process.env.TMPDIR ?? "",
                CI: "1",
                BROWSER: "none",
                EXPO_NO_DOTENV: "1",
                PASEO_WEB_PLATFORM: "electron",
                EXPO_PUBLIC_LOCAL_DAEMON: "127.0.0.1:9",
              },
              stdio: ["ignore", log, log],
            },
          );
          closeSync(log);
          cleanups.push(() => stopChild(metro, "Metro"));
          await waitFor(
            "Metro",
            async () => (await fetch(`http://127.0.0.1:${metroPort}/status`)).ok,
            { timeout: 120_000, interval: 1000 },
          );
          const { warmMetro } = await import(
            path.join(repository, "packages/app/e2e/support/metro-warmup.mjs")
          );
          await warmMetro(metroPort);
          const runtime = await makeTemp("paseo-android-desktop-");
          cleanups.push(() => rm(runtime, { recursive: true, force: true }));
          const app = await electron.launch({
            executablePath: path.join(
              repository,
              "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron",
            ),
            args: [path.join(repository, "qa/pi-workspace/electron-quiet.cjs")],
            cwd: repository,
            env: {
              PATH: process.env.PATH ?? "",
              TMPDIR: process.env.TMPDIR ?? "",
              HOME: path.join(runtime, "home"),
              PASEO_HOME: path.join(root, "daemon", "paseo"),
              EXPO_DEV_URL: `http://localhost:${metroPort}`,
              PASEO_DISABLE_SINGLE_INSTANCE_LOCK: "1",
              PASEO_ELECTRON_USER_DATA_DIR: path.join(runtime, "user-data"),
              PASEO_ORACLE_DESKTOP_MAIN: path.join(repository, "packages/desktop/dist/main.js"),
            },
            timeout: 120_000,
          });
          cleanups.push(() => app.close());
          const page = await app.firstWindow({ timeout: 120_000 });
          await page.route(/:(6767|6768)\b/, (route) => route.abort());
          await page.waitForLoadState("domcontentloaded");
          const now = new Date().toISOString();
          const host = {
            serverId: daemon.serverId,
            label: "localhost",
            connections: [
              {
                id: `direct:127.0.0.1:${daemon.port}`,
                type: "directTcp",
                endpoint: `127.0.0.1:${daemon.port}`,
              },
            ],
            preferredConnectionId: `direct:127.0.0.1:${daemon.port}`,
            createdAt: now,
            updatedAt: now,
          };
          await page.evaluate((entry) => {
            localStorage.setItem("@paseo:e2e", "1");
            localStorage.setItem("@paseo:daemon-registry", JSON.stringify([entry]));
            localStorage.removeItem("@paseo:settings");
          }, host);
          await page.goto(
            `http://localhost:${metroPort}/h/${encodeURIComponent(daemon.serverId)}/agent/${encodeURIComponent(agent.id)}`,
          );
          await page.getByTestId("message-input-root").waitFor({ timeout: 90_000 });
          const displays = await waitFor(
            "desktop and android displays",
            async () => {
              const list = (await inspect({ id: shown.id })).details.displays ?? [];
              return list.some((d) => d.platform === "android") &&
                list.some((d) => d.platform === "electron")
                ? list
                : null;
            },
            { timeout: 60_000, interval: 3000 },
          );
          const desktopClient = displays.find((d) => d.platform === "electron").client;
          const androidDisplay = displays.find((d) => d.platform === "android").client;
          const desktopMotif = await waitFor("desktop motif", () => readDesktopMotif(app));
          const androidMotif = await screenMotif();
          if (desktopMotif === androidMotif.code)
            fail("desktop and android motifs are not independent");
          const androidShot = await inspect({
            id: shown.id,
            screenshot: true,
            client: androidDisplay,
          });
          if ((await decodeMotif(androidShot.png))?.code !== androidMotif.code)
            fail("addressed android capture mismatched");
          const desktopShot = await inspect({
            id: shown.id,
            screenshot: true,
            client: desktopClient,
          });
          if ((await decodeMotif(desktopShot.png))?.code !== desktopMotif)
            fail("addressed desktop capture mismatched");
        },
      );
    }
    await check("Paseo never stopped responding during feature checks", async () => {
      if (device.anrCount > anrBaseline)
        fail(`${device.anrCount - anrBaseline} ANR dialog(s) during feature checks`);
    });
    exitCode = 0;
  }
} catch (error) {
  process.stdout.write(`Android flow stopped: ${error.message}\n`);
} finally {
  for (const cleanup of cleanups.toReversed()) {
    try {
      await cleanup();
    } catch (error) {
      process.stdout.write(`cleanup warning: ${error.message}\n`);
    }
  }
  process.stdout.write(`Android checks passed: ${passed}. Evidence: ${root}\n`);
  process.exitCode = exitCode;
}
if (!existsSync(root)) process.exitCode = 1;
