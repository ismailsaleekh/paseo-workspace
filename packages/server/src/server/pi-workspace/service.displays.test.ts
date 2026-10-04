import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { VisualFailure, type VisualCapture } from "@getpaseo/protocol/pi-workspace/contracts";
import type {
  VisualCommand,
  VisualEvent,
  VisualReceipt,
} from "@getpaseo/protocol/pi-workspace/rpc-schemas";
import { VisualService } from "./service.js";
import { VisualStorage } from "./storage.js";

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

test("a second display automatically restores current state; releasing it leaves the first live and rejects its late receipts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "paseo-visual-displays-"));
  const storage = new VisualStorage(directory);
  const service = new VisualService(storage);
  const owner = { agentId: "display-agent", sessionId: "display-session" };
  const signal = new AbortController().signal;
  const first = new DisplayPort();
  const second = new DisplayPort();
  const snapshot = { state: { value: 7 }, selection: { id: "value", text: "seven" } };
  try {
    const firstObservation = await service.observe({
      agentId: owner.agentId,
      source: first.source,
      emit: first.emit,
    });
    const presenting = service.execute(
      owner,
      { kind: "present", title: "Shared visual", html: "<p>Seven</p>" },
      signal,
    );
    const render = await first.next();
    if (render.kind !== "render") throw new Error("Expected initial render command");
    const firstReceipt: VisualReceipt = {
      binding: render.current.binding,
      commandId: render.commandId,
      sequence: 1,
      snapshot,
      actions: {},
      error: null,
    };
    await service.receive({ agentId: owner.agentId, source: first.source, receipt: firstReceipt });
    const presented = await presenting;
    if (presented.kind !== "visual") throw new Error("Expected presentation result");
    assert.equal(presented.status, "rendered");

    const secondObservation = await service.observe({
      agentId: owner.agentId,
      source: second.source,
      emit: second.emit,
    });
    const restored = secondObservation.view.current;
    if (!restored) throw new Error("Late join did not automatically restore the current visual");
    assert.equal(restored.document.id, presented.id);
    assert.equal(restored.document.revision, presented.revision);
    assert.deepEqual(restored.document.snapshot, snapshot);
    assert.notEqual(secondObservation.view.generation, firstObservation.view.generation);
    assert.notEqual(restored.binding.nonce, render.current.binding.nonce);
    const secondReceipt: VisualReceipt = {
      binding: restored.binding,
      commandId: null,
      sequence: 1,
      snapshot,
      actions: {},
      error: null,
    };
    await service.receive({
      agentId: owner.agentId,
      source: second.source,
      receipt: secondReceipt,
    });
    secondObservation.release();
    await assert.rejects(
      service.receive({
        agentId: owner.agentId,
        source: second.source,
        receipt: {
          ...secondReceipt,
          sequence: 2,
          snapshot: { state: { value: 999 }, selection: null },
        },
      }),
      (error: unknown) => error instanceof VisualFailure && error.code === "STALE_CLIENT",
    );
    assert.deepEqual((await storage.get({ owner, id: presented.id })).snapshot, snapshot);

    const inspecting = service.execute(
      owner,
      { kind: "inspect", id: presented.id, screenshot: false },
      signal,
    );
    const inspection = await first.next();
    if (inspection.kind !== "inspect")
      throw new Error("Remaining display did not receive inspection");
    assert.deepEqual(inspection.binding, render.current.binding);
    await service.receive({
      agentId: owner.agentId,
      source: first.source,
      receipt: { ...firstReceipt, commandId: inspection.commandId, sequence: 2 },
    });
    const inspected = await inspecting;
    if (inspected.kind !== "visual") throw new Error("Expected live inspection result");
    assert.equal(inspected.status, "rendered");
    assert.deepEqual(inspected.state, snapshot.state);
    assert.deepEqual(inspected.selection, snapshot.selection);
    firstObservation.release();
  } finally {
    service.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("addressed inspection reports its own display without changing the active display or substituting closed clients", async () => {
  const directory = await mkdtemp(join(tmpdir(), "paseo-visual-addressing-"));
  const storage = new VisualStorage(directory);
  const service = new VisualService(storage);
  const owner = { agentId: "address-agent", sessionId: "address-session" };
  const first = new DisplayPort();
  const second = new DisplayPort();
  const signal = new AbortController().signal;
  const snapshot = { state: { value: 3 }, selection: null };
  try {
    const firstObservation = await service.observe({
      agentId: owner.agentId,
      source: first.source,
      platform: "web",
      emit: first.emit,
    });
    const presenting = service.execute(
      owner,
      { kind: "present", title: "Addressed state", html: "<p>Three</p>" },
      signal,
    );
    const render = await first.next();
    if (render.kind !== "render") throw new Error("Expected render");
    const firstReceipt: VisualReceipt = {
      binding: render.current.binding,
      commandId: render.commandId,
      sequence: 1,
      snapshot,
      actions: {},
      error: null,
    };
    await service.receive({ agentId: owner.agentId, source: first.source, receipt: firstReceipt });
    const shown = await presenting;
    if (shown.kind !== "visual") throw new Error("Expected a visual");
    const secondObservation = await service.observe({
      agentId: owner.agentId,
      source: second.source,
      platform: "electron",
      emit: second.emit,
    });
    const restored = secondObservation.view.current;
    if (!restored) throw new Error("Expected restored current visual");
    const secondReceipt: VisualReceipt = {
      ...firstReceipt,
      binding: restored.binding,
      commandId: null,
    };
    await service.receive({
      agentId: owner.agentId,
      source: second.source,
      receipt: secondReceipt,
    });
    const addressed = service.execute(
      owner,
      {
        kind: "inspect",
        id: shown.id,
        screenshot: false,
        client: firstObservation.view.generation,
      },
      signal,
    );
    const commandA = await first.next();
    if (commandA.kind !== "inspect") throw new Error("Expected addressed inspection");
    assert.deepEqual(commandA.binding, firstReceipt.binding);
    await service.receive({
      agentId: owner.agentId,
      source: first.source,
      receipt: { ...firstReceipt, commandId: commandA.commandId, sequence: 2 },
    });
    const inspectedA = await addressed;
    if (inspectedA.kind !== "visual") throw new Error("Expected addressed visual result");
    assert.equal(inspectedA.client, firstObservation.view.generation);
    assert.deepEqual(inspectedA.displays, [
      { client: firstObservation.view.generation, platform: "web", active: false },
      { client: secondObservation.view.generation, platform: "electron", active: true },
    ]);
    const defaultInspect = service.execute(
      owner,
      { kind: "inspect", id: shown.id, screenshot: false },
      signal,
    );
    const commandB = await second.next();
    if (commandB.kind !== "inspect") throw new Error("Expected active inspection");
    assert.deepEqual(commandB.binding, secondReceipt.binding);
    await service.receive({
      agentId: owner.agentId,
      source: second.source,
      receipt: { ...secondReceipt, commandId: commandB.commandId, sequence: 2 },
    });
    const inspectedB = await defaultInspect;
    if (inspectedB.kind !== "visual") throw new Error("Expected active visual result");
    assert.equal(inspectedB.client, secondObservation.view.generation);
    assert.deepEqual(inspectedB.displays, inspectedA.displays);
    secondObservation.release();
    const firstCommandCount = first.events.filter((event) => event.kind === "command").length;
    for (const client of [secondObservation.view.generation, "unknown-display"]) {
      await assert.rejects(
        service.execute(owner, { kind: "inspect", id: shown.id, screenshot: true, client }, signal),
        (error: unknown) => error instanceof VisualFailure && error.code === "DISPLAY_UNAVAILABLE",
      );
    }
    assert.equal(
      first.events.filter((event) => event.kind === "command").length,
      firstCommandCount,
    );
    await assert.rejects(
      service.execute(
        owner,
        {
          kind: "inspect",
          id: shown.id,
          screenshot: true,
          client: firstObservation.view.generation,
        },
        signal,
      ),
      (error: unknown) => error instanceof VisualFailure && error.code === "CAPTURE_UNSUPPORTED",
    );
    firstObservation.release();
    await assert.rejects(
      service.execute(owner, { kind: "inspect", id: shown.id, screenshot: true }, signal),
      (error: unknown) => error instanceof VisualFailure && error.code === "CLIENT_UNAVAILABLE",
    );
  } finally {
    service.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a terminated document stays unresponsive for inspect and act until explicitly reopened", async () => {
  const directory = await mkdtemp(join(tmpdir(), "paseo-visual-unresponsive-"));
  const storage = new VisualStorage(directory);
  const service = new VisualService(storage);
  const owner = { agentId: "hang-agent", sessionId: "hang-session" };
  const display = new DisplayPort();
  const signal = new AbortController().signal;
  const snapshot = { state: { value: 17 }, selection: "retained" };
  try {
    await service.observe({ agentId: owner.agentId, source: display.source, emit: display.emit });
    const presenting = service.execute(
      owner,
      { kind: "present", title: "Recoverable", html: "<p>Saved</p>" },
      signal,
    );
    const render = await display.next();
    if (render.kind !== "render") throw new Error("Expected render");
    const receipt: VisualReceipt = {
      binding: render.current.binding,
      commandId: render.commandId,
      sequence: 1,
      snapshot,
      actions: {},
      error: null,
    };
    await service.receive({ agentId: owner.agentId, source: display.source, receipt });
    const shown = await presenting;
    if (shown.kind !== "visual") throw new Error("Expected a visual");
    const before = await storage.get({ owner, id: shown.id });
    await service.receive({
      agentId: owner.agentId,
      source: display.source,
      receipt: {
        ...receipt,
        commandId: null,
        sequence: 2,
        error: { code: "DOCUMENT_UNRESPONSIVE", message: "Host terminated renderer" },
      },
    });
    for (const screenshot of [false, true, false])
      await assert.rejects(
        service.execute(owner, { kind: "inspect", id: shown.id, screenshot }, signal),
        (error: unknown) =>
          error instanceof VisualFailure && error.code === "DOCUMENT_UNRESPONSIVE",
      );
    await assert.rejects(
      service.execute(
        owner,
        { kind: "act", id: shown.id, action: "anything", value: null },
        signal,
      ),
      (error: unknown) => error instanceof VisualFailure && error.code === "DOCUMENT_UNRESPONSIVE",
    );
    await assert.rejects(
      service.receive({
        agentId: owner.agentId,
        source: display.source,
        receipt: { ...receipt, commandId: null, sequence: 3 },
      }),
      (error: unknown) => error instanceof VisualFailure && error.code === "DOCUMENT_UNRESPONSIVE",
    );
    assert.deepEqual(await storage.get({ owner, id: shown.id }), before);
    const context = await service.execute(owner, { kind: "context" }, signal);
    if (context.kind !== "context" || !context.visual)
      throw new Error("Terminated display disappeared");
    assert.equal(context.visual.displays?.length, 1);
    assert.equal(context.visual.error?.code, "DOCUMENT_UNRESPONSIVE");
    const opening = service.execute(owner, { kind: "open", id: shown.id }, signal);
    const replacement = await display.next();
    if (replacement.kind !== "render") throw new Error("Expected a fresh render");
    assert.notEqual(replacement.current.binding.nonce, receipt.binding.nonce);
    assert.deepEqual(replacement.current.document.snapshot, snapshot);
    await service.receive({
      agentId: owner.agentId,
      source: display.source,
      receipt: {
        ...receipt,
        binding: replacement.current.binding,
        commandId: replacement.commandId,
      },
    });
    const reopened = await opening;
    if (reopened.kind !== "visual") throw new Error("Expected reopened visual");
    assert.equal(reopened.status, "rendered");
    assert.equal(reopened.error, null);
  } finally {
    service.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("trusted desktop activity changes the active display; hidden and forged events cannot target another host", async () => {
  const directory = await mkdtemp(join(tmpdir(), "paseo-visual-activity-"));
  const service = new VisualService(new VisualStorage(directory));
  const owner = { agentId: "activity-agent", sessionId: "activity-session" };
  const first = new DisplayPort();
  const second = new DisplayPort();
  const signal = new AbortController().signal;
  try {
    const a = await service.observe({
      agentId: owner.agentId,
      source: first.source,
      platform: "electron",
      emit: first.emit,
    });
    const presenting = service.execute(
      owner,
      { kind: "present", title: "Activity", html: "<p>Input</p>" },
      signal,
    );
    const render = await first.next();
    if (render.kind !== "render") throw new Error("Expected render");
    const receipt: VisualReceipt = {
      binding: render.current.binding,
      commandId: render.commandId,
      sequence: 1,
      snapshot: { state: null, selection: null },
      actions: {},
      error: null,
    };
    await service.receive({ agentId: owner.agentId, source: first.source, receipt });
    const shown = await presenting;
    if (shown.kind !== "visual") throw new Error("Expected visual");
    const b = await service.observe({
      agentId: owner.agentId,
      source: second.source,
      platform: "electron",
      emit: second.emit,
    });
    const currentB = b.view.current;
    if (!currentB) throw new Error("Expected late join");
    // Trusted input on the first display precedes the late joiner's mount receipt; the
    // receipt must not take the active role back from the display the user touched.
    await service.receive({
      agentId: owner.agentId,
      source: first.source,
      receipt: { kind: "activity", binding: receipt.binding },
    });
    await service.receive({
      agentId: owner.agentId,
      source: second.source,
      receipt: { ...receipt, binding: currentB.binding, commandId: null },
    });
    const context = await service.execute(owner, { kind: "context" }, signal);
    if (context.kind !== "context" || !context.visual) throw new Error("Expected visual context");
    assert.equal(context.visual.client, a.view.generation);
    await assert.rejects(
      service.receive({
        agentId: owner.agentId,
        source: second.source,
        receipt: { kind: "activity", binding: receipt.binding },
      }),
      (error: unknown) => error instanceof VisualFailure && error.code === "STALE_CLIENT",
    );
    await service.receive({
      agentId: owner.agentId,
      source: first.source,
      receipt: { kind: "visibility", binding: receipt.binding, visible: false },
    });
    const backgrounded = await service.execute(owner, { kind: "context" }, signal);
    if (backgrounded.kind !== "context" || !backgrounded.visual)
      throw new Error("Expected remaining display");
    assert.deepEqual(backgrounded.visual.displays, [
      { client: b.view.generation, platform: "electron", active: true },
    ]);
    await assert.rejects(
      service.execute(
        owner,
        { kind: "inspect", id: shown.id, screenshot: true, client: a.view.generation },
        signal,
      ),
      (error: unknown) => error instanceof VisualFailure && error.code === "DISPLAY_UNAVAILABLE",
    );
    await assert.rejects(
      service.receive({
        agentId: owner.agentId,
        source: first.source,
        receipt: { kind: "activity", binding: receipt.binding },
      }),
      (error: unknown) => error instanceof VisualFailure && error.code === "DISPLAY_UNAVAILABLE",
    );
    await service.receive({
      agentId: owner.agentId,
      source: first.source,
      receipt: { kind: "visibility", binding: receipt.binding, visible: true },
    });
    await service.receive({
      agentId: owner.agentId,
      source: first.source,
      receipt: { kind: "activity", binding: receipt.binding },
    });
    const foregrounded = await service.execute(owner, { kind: "context" }, signal);
    if (foregrounded.kind !== "context" || !foregrounded.visual)
      throw new Error("Expected foregrounded display");
    assert.equal(foregrounded.visual.client, a.view.generation);
    assert.equal(foregrounded.visual.displays?.length, 2);
  } finally {
    service.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("capture receipts bind operation and state without mutating storage; stale captures never satisfy an inspection", async () => {
  const directory = await mkdtemp(join(tmpdir(), "paseo-visual-capture-"));
  const storage = new VisualStorage(directory);
  const service = new VisualService(storage);
  const owner = { agentId: "capture-agent", sessionId: "capture-session" };
  const display = new DisplayPort();
  const signal = new AbortController().signal;
  try {
    await service.observe({
      agentId: owner.agentId,
      source: display.source,
      platform: "electron",
      emit: display.emit,
    });
    const presenting = service.execute(
      owner,
      { kind: "present", title: "Capture binding", html: "<p>Stored</p>" },
      signal,
    );
    const render = await display.next();
    if (render.kind !== "render") throw new Error("Expected render");
    const receipt: VisualReceipt = {
      binding: render.current.binding,
      commandId: render.commandId,
      sequence: 1,
      snapshot: { state: { value: 1 }, selection: null },
      actions: {},
      error: null,
    };
    await service.receive({ agentId: owner.agentId, source: display.source, receipt });
    const shown = await presenting;
    if (shown.kind !== "visual") throw new Error("Expected visual");
    const before = await storage.get({ owner, id: shown.id });
    const inspecting = service.execute(
      owner,
      { kind: "inspect", id: shown.id, screenshot: true },
      signal,
    );
    const command = await display.next();
    if (command.kind !== "inspect" || command.stateRevision === undefined)
      throw new Error("Capture request lacks state binding");
    assert.equal(command.screenshot, true);
    const capture: VisualCapture = {
      operationId: command.commandId,
      binding: command.binding,
      screenshot: {
        client: command.binding.clientGeneration,
        mimeType: "image/png",
        width: 1,
        height: 1,
        viewport: { width: 1, height: 1 },
        pixelRatio: 1,
        revision: command.binding.revision,
        stateRevision: command.stateRevision,
      },
      data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lZsAAAAASUVORK5CYII=",
    };
    await service.receive({
      agentId: owner.agentId,
      source: display.source,
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
    assert.equal(result.stateRevision, before.stateRevision);
    assert.deepEqual(await storage.get({ owner, id: shown.id }), before);
    const invalid = service.execute(
      owner,
      { kind: "inspect", id: shown.id, screenshot: true },
      signal,
    );
    const invalidRejected = assert.rejects(
      invalid,
      (error: unknown) => error instanceof VisualFailure && error.code === "INVALID_CAPTURE",
    );
    const invalidCommand = await display.next();
    await assert.rejects(
      service.receive({
        agentId: owner.agentId,
        source: display.source,
        receipt: {
          ...receipt,
          commandId: invalidCommand.commandId,
          sequence: 3,
          stateRevision: before.stateRevision,
          capture,
        },
      }),
      (error: unknown) => error instanceof VisualFailure && error.code === "INVALID_CAPTURE",
    );
    await invalidRejected;
    const racing = service.execute(
      owner,
      { kind: "inspect", id: shown.id, screenshot: true },
      signal,
    );
    const racingRejected = assert.rejects(
      racing,
      (error: unknown) => error instanceof VisualFailure && error.code === "STALE_STATE",
    );
    const racingCommand = await display.next();
    await service.receive({
      agentId: owner.agentId,
      source: display.source,
      receipt: {
        ...receipt,
        commandId: null,
        sequence: 4,
        stateRevision: before.stateRevision,
        snapshot: { state: { value: 2 }, selection: null },
      },
    });
    await assert.rejects(
      service.receive({
        agentId: owner.agentId,
        source: display.source,
        receipt: {
          ...receipt,
          commandId: racingCommand.commandId,
          sequence: 5,
          stateRevision: before.stateRevision,
          capture: { ...capture, operationId: racingCommand.commandId },
        },
      }),
      (error: unknown) => error instanceof VisualFailure && error.code === "STALE_STATE",
    );
    await racingRejected;
    assert.deepEqual((await storage.get({ owner, id: shown.id })).snapshot.state, { value: 2 });
  } finally {
    service.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("two hosts on one authenticated connection reject a stale base and converge without changing document bindings", async () => {
  const directory = await mkdtemp(join(tmpdir(), "paseo-visual-state-cas-"));
  const storage = new VisualStorage(directory);
  const service = new VisualService(storage);
  const owner = { agentId: "cas-agent", sessionId: "cas-session" };
  const source = {};
  const first = new DisplayPort(source);
  const second = new DisplayPort(source);
  const initial = { state: { value: 1 }, selection: null };
  try {
    await service.observe({ agentId: owner.agentId, source, emit: first.emit });
    const presenting = service.execute(
      owner,
      { kind: "present", title: "Concurrent controls", html: "<p>One</p>" },
      new AbortController().signal,
    );
    const render = await first.next();
    if (render.kind !== "render") throw new Error("Expected a render command");
    const firstReceipt: VisualReceipt = {
      binding: render.current.binding,
      commandId: render.commandId,
      sequence: 1,
      stateRevision: render.current.document.stateRevision,
      snapshot: initial,
      actions: {},
      error: null,
    };
    await service.receive({ agentId: owner.agentId, source, receipt: firstReceipt });
    const presented = await presenting;
    if (presented.kind !== "visual") throw new Error("Expected a presented visual");
    const observation = await service.observe({
      agentId: owner.agentId,
      source,
      emit: second.emit,
    });
    const restored = observation.view.current;
    if (!restored) throw new Error("Expected restored state for the second host");
    const secondReceipt: VisualReceipt = {
      ...firstReceipt,
      binding: restored.binding,
      commandId: null,
      stateRevision: restored.document.stateRevision,
    };
    await service.receive({ agentId: owner.agentId, source, receipt: secondReceipt });
    const base = await storage.get({ owner, id: presented.id });
    const winning = { state: { value: 8 }, selection: "first" };
    await service.receive({
      agentId: owner.agentId,
      source,
      receipt: {
        ...firstReceipt,
        commandId: null,
        sequence: 2,
        stateRevision: base.stateRevision,
        snapshot: winning,
      },
    });
    const committed = await storage.get({ owner, id: presented.id });
    assert.equal(committed.stateRevision, base.stateRevision + 1);
    await assert.rejects(
      service.receive({
        agentId: owner.agentId,
        source,
        receipt: {
          ...secondReceipt,
          sequence: 2,
          stateRevision: base.stateRevision,
          snapshot: { state: { value: 9 }, selection: "stale" },
        },
      }),
      (error: unknown) => error instanceof VisualFailure && error.code === "STALE_STATE",
    );
    assert.deepEqual(await storage.get({ owner, id: presented.id }), committed);
    for (const [display, binding] of [
      [first, firstReceipt.binding],
      [second, secondReceipt.binding],
    ] as const) {
      const event = display.events.at(-1);
      if (!event || event.kind !== "snapshot" || !event.view.current)
        throw new Error("Rejected state was not restored to the display");
      assert.deepEqual(event.view.current.binding, binding);
      assert.deepEqual(event.view.current.document.snapshot, winning);
      assert.equal(event.view.current.document.stateRevision, committed.stateRevision);
    }
    const converged = { state: { value: 10 }, selection: "second" };
    await service.receive({
      agentId: owner.agentId,
      source,
      receipt: {
        ...secondReceipt,
        sequence: 3,
        stateRevision: committed.stateRevision,
        snapshot: converged,
      },
    });
    const final = await storage.get({ owner, id: presented.id });
    assert.equal(final.stateRevision, committed.stateRevision + 1);
    assert.deepEqual(final.snapshot, converged);
    const firstUpdate = first.events.at(-1);
    if (!firstUpdate || firstUpdate.kind !== "snapshot" || !firstUpdate.view.current)
      throw new Error("First display did not receive the second display's stored state");
    assert.deepEqual(firstUpdate.view.current.binding, firstReceipt.binding);
    assert.deepEqual(firstUpdate.view.current.document.snapshot, converged);
    await assert.rejects(
      service.receive({
        agentId: owner.agentId,
        source: {},
        receipt: { ...secondReceipt, sequence: 4 },
      }),
      (error: unknown) => error instanceof VisualFailure && error.code === "STALE_CLIENT",
    );
    await assert.rejects(
      service.receive({
        agentId: "another-agent",
        source,
        receipt: { ...secondReceipt, sequence: 4 },
      }),
      (error: unknown) => error instanceof VisualFailure && error.code === "STALE_CLIENT",
    );
  } finally {
    service.close();
    await rm(directory, { recursive: true, force: true });
  }
});
