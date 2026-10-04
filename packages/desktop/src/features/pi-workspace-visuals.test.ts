import assert from "node:assert/strict";
import { test } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron } from "playwright";
import sharp from "sharp";
import { z } from "zod";
import {
  installVisualContentsPolicy,
  installVisualSessionPolicy,
  isVisualHostUrl,
  sameVisualBinding,
  VisualDeadlines,
  captureDisplayedFrame,
  visualPngSize,
  type VisualFrameSource,
  type VisualContentsPolicy,
  type VisualSessionPolicy,
  type VisualTimer,
} from "./pi-workspace-visuals.js";

test("visual policy denies permissions, devices, display media, downloads, navigation and new windows only on the supplied ports", async () => {
  const installed: string[] = [];
  const documentUrl = "paseo-visual://document-nonce/document";
  const session: VisualSessionPolicy = {
    async setProxy(config) {
      assert.deepEqual(config, {
        mode: "fixed_servers",
        proxyRules: "http://127.0.0.1:9",
        proxyBypassRules: "<-loopback>",
      });
      installed.push("proxy");
    },
    setPermissionCheckHandler(handler) {
      assert.equal(handler(), false);
      installed.push("permission-check");
    },
    setPermissionRequestHandler(handler) {
      handler(null, "notifications", (allowed) => assert.equal(allowed, false));
      installed.push("permission-request");
    },
    setDevicePermissionHandler(handler) {
      assert.equal(handler(), false);
      installed.push("device-permission");
    },
    setDisplayMediaRequestHandler(handler) {
      handler(null, (streams) => assert.deepEqual(streams, {}));
      installed.push("display-media");
    },
    on(event, handler) {
      assert.equal(event, "will-download");
      let prevented = false;
      handler({
        preventDefault() {
          prevented = true;
        },
      });
      assert.equal(prevented, true);
      installed.push("download");
    },
    webRequest: {
      onBeforeRequest(filter, handler) {
        assert.deepEqual(filter, { urls: ["<all_urls>"] });
        for (const url of [
          "http://127.0.0.1:9876/",
          "https://example.invalid/",
          "ws://example.invalid/",
          "wss://example.invalid/",
          "file:///etc/hosts",
          "paseo://app/",
          "paseo-visual://other/document",
        ]) {
          handler({ url, method: "GET", resourceType: "mainFrame" }, (result) =>
            assert.deepEqual(result, { cancel: true }),
          );
        }
        handler({ url: documentUrl, method: "GET", resourceType: "mainFrame" }, (result) =>
          assert.deepEqual(result, { cancel: false }),
        );
        handler({ url: documentUrl, method: "POST", resourceType: "mainFrame" }, (result) =>
          assert.deepEqual(result, { cancel: true }),
        );
        handler({ url: documentUrl, method: "GET", resourceType: "subFrame" }, (result) =>
          assert.deepEqual(result, { cancel: true }),
        );
        handler(
          { url: "data:image/png;base64,AAAA", method: "GET", resourceType: "image" },
          (result) => assert.deepEqual(result, { cancel: false }),
        );
        installed.push("requests");
      },
    },
  };
  await installVisualSessionPolicy(session, documentUrl);
  assert.deepEqual(installed, [
    "permission-check",
    "permission-request",
    "device-permission",
    "display-media",
    "download",
    "requests",
    "proxy",
  ]);
  const events: string[] = [];
  const contents: VisualContentsPolicy = {
    setWebRTCIPHandlingPolicy(policy) {
      assert.equal(policy, "disable_non_proxied_udp");
      events.push("webrtc");
    },
    setWindowOpenHandler(handler) {
      assert.deepEqual(handler(), { action: "deny" });
      events.push("windows");
    },
    on(event, handler) {
      let prevented = false;
      handler({
        preventDefault() {
          prevented = true;
        },
      });
      assert.equal(prevented, true);
      events.push(event);
    },
  };
  installVisualContentsPolicy(contents);
  assert.deepEqual(events, [
    "webrtc",
    "windows",
    "will-navigate",
    "will-frame-navigate",
    "will-redirect",
    "will-prevent-unload",
  ]);
});

test("host deadlines expire once, reject duplicate operations, and ignore callbacks after settlement or disposal", () => {
  const timers: Array<{ expire(): void; cancelled: boolean }> = [];
  const schedule: VisualTimer = (expire, milliseconds) => {
    assert.equal(milliseconds, 6000);
    const timer = { expire, cancelled: false };
    timers.push(timer);
    return () => {
      timer.cancelled = true;
    };
  };
  const deadlines = new VisualDeadlines(schedule);
  const expired: string[] = [];
  deadlines.arm("first", () => expired.push("first"));
  assert.throws(() => deadlines.arm("first", () => expired.push("duplicate")), /already pending/);
  const first = timers[0];
  if (!first) throw new Error("No host deadline was installed");
  first.expire();
  first.expire();
  assert.deepEqual(expired, ["first"]);
  deadlines.arm("second", () => expired.push("second"));
  deadlines.settle("second");
  const second = timers[1];
  if (!second) throw new Error("No second deadline was installed");
  assert.equal(second.cancelled, true);
  second.expire();
  deadlines.arm("third", () => expired.push("third"));
  deadlines.close();
  const third = timers[2];
  if (!third) throw new Error("No third deadline was installed");
  assert.equal(third.cancelled, true);
  third.expire();
  assert.deepEqual(expired, ["first"]);
});

test("desktop authority distinguishes every document binding field and the actual app origin", () => {
  const binding = {
    id: "artifact",
    revision: 1,
    nonce: "document",
    clientGeneration: "connection",
  };
  assert.equal(sameVisualBinding(binding, { ...binding }), true);
  for (const changed of [
    { ...binding, id: "other" },
    { ...binding, revision: 2 },
    { ...binding, nonce: "replaced" },
    { ...binding, clientGeneration: "reconnected" },
  ])
    assert.equal(sameVisualBinding(binding, changed), false);
  assert.equal(isVisualHostUrl("paseo://app/h/server/agent/id", "http://localhost:8082"), true);
  assert.equal(
    isVisualHostUrl("http://localhost:8082/h/server/agent/id", "http://localhost:8082"),
    true,
  );
  for (const url of [
    "paseo-visual://document/",
    "http://localhost:8083/",
    "https://example.invalid/",
    "file:///tmp/page.html",
    "about:blank",
    "not a URL",
  ])
    assert.equal(isVisualHostUrl(url, "http://localhost:8082"), false);
});

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lZsAAAAASUVORK5CYII=",
  "base64",
);
class FrameSource implements VisualFrameSource {
  reply: ((response: unknown) => void) | null = null;
  throttled = true;
  destroyed = false;
  attached = false;
  starts = 0;
  ends = 0;
  readonly throttleChanges: boolean[] = [];
  readonly debugger: VisualFrameSource["debugger"] = {
    isAttached: () => this.attached,
    attach: () => {
      this.starts += 1;
      this.attached = true;
    },
    detach: () => {
      this.ends += 1;
      this.attached = false;
    },
    sendCommand: (method, parameters) => {
      assert.equal(method, "Page.captureScreenshot");
      assert.deepEqual(parameters, {
        format: "png",
        fromSurface: true,
        captureBeyondViewport: false,
      });
      return new Promise((accept) => {
        this.reply = accept;
      });
    },
  };
  getBackgroundThrottling(): boolean {
    return this.throttled;
  }
  setBackgroundThrottling(value: boolean): void {
    this.throttled = value;
    this.throttleChanges.push(value);
  }
  isDestroyed(): boolean {
    return this.destroyed;
  }
  deliver(response: unknown): void {
    if (!this.reply) throw new Error("Capture did not request the displayed viewport");
    this.reply(response);
  }
}

test("capture forwards a new viewport PNG from its display and releases its debugger, deadline and temporary throttling", async () => {
  const source = new FrameSource();
  let cancelled = 0;
  const pending = captureDisplayedFrame({
    source,
    valid: () => true,
    signal: new AbortController().signal,
    schedule: (_expire, milliseconds) => {
      assert.equal(milliseconds, 5000);
      return () => {
        cancelled += 1;
      };
    },
  });
  assert.equal(source.starts, 1);
  assert.equal(source.throttled, false);
  source.deliver({ data: png.toString("base64") });
  assert.deepEqual(await pending, png);
  assert.equal(source.ends, 1);
  assert.equal(cancelled, 1);
  assert.deepEqual(source.throttleChanges, [false, true]);
  assert.deepEqual(visualPngSize(png), { width: 1, height: 1 });
});

test("capture revalidates after asynchronous delivery and after PNG decoding", async () => {
  for (const failAt of [2, 3]) {
    const source = new FrameSource();
    let validations = 0;
    const pending = captureDisplayedFrame({
      source,
      valid: () => ++validations < failAt,
      signal: new AbortController().signal,
    });
    const failed = assert.rejects(pending, /Capture binding changed/);
    source.deliver({ data: png.toString("base64") });
    await failed;
    assert.equal(validations, failAt);
    assert.equal(source.ends, 1);
    assert.equal(source.throttled, true);
  }
});

test("capture timeout and cancellation release resources and ignore late replies", async () => {
  for (const reason of ["deadline", "unmount"] as const) {
    const source = new FrameSource();
    const abort = new AbortController();
    const expirations: Array<() => void> = [];
    let cancelled = 0;
    const pending = captureDisplayedFrame({
      source,
      valid: () => true,
      signal: abort.signal,
      schedule: (expire) => {
        expirations.push(expire);
        return () => {
          cancelled += 1;
        };
      },
    });
    const failed = assert.rejects(
      pending,
      reason === "deadline" ? /capture deadline/ : /target changed/,
    );
    const expire = expirations[0];
    if (!expire) throw new Error("Capture did not install its deadline");
    if (reason === "deadline") expire();
    else abort.abort();
    await failed;
    source.deliver({ data: png.toString("base64") });
    await Promise.resolve();
    assert.equal(source.ends, 1);
    assert.equal(cancelled, 1);
    assert.equal(source.throttled, true);
  }
});

test("unavailable or already-owned views and malformed or oversized PNG replies fail explicitly", async () => {
  const unavailable = new FrameSource();
  await assert.rejects(
    captureDisplayedFrame({
      source: unavailable,
      valid: () => false,
      signal: new AbortController().signal,
    }),
    /not displayed/,
  );
  assert.equal(unavailable.starts, 0);
  const occupied = new FrameSource();
  occupied.attached = true;
  await assert.rejects(
    captureDisplayedFrame({
      source: occupied,
      valid: () => true,
      signal: new AbortController().signal,
    }),
    /already owned/,
  );
  assert.equal(occupied.ends, 0);
  const oversized = Buffer.from(png);
  oversized.writeUInt32BE(5000, 16);
  for (const response of [
    { data: 17 },
    { data: "A".repeat(3 * 1024 * 1024) },
    { data: oversized.toString("base64") },
  ]) {
    const source = new FrameSource();
    const pending = captureDisplayedFrame({
      source,
      valid: () => true,
      signal: new AbortController().signal,
    });
    const failed = assert.rejects(pending, /bounded PNG|dimensions exceed/);
    source.deliver(response);
    await failed;
    assert.equal(source.ends, 1);
    assert.equal(source.throttled, true);
  }
  assert.throws(() => visualPngSize(Buffer.alloc(32)), /bounded PNG/);
});

async function sampleCanvas(bytes: Buffer): Promise<number[]> {
  const { data, info } = await sharp(bytes)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const scale = info.width / 880;
  const offset = (Math.floor(32 * scale) * info.width + Math.floor(64 * scale)) * 4;
  return Array.from(data.subarray(offset, offset + 3));
}

function paintedColor(height: number, covered: boolean): number[] {
  if (covered) return [0, 0, 255];
  if (height === 360) return [255, 0, 255];
  return [0, 255, 0];
}

test("real Electron guest capture contains current canvas pixels across view resize and occlusion", async () => {
  const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
  const evidence = await mkdtemp(join(tmpdir(), "paseo-visual-capture-evidence-"));
  const runtime = join(evidence, "runtime");
  await mkdir(runtime);
  const entry = join(runtime, "main.cjs");
  const guestUrl =
    "data:text/html," +
    encodeURIComponent(
      '<!doctype html><title>Capture port regression</title><body style="margin:0;background:white"><canvas width="256" height="128"></canvas></body>',
    );
  await writeFile(
    entry,
    `
    const { app, BrowserWindow, WebContentsView } = require('electron');
    const { captureDisplayedFrame } = require(${JSON.stringify(join(repository, "packages/desktop/dist/features/pi-workspace-visuals.js"))});
    app.setPath('userData', ${JSON.stringify(join(runtime, "user-data"))});
    if (process.platform === 'darwin') { app.setActivationPolicy('accessory'); app.dock.hide(); }
    globalThis.visualCaptureReady = app.whenReady().then(async () => {
      const win = new BrowserWindow({ width:1200, height:800, show:false, webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false} });
      await win.loadURL('data:text/html,<title>Capture host</title>');
      const view = new WebContentsView({ webPreferences:{partition:'capture-port-regression',sandbox:true,contextIsolation:true,nodeIntegration:false} });
      win.contentView.addChildView(view);
      view.setBounds({x:320,y:72,width:880,height:360});
      await view.webContents.loadURL(${JSON.stringify(guestUrl)});
      win.showInactive();
      globalThis.visualCaptureProbe = async (height, covered) => {
        // A second window above the host occludes it, like a newer desktop window.
        let cover = null;
        if (covered) {
          cover = new BrowserWindow({ ...win.getBounds(), show:false });
          await cover.loadURL('data:text/html,<body style="background:black"></body>');
          cover.showInactive();
          await new Promise((done) => setTimeout(done, 300));
        }
        try {
        view.setBounds({x:320,y:72,width:880,height});
        const color = covered ? '#0000ff' : height === 360 ? '#ff00ff' : '#00ff00';
        await view.webContents.mainFrame.executeJavaScript("(() => {const c=document.querySelector('canvas').getContext('2d'); c.fillStyle="+JSON.stringify(color)+";c.fillRect(0,0,256,128)})()");
        const png = await captureDisplayedFrame({source:view.webContents,valid:()=>!view.webContents.isDestroyed() && win.isVisible(),signal:new AbortController().signal});
        return {data:png.toString('base64'),bounds:view.getBounds(),visible:view.getVisible()};
        } finally {
          if (cover) cover.destroy();
        }
      };
    });
  `,
  );
  const runtimePath = process.env.PATH;
  if (!runtimePath) throw new Error("Electron capture test requires PATH");
  const app = await _electron.launch({
    executablePath: join(
      repository,
      "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron",
    ),
    args: [entry],
    cwd: repository,
    env: { PATH: runtimePath, HOME: runtime },
    timeout: 60000,
  });
  try {
    assert.equal(await app.evaluate(() => process.versions.electron), "44.2.0");
    await app.evaluate(async () => {
      const ready: unknown = Reflect.get(globalThis, "visualCaptureReady");
      if (!(ready instanceof Promise)) throw new Error("Capture fixture did not start");
      await ready;
    });
    const guest = app.windows().find((page) => page.url() === guestUrl);
    if (!guest) throw new Error("Real guest page is missing");
    for (const [height, covered] of [
      [360, false],
      [340, false],
      [340, true],
    ] as const) {
      const raw: unknown = await app.evaluate(
        async (_electronModule, input) => {
          const capture: unknown = Reflect.get(globalThis, "visualCaptureProbe");
          if (typeof capture !== "function") throw new Error("Capture fixture not ready");
          const result: unknown = await Reflect.apply(capture, undefined, [
            input.height,
            input.covered,
          ]);
          return result;
        },
        { height, covered },
      );
      const captured = z
        .object({
          data: z.string(),
          visible: z.boolean(),
          bounds: z.object({ width: z.number(), height: z.number() }),
        })
        .parse(raw);
      assert.equal(captured.visible, true);
      assert.deepEqual(captured.bounds, { width: 880, height });
      const bytes = Buffer.from(captured.data, "base64");
      const label = `${height}${covered ? "-covered" : ""}`;
      await writeFile(join(evidence, `capture-${label}.png`), bytes);
      const observed = await guest.screenshot({ path: join(evidence, `guest-${label}.png`) });
      const expected = paintedColor(height, covered);
      const guestPixel = await sampleCanvas(observed);
      const capturePixel = await sampleCanvas(bytes);
      // Display color management may round a channel by a few units; the oracle decodes
      // with thresholds, so compare against the painted color with the same small margin.
      const near = (pixel: number[]) =>
        pixel.length === 3 &&
        pixel.every((channel, index) => Math.abs(channel - (expected[index] ?? -1)) <= 8);
      assert.equal(
        near(guestPixel),
        true,
        `Guest fixture did not paint: ${JSON.stringify({ evidence, label, guestPixel })}`,
      );
      assert.equal(
        near(capturePixel),
        true,
        JSON.stringify({ evidence, label, capturePixel, guestPixel }),
      );
    }
  } finally {
    await app.close();
    await rm(runtime, { recursive: true, force: true });
  }
}, 90000);
