import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import {
  VisualFailure,
  type VisualCapture,
  type VisualPlatform,
} from "@getpaseo/protocol/pi-workspace/contracts";
import type {
  VisualCommand,
  VisualEvent,
  VisualReceipt,
} from "@getpaseo/protocol/pi-workspace/rpc-schemas";
import { VisualService } from "./service.js";
import { VisualStorage } from "./storage.js";

const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lZsAAAAASUVORK5CYII=";

class DisplayPort {
  constructor(readonly source: object = {}) {}
  readonly events: VisualEvent[] = [];
  private readonly commands: VisualCommand[] = [];
  private waiting: ((command: VisualCommand) => void) | null = null;

  emit = (event: VisualEvent): void => {
    this.events.push(event);
    if (event.kind !== "command") return;
    const waiting = this.waiting;
    if (waiting) {
      this.waiting = null;
      waiting(event.command);
    } else {
      this.commands.push(event.command);
    }
  };

  next(): Promise<VisualCommand> {
    const command = this.commands.shift();
    if (command) return Promise.resolve(command);
    if (this.waiting) throw new Error("Display already awaits a command");
    return new Promise((resolve) => {
      this.waiting = resolve;
    });
  }
}

interface Fixture {
  service: VisualService;
  storage: VisualStorage;
  owner: { agentId: string; sessionId: string };
  signal: AbortSignal;
  cleanup(): Promise<void>;
}

async function fixture(name: string): Promise<Fixture> {
  const directory = await mkdtemp(join(tmpdir(), `paseo-visual-android-${name}-`));
  const storage = new VisualStorage(directory);
  const service = new VisualService(storage);
  return {
    service,
    storage,
    owner: { agentId: `${name}-agent`, sessionId: `${name}-session` },
    signal: new AbortController().signal,
    cleanup: async () => {
      service.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

function code(expected: string): (error: unknown) => boolean {
  return (error: unknown) => error instanceof VisualFailure && error.code === expected;
}

async function observe(f: Fixture, display: DisplayPort, platform: VisualPlatform) {
  return f.service.observe({
    agentId: f.owner.agentId,
    source: display.source,
    platform,
    emit: display.emit,
  });
}

async function present(f: Fixture, display: DisplayPort, title: string) {
  const presenting = f.service.execute(
    f.owner,
    { kind: "present", title, html: "<p>Android</p>" },
    f.signal,
  );
  const render = await display.next();
  if (render.kind !== "render") throw new Error("Expected render");
  const receipt: VisualReceipt = {
    binding: render.current.binding,
    commandId: render.commandId,
    sequence: 1,
    stateRevision: render.current.document.stateRevision,
    snapshot: { state: { value: 1 }, selection: null },
    actions: {},
    error: null,
  };
  await f.service.receive({ agentId: f.owner.agentId, source: display.source, receipt });
  const shown = await presenting;
  if (shown.kind !== "visual") throw new Error("Expected visual");
  return { shown, receipt };
}

test("an Android display returns its bound capture and its trusted host activity selects it", async () => {
  const f = await fixture("capture");
  const phone = new DisplayPort();
  const desktop = new DisplayPort();
  try {
    const android = await observe(f, phone, "android");
    const { shown, receipt } = await present(f, phone, "Android capture");
    const electron = await observe(f, desktop, "electron");
    const restored = electron.view.current;
    if (!restored) throw new Error("Expected late join");
    await f.service.receive({
      agentId: f.owner.agentId,
      source: desktop.source,
      receipt: {
        ...receipt,
        binding: restored.binding,
        commandId: null,
        stateRevision: restored.document.stateRevision,
      },
    });
    await f.service.receive({
      agentId: f.owner.agentId,
      source: phone.source,
      receipt: { kind: "activity", binding: receipt.binding },
    });
    const inspecting = f.service.execute(
      f.owner,
      { kind: "inspect", id: shown.id, screenshot: true },
      f.signal,
    );
    const command = await phone.next();
    if (command.kind !== "inspect" || command.stateRevision === undefined)
      throw new Error("Active Android display did not receive the capture request");
    const capture: VisualCapture = {
      operationId: command.commandId,
      binding: command.binding,
      screenshot: {
        client: android.view.generation,
        mimeType: "image/png",
        width: 1,
        height: 1,
        viewport: { width: 1, height: 1 },
        pixelRatio: 2.625,
        revision: command.binding.revision,
        stateRevision: command.stateRevision,
      },
      data: PNG,
    };
    await f.service.receive({
      agentId: f.owner.agentId,
      source: phone.source,
      receipt: {
        ...receipt,
        commandId: command.commandId,
        sequence: 2,
        stateRevision: command.stateRevision,
        capture,
      },
    });
    const result = await inspecting;
    if (result.kind !== "visual") throw new Error("Expected capture result");
    assert.deepEqual(result.capture, capture);
    assert.equal(result.client, android.view.generation);
    assert.deepEqual(result.displays, [
      { client: android.view.generation, platform: "android", active: true },
      { client: electron.view.generation, platform: "electron", active: false },
    ]);
    const forged = f.service.execute(
      f.owner,
      { kind: "inspect", id: shown.id, screenshot: true, client: android.view.generation },
      f.signal,
    );
    const forgedRejected = assert.rejects(forged, code("INVALID_CAPTURE"));
    const forgedCommand = await phone.next();
    await assert.rejects(
      f.service.receive({
        agentId: f.owner.agentId,
        source: phone.source,
        receipt: {
          ...receipt,
          commandId: forgedCommand.commandId,
          sequence: 3,
          stateRevision: command.stateRevision,
          capture: {
            ...capture,
            operationId: forgedCommand.commandId,
            screenshot: { ...capture.screenshot, client: electron.view.generation },
          },
        },
      }),
      code("INVALID_CAPTURE"),
    );
    await forgedRejected;
  } finally {
    await f.cleanup();
  }
});

test("a missing Android visual host fails presentation with RENDERER_UNAVAILABLE and recovers after reopen", async () => {
  const f = await fixture("renderer");
  const phone = new DisplayPort();
  try {
    await observe(f, phone, "android");
    const { shown, receipt } = await present(f, phone, "Shown first");
    const refused = f.service.execute(
      f.owner,
      { kind: "present", title: "No host", html: "<p>Unhosted</p>" },
      f.signal,
    );
    const failing = await phone.next();
    if (failing.kind !== "render") throw new Error("Expected render of the new visual");
    await f.service.receive({
      agentId: f.owner.agentId,
      source: phone.source,
      receipt: {
        binding: failing.current.binding,
        commandId: failing.commandId,
        sequence: 1,
        snapshot: failing.current.document.snapshot,
        actions: {},
        error: { code: "RENDERER_UNAVAILABLE", message: "Visual host is not installed" },
      },
    });
    await assert.rejects(
      refused,
      (error: unknown) =>
        error instanceof VisualFailure &&
        error.code === "RENDERER_UNAVAILABLE" &&
        error.artifactId === failing.current.document.id,
    );
    const restoredEvent = phone.events.at(-1);
    if (!restoredEvent || restoredEvent.kind !== "snapshot" || !restoredEvent.view.current)
      throw new Error("The display was not restored to the previous visual");
    const remount = restoredEvent.view.current;
    assert.equal(remount.document.id, shown.id);
    await f.service.receive({
      agentId: f.owner.agentId,
      source: phone.source,
      receipt: {
        binding: remount.binding,
        commandId: null,
        sequence: 1,
        snapshot: remount.document.snapshot,
        actions: {},
        error: { code: "RENDERER_UNAVAILABLE", message: "Visual host is not installed" },
      },
    });
    for (const screenshot of [false, true])
      await assert.rejects(
        f.service.execute(f.owner, { kind: "inspect", id: shown.id, screenshot }, f.signal),
        code("RENDERER_UNAVAILABLE"),
      );
    await assert.rejects(
      f.service.execute(f.owner, { kind: "act", id: shown.id, action: "x", value: null }, f.signal),
      code("RENDERER_UNAVAILABLE"),
    );
    const listed = await f.service.execute(f.owner, { kind: "list", cursor: null }, f.signal);
    if (listed.kind !== "list") throw new Error("Expected list");
    assert.ok(listed.items.some((item) => item.id === failing.current.document.id));
    const opening = f.service.execute(f.owner, { kind: "open", id: shown.id }, f.signal);
    const reopen = await phone.next();
    if (reopen.kind !== "render") throw new Error("Expected reopen render");
    assert.notEqual(reopen.current.binding.nonce, remount.binding.nonce);
    await f.service.receive({
      agentId: f.owner.agentId,
      source: phone.source,
      receipt: { ...receipt, binding: reopen.current.binding, commandId: reopen.commandId },
    });
    const reopened = await opening;
    if (reopened.kind !== "visual") throw new Error("Expected reopened visual");
    assert.equal(reopened.status, "rendered");
    assert.equal(reopened.error, null);
  } finally {
    await f.cleanup();
  }
});

test("a released Android display is unavailable when addressed and remounts with a fresh identity", async () => {
  const f = await fixture("lifecycle");
  const phone = new DisplayPort();
  try {
    const first = await observe(f, phone, "android");
    const { shown, receipt } = await present(f, phone, "Lifecycle");
    first.release();
    await assert.rejects(
      f.service.execute(
        f.owner,
        { kind: "inspect", id: shown.id, screenshot: true, client: first.view.generation },
        f.signal,
      ),
      code("DISPLAY_UNAVAILABLE"),
    );
    await assert.rejects(
      f.service.execute(f.owner, { kind: "inspect", id: shown.id, screenshot: false }, f.signal),
      code("CLIENT_UNAVAILABLE"),
    );
    const foreground = new DisplayPort();
    const second = await observe(f, foreground, "android");
    const remounted = second.view.current;
    if (!remounted) throw new Error("Foreground remount did not restore the stored visual");
    assert.notEqual(second.view.generation, first.view.generation);
    assert.notEqual(remounted.binding.nonce, receipt.binding.nonce);
    assert.deepEqual(remounted.document.snapshot, receipt.snapshot);
  } finally {
    await f.cleanup();
  }
});

test("plain web displays still refuse capture and trusted host signals", async () => {
  const f = await fixture("web");
  const browser = new DisplayPort();
  try {
    await observe(f, browser, "web");
    const { shown, receipt } = await present(f, browser, "Browser");
    await assert.rejects(
      f.service.execute(f.owner, { kind: "inspect", id: shown.id, screenshot: true }, f.signal),
      code("CAPTURE_UNSUPPORTED"),
    );
    await assert.rejects(
      f.service.receive({
        agentId: f.owner.agentId,
        source: browser.source,
        receipt: { kind: "activity", binding: receipt.binding },
      }),
      code("UNSUPPORTED_CLIENT"),
    );
  } finally {
    await f.cleanup();
  }
});

async function twoDisplays(f: Fixture) {
  const first = new DisplayPort();
  const second = new DisplayPort();
  await observe(f, first, "electron");
  const { shown, receipt } = await present(f, first, "Concurrent displays");
  const joined = await observe(f, second, "android");
  const mounted = joined.view.current;
  if (!mounted) throw new Error("Expected the second display to join");
  const mount: VisualReceipt = {
    binding: mounted.binding,
    commandId: null,
    sequence: 1,
    stateRevision: mounted.document.stateRevision,
    snapshot: mounted.document.snapshot,
    actions: {},
    error: null,
  };
  await f.service.receive({ agentId: f.owner.agentId, source: second.source, receipt: mount });
  return { first, second, shown, receipt, mount };
}

async function storedDocument(f: Fixture, id: string) {
  return f.storage.get({ owner: f.owner, id });
}

test("concurrent displays: an unchanged receipt keeps the state revision, so the other display's next change is kept", async () => {
  const f = await fixture("unchanged");
  try {
    const { first, second, shown, receipt, mount } = await twoDisplays(f);
    const base = (await storedDocument(f, shown.id)).stateRevision;
    assert.equal(base, shown.stateRevision, "an unchanged mount receipt adds no state revision");
    // An agent read answered by the second display reports the same state.
    const reading = f.service.execute(
      f.owner,
      { kind: "inspect", id: shown.id, screenshot: false },
      f.signal,
    );
    const command = await second.next();
    if (command.kind !== "inspect") throw new Error("Expected the second display to answer");
    await f.service.receive({
      agentId: f.owner.agentId,
      source: second.source,
      receipt: { ...mount, commandId: command.commandId, sequence: 2 },
    });
    const read = await reading;
    if (read.kind !== "visual") throw new Error("Expected an inspection result");
    assert.equal(read.stateRevision, base);
    // A trusted change in the first display, published from the base it knows, is kept.
    await f.service.receive({
      agentId: f.owner.agentId,
      source: first.source,
      receipt: {
        ...receipt,
        commandId: null,
        sequence: 2,
        stateRevision: base,
        snapshot: { state: { value: 2 }, selection: null },
      },
    });
    const stored = await storedDocument(f, shown.id);
    assert.deepEqual(stored.snapshot.state, { value: 2 });
    assert.equal(stored.stateRevision, base + 1);
    const delivered = second.events.at(-1);
    if (!delivered || delivered.kind !== "snapshot" || !delivered.view.current)
      throw new Error("The second display did not receive the kept change");
    assert.deepEqual(delivered.view.current.document.snapshot.state, { value: 2 });
  } finally {
    await f.cleanup();
  }
});

test("concurrent displays: an inspection answered from an older base reports stored state instead of failing", async () => {
  const f = await fixture("stale-read");
  try {
    const { first, second, shown, receipt, mount } = await twoDisplays(f);
    const base = (await storedDocument(f, shown.id)).stateRevision;
    await f.service.receive({
      agentId: f.owner.agentId,
      source: first.source,
      receipt: {
        ...receipt,
        commandId: null,
        sequence: 2,
        stateRevision: base,
        snapshot: { state: { value: 2 }, selection: null },
      },
    });
    // The second display answers before its restoration arrived: old base, old snapshot.
    const reading = f.service.execute(
      f.owner,
      { kind: "inspect", id: shown.id, screenshot: false },
      f.signal,
    );
    const command = await second.next();
    if (command.kind !== "inspect") throw new Error("Expected the second display to answer");
    const before = second.events.length;
    await f.service.receive({
      agentId: f.owner.agentId,
      source: second.source,
      receipt: { ...mount, commandId: command.commandId, sequence: 2 },
    });
    const read = await reading;
    if (read.kind !== "visual") throw new Error("Expected an inspection result");
    assert.deepEqual(read.state, { value: 2 });
    assert.equal(read.stateRevision, base + 1);
    assert.deepEqual((await storedDocument(f, shown.id)).snapshot.state, { value: 2 });
    const restored = second.events.slice(before).at(-1);
    if (!restored || restored.kind !== "snapshot" || !restored.view.current)
      throw new Error("The stale display was not restored to stored state");
    assert.deepEqual(restored.view.current.document.snapshot.state, { value: 2 });
    assert.equal(restored.view.current.document.stateRevision, base + 1);
  } finally {
    await f.cleanup();
  }
});

test("concurrent displays: a live inspection from the current base still records its newer state", async () => {
  const f = await fixture("live-read");
  try {
    const { second, shown, mount } = await twoDisplays(f);
    const base = (await storedDocument(f, shown.id)).stateRevision;
    const reading = f.service.execute(
      f.owner,
      { kind: "inspect", id: shown.id, screenshot: false },
      f.signal,
    );
    const command = await second.next();
    if (command.kind !== "inspect") throw new Error("Expected the second display to answer");
    await f.service.receive({
      agentId: f.owner.agentId,
      source: second.source,
      receipt: {
        ...mount,
        commandId: command.commandId,
        sequence: 2,
        snapshot: { state: { value: 3 }, selection: null },
      },
    });
    const read = await reading;
    if (read.kind !== "visual") throw new Error("Expected an inspection result");
    assert.deepEqual(read.state, { value: 3 });
    assert.equal(read.stateRevision, base + 1);
  } finally {
    await f.cleanup();
  }
});

test("a render whose display is re-established mid-operation is re-targeted to the replacement display", async () => {
  const f = await fixture("retarget");
  const before = new DisplayPort();
  const after = new DisplayPort();
  try {
    const released = await observe(f, before, "electron");
    const presenting = f.service.execute(
      f.owner,
      { kind: "present", title: "Re-established", html: "<p>Again</p>" },
      f.signal,
    );
    const first = await before.next();
    if (first.kind !== "render") throw new Error("Expected the first render");
    released.release();
    const replacement = await observe(f, after, "electron");
    const retried = await after.next();
    if (retried.kind !== "render") throw new Error("Render was not re-targeted");
    assert.equal(retried.current.document.id, first.current.document.id);
    assert.notEqual(retried.current.binding.nonce, first.current.binding.nonce);
    assert.equal(retried.current.binding.clientGeneration, replacement.view.generation);
    await f.service.receive({
      agentId: f.owner.agentId,
      source: after.source,
      receipt: {
        binding: retried.current.binding,
        commandId: retried.commandId,
        sequence: 1,
        snapshot: { state: { value: 1 }, selection: null },
        actions: {},
        error: null,
      },
    });
    const shown = await presenting;
    if (shown.kind !== "visual") throw new Error("Expected the presentation result");
    assert.equal(shown.status, "rendered");
    assert.equal(shown.client, replacement.view.generation);
  } finally {
    await f.cleanup();
  }
});

test("a render whose display goes away without a replacement still fails explicitly", async () => {
  const directory = await mkdtemp(join(tmpdir(), "paseo-visual-android-noreplacement-"));
  const waits: { expire: () => void; milliseconds: number }[] = [];
  // Zero-delay checks run normally; every other deadline is fired by the test.
  const service = new VisualService(new VisualStorage(directory), (expire, milliseconds) => {
    if (milliseconds === 0) {
      const timer = setTimeout(expire, 0);
      return () => clearTimeout(timer);
    }
    waits.push({ expire, milliseconds });
    return () => undefined;
  });
  const owner = { agentId: "gone-agent", sessionId: "gone-session" };
  const display = new DisplayPort();
  try {
    const observation = await service.observe({
      agentId: owner.agentId,
      source: display.source,
      platform: "android",
      emit: display.emit,
    });
    const presenting = service.execute(
      owner,
      { kind: "present", title: "Gone", html: "<p>Gone</p>" },
      new AbortController().signal,
    );
    const rejected = assert.rejects(presenting, (error: unknown) => {
      return (
        error instanceof VisualFailure && error.code === "DISCONNECTED" && error.artifactId !== null
      );
    });
    await display.next();
    observation.release();
    await new Promise((resolve) => setTimeout(resolve, 10));
    const replacementWait = waits.find((wait) => wait.milliseconds <= 4000);
    if (!replacementWait) throw new Error("No bounded wait for a replacement display");
    replacementWait.expire();
    await rejected;
  } finally {
    service.close();
    await rm(directory, { recursive: true, force: true });
  }
});
