import assert from "node:assert/strict";
import { test } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron, type ElectronApplication, type Page } from "playwright";
import { z } from "zod";
import {
  DesktopVisualEventSchema,
  type VisualReceipt,
  type VisualRenderDocument,
} from "@getpaseo/protocol/pi-workspace/rpc-schemas";

// Exercises the compiled guest preload through its real consumers: the compiled main-process
// visual host (`PiWorkspaceVisuals`) in a real Electron main process and the compiled app-window
// preload (`window.paseoDesktop.visuals`) in a real sandboxed app window. The test drives the app
// side as the renderer does (mount, commands, restorations, acknowledgements) and edits the
// document inside its isolated guest.
const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const dist = join(repository, "packages/desktop/dist");
const id = "25afcecf-bc68-4c7f-b408-2640ed2a0026";
const nonce = "7c6c0224-4617-4c5b-bbfe-03c3c330c608";
const generation = "b5bed943-2cd8-48bd-ab77-8808b6284674";
const actId = "d3f9f1d6-55a4-4c55-9f0b-0f4f8e2b6a01";
const readId = "e8a1c3b2-7d64-4f1e-8a2b-3c4d5e6f7a80";
const binding = { id, revision: 1, nonce, clientGeneration: generation };
const html = `<!doctype html><html><head><meta charset="utf-8"><title>Guest synchronization</title></head>
<body style="margin:0;background:white"><p id="text"></p><p id="count">0</p>
<script>
(() => {
  const bridge = window.paseoVisual;
  let text = "";
  let count = 0;
  const restored = [];
  const render = () => {
    document.getElementById("text").textContent = text;
    document.getElementById("count").textContent = String(count);
  };
  bridge.register({
    read: () => ({ state: { text, count }, selection: null }),
    restore: (snapshot) => {
      text = snapshot.state.text;
      count = snapshot.state.count;
      restored.push(text);
      render();
    },
    actions: {
      increment: {
        description: "Add one",
        parameters: { type: "object" },
        run: () => {
          count += 1;
          render();
        },
      },
    },
  });
  window.edit = (value) => {
    text = value;
    render();
    bridge.publish();
  };
  window.observe = () => ({ text, count, restored: restored.slice() });
})();
</script></body></html>`;
const current: VisualRenderDocument = {
  binding,
  document: {
    id,
    title: "Guest synchronization",
    revision: 1,
    stateRevision: 1,
    html,
    snapshot: { state: null, selection: null },
  },
};
const HarnessSchema = z.object({ origin: z.string() });
const ObservedSchema = z.object({
  text: z.string(),
  count: z.number(),
  restored: z.array(z.string()),
});
const CountedSchema = z.object({ text: z.string(), count: z.number() });

function mainScript(runtime: string): string {
  return `
    const { app, BrowserWindow, WebContentsView, ipcMain, session } = require('electron');
    const http = require('node:http');
    const { PiWorkspaceVisuals } = require(${JSON.stringify(join(dist, "features/pi-workspace-visuals.js"))});
    app.setPath('userData', ${JSON.stringify(join(runtime, "user-data"))});
    if (process.platform === 'darwin') { app.setActivationPolicy('accessory'); app.dock.hide(); }
    globalThis.harnessFailures = [];
    globalThis.harnessReady = app.whenReady().then(async () => {
      const server = http.createServer((request, response) => {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        response.end('<!doctype html><title>Visual host</title>');
      });
      await new Promise((done) => server.listen(0, '127.0.0.1', done));
      const origin = 'http://127.0.0.1:' + server.address().port;
      const visuals = new PiWorkspaceVisuals({
        ipc: ipcMain,
        createSession: (partition) => session.fromPartition(partition),
        createView: (webPreferences) => new WebContentsView({ webPreferences }),
        preloadPath: ${JSON.stringify(join(dist, "features/pi-workspace-visual-preload.js"))},
        appOrigin: origin,
        reportFailure: (error) => globalThis.harnessFailures.push(error instanceof Error ? error.message : String(error)),
      });
      const win = new BrowserWindow({ width: 900, height: 700, show: false, webPreferences: {
        preload: ${JSON.stringify(join(dist, "preload.js"))}, sandbox: true, contextIsolation: true, nodeIntegration: false } });
      visuals.attachWindow(win);
      await win.loadURL(origin + '/host');
      win.showInactive();
      return { origin };
    });
  `;
}

async function page(app: ElectronApplication, url: string): Promise<Page> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const found = app.windows().find((candidate) => candidate.url() === url);
    if (found) return found;
    if (Date.now() > deadline) throw new Error(`Page ${url} did not appear`);
    await new Promise((done) => setTimeout(done, 100));
  }
}

/** Calls one `paseoDesktop.visuals` method in the app window; resolves to its error, if any. */
async function bridge(host: Page, method: string, input: unknown): Promise<string | null> {
  return host.evaluate(
    async (call) => {
      const desktop: unknown = Reflect.get(window, "paseoDesktop");
      if (typeof desktop !== "object" || desktop === null) throw new Error("paseoDesktop missing");
      const visuals: unknown = Reflect.get(desktop, "visuals");
      if (typeof visuals !== "object" || visuals === null) throw new Error("visuals missing");
      const operation: unknown = Reflect.get(visuals, call.method);
      if (typeof operation !== "function") throw new Error(`${call.method} missing`);
      try {
        await Reflect.apply(operation, visuals, [call.input]);
        return null;
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    },
    { method, input },
  );
}

async function receipts(host: Page): Promise<VisualReceipt[]> {
  const raw: unknown = await host.evaluate(() => Reflect.get(window, "received"));
  return z
    .array(z.unknown())
    .parse(raw)
    .map((message) => {
      const event = DesktopVisualEventSchema.parse(message);
      if (event.type !== "paseo-visual") throw new Error("Unexpected host signal");
      return event.receipt;
    });
}

async function receiptCount(host: Page, count: number): Promise<VisualReceipt[]> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const received = await receipts(host);
    if (received.length >= count) {
      assert.equal(received.length, count, "More receipts than expected");
      return received;
    }
    if (Date.now() > deadline) throw new Error(`Only ${received.length} of ${count} receipts`);
    await new Promise((done) => setTimeout(done, 50));
  }
}

function summary(receipt: VisualReceipt): {
  sequence: number;
  commandId: string | null;
  base: number | undefined;
  text: string | null;
  count: number | null;
} {
  const state = receipt.error ? null : CountedSchema.parse(receipt.snapshot.state);
  return {
    sequence: receipt.sequence,
    commandId: receipt.commandId,
    base: receipt.stateRevision,
    text: state ? state.text : null,
    count: state ? state.count : null,
  };
}

async function edit(guest: Page, text: string): Promise<void> {
  await guest.evaluate((value) => {
    const operation: unknown = Reflect.get(window, "edit");
    if (typeof operation !== "function") throw new Error("Guest edit missing");
    Reflect.apply(operation, window, [value]);
  }, text);
}

async function observe(guest: Page): Promise<z.infer<typeof ObservedSchema>> {
  const raw: unknown = await guest.evaluate(() => {
    const operation: unknown = Reflect.get(window, "observe");
    if (typeof operation !== "function") throw new Error("Guest observation missing");
    const result: unknown = Reflect.apply(operation, window, []);
    return result;
  });
  return ObservedSchema.parse(raw);
}

function stored(stateRevision: number, text: string, count: number) {
  return { binding, snapshot: { state: { text, count }, selection: null }, stateRevision };
}

test("the desktop guest publishes on acknowledged bases, orders agent commands after the awaited answer and never restores its own returned state", async () => {
  const runtime = await mkdtemp(join(tmpdir(), "paseo-visual-sync-"));
  const entry = join(runtime, "main.cjs");
  await writeFile(entry, mainScript(runtime));
  const runtimePath = process.env.PATH;
  if (!runtimePath) throw new Error("Electron guest test requires PATH");
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
    const harness = HarnessSchema.parse(
      await app.evaluate(async () => {
        const ready: unknown = Reflect.get(globalThis, "harnessReady");
        if (!(ready instanceof Promise)) throw new Error("Harness did not start");
        const value: unknown = await ready;
        return value;
      }),
    );
    const host = await page(app, `${harness.origin}/host`);
    await host.evaluate(async () => {
      const received: unknown[] = [];
      Reflect.set(window, "received", received);
      const desktop: unknown = Reflect.get(window, "paseoDesktop");
      if (typeof desktop !== "object" || desktop === null) throw new Error("paseoDesktop missing");
      const events: unknown = Reflect.get(desktop, "events");
      if (typeof events !== "object" || events === null) throw new Error("events missing");
      const on: unknown = Reflect.get(events, "on");
      if (typeof on !== "function") throw new Error("events.on missing");
      await Reflect.apply(on, events, ["visual", (message: unknown) => received.push(message)]);
    });
    assert.equal(
      await bridge(host, "mount", {
        current,
        commandId: null,
        bounds: { x: 0, y: 0, width: 600, height: 400 },
      }),
      null,
    );
    const guest = await page(app, `paseo-visual://${nonce}/document`);
    // The first publication awaits its answer.
    await receiptCount(host, 1);
    await edit(guest, "a");
    assert.equal(
      await bridge(host, "command", {
        nonce,
        command: { kind: "act", commandId: actId, binding, action: "increment", value: {} },
      }),
      null,
    );
    await edit(guest, "ab");

    // The host relays only answers to receipts the guest has sent, for its own document.
    assert.match(
      (await bridge(host, "acknowledge", { binding, sequence: 9, stateRevision: 1 })) ?? "",
      /unsent visual receipt/,
    );
    assert.notEqual(
      await bridge(host, "acknowledge", { binding, sequence: 1, stateRevision: 0 }),
      null,
    );
    assert.match(
      (await bridge(host, "acknowledge", {
        binding: { ...binding, nonce: generation },
        sequence: 1,
        stateRevision: 1,
      })) ?? "",
      /no longer mounted/,
    );
    assert.equal((await receipts(host)).length, 1);
    assert.equal((await observe(guest)).count, 0, "The action waits for the awaited answer");

    // The answer releases the action: it runs once, on the acknowledged base, with every edit.
    assert.equal(
      await bridge(host, "acknowledge", { binding, sequence: 1, stateRevision: 1 }),
      null,
    );
    await receiptCount(host, 2);
    await edit(guest, "abc");
    // The action's own stored result comes back: it only advances the base.
    assert.equal(await bridge(host, "restore", stored(2, "ab", 1)), null);
    assert.equal(
      await bridge(host, "acknowledge", { binding, sequence: 2, stateRevision: 2 }),
      null,
    );
    let received = await receiptCount(host, 3);
    assert.deepEqual(received.map(summary), [
      { sequence: 1, commandId: null, base: 1, text: "", count: 0 },
      { sequence: 2, commandId: actId, base: 1, text: "ab", count: 1 },
      { sequence: 3, commandId: null, base: 2, text: "abc", count: 1 },
    ]);
    assert.deepEqual(await observe(guest), { text: "abc", count: 1, restored: [] });

    // An answer advances the base without a restoration; a capture on that base is valid.
    assert.equal(
      await bridge(host, "acknowledge", { binding, sequence: 3, stateRevision: 3 }),
      null,
    );
    assert.equal(
      await bridge(host, "command", {
        nonce,
        command: {
          kind: "inspect",
          commandId: readId,
          binding,
          screenshot: true,
          stateRevision: 3,
        },
      }),
      null,
    );
    received = await receiptCount(host, 4);
    const inspection = received[3];
    assert.equal(inspection?.error, null, JSON.stringify(inspection?.error));
    assert.equal(inspection?.stateRevision, 3);
    assert.equal(inspection?.capture?.screenshot.stateRevision, 3);

    // Another writer's newer state is adopted; the late answer for the read does not move the
    // base, and the next edit is published on the adopted state.
    assert.equal(await bridge(host, "restore", stored(5, "theirs", 1)), null);
    assert.equal(
      await bridge(host, "acknowledge", { binding, sequence: 4, stateRevision: 5 }),
      null,
    );
    await edit(guest, "theirs!");
    received = await receiptCount(host, 5);
    const published = received[4];
    if (!published) throw new Error("The adopted state's next edit was not published");
    assert.deepEqual(summary(published), {
      sequence: 5,
      commandId: null,
      base: 5,
      text: "theirs!",
      count: 1,
    });
    assert.deepEqual(await observe(guest), { text: "theirs!", count: 1, restored: ["theirs"] });
    assert.deepEqual(await app.evaluate(() => Reflect.get(globalThis, "harnessFailures")), []);
  } finally {
    await app.close();
    await rm(runtime, { recursive: true, force: true });
  }
}, 90000);
