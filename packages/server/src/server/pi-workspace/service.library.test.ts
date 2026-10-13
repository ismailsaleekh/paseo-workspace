import { test, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { VisualStorage } from "./storage.js";
import { VisualService } from "./service.js";
import {
  decodeVisualView,
  type VisualEvent,
  type VisualCommand,
} from "@getpaseo/protocol/pi-workspace/rpc-schemas";
import { requiredPermissionForInbound } from "../authorization/operation-permissions.js";

const owner = { agentId: "library-agent", sessionId: "native-pi-session" };
class LibraryDisplay {
  readonly events: VisualEvent[] = [];
  private readonly commands: VisualCommand[] = [];
  private waiting: ((command: VisualCommand) => void) | null = null;
  emit = (event: VisualEvent): void => {
    this.events.push(event);
    if (event.kind !== "command") return;
    if (this.waiting) {
      const done = this.waiting;
      this.waiting = null;
      done(event.command);
    } else this.commands.push(event.command);
  };
  next = (): Promise<VisualCommand> => {
    const command = this.commands.shift();
    if (command) return Promise.resolve(command);
    if (this.waiting) throw new Error("Display already awaits a command");
    return new Promise((resolve) => {
      this.waiting = resolve;
    });
  };
}
test("collapsed presentation is stored without opening; UI reads are source-owned and historical interaction cannot overwrite latest", async () => {
  const root = await mkdtemp(join(tmpdir(), "library-service-"));
  const storage = new VisualStorage(root);
  const service = new VisualService(storage);
  try {
    const source = {};
    const events: VisualEvent[] = [];
    const observation = await service.observe({
      agentId: owner.agentId,
      owner,
      source,
      library: true,
      emit: (event) => events.push(event),
    });
    const input = { owner, source, generation: observation.view.generation };
    const signal = new AbortController().signal;
    const first = await service.execute(
      owner,
      { kind: "present", title: "One", html: "<p>one</p>" },
      signal,
    );
    expect(first).toMatchObject({ kind: "visual", revision: 1, status: "stored" });
    if (first.kind !== "visual") throw new Error("Missing visual");
    expect(events.some((event) => event.kind === "command")).toBe(false);
    expect(await service.library({ ...input, operation: { kind: "list" } })).toEqual({
      kind: "list",
      items: [{ id: first.id, title: "One", revision: 1 }],
      nextCursor: null,
    });
    await expect(
      service.library({ ...input, source: {}, operation: { kind: "list" } }),
    ).rejects.toMatchObject({ code: "STALE_CLIENT" });
    await expect(
      service.library({
        ...input,
        owner: { ...owner, sessionId: "foreign" },
        operation: { kind: "list" },
      }),
    ).rejects.toMatchObject({ code: "STALE_SESSION" });
    const original = await storage.get({ owner, id: first.id });
    const staged = await storage.stageSource({
      owner,
      id: first.id,
      revision: 1,
      html: "<p>two</p>",
    });
    await storage.commitSource({
      owner,
      id: first.id,
      previousRevision: 1,
      revision: staged.revision,
      stateRevision: original.stateRevision,
      snapshot: original.snapshot,
    });
    const latest = await storage.get({ owner, id: first.id });
    await service.library({ ...input, operation: { kind: "visibility", visible: true } });
    const selected = await service.library({
      ...input,
      operation: { kind: "select", id: first.id, revision: 1 },
    });
    if (selected.kind !== "view") throw new Error("Missing historical view");
    const current = decodeVisualView(selected.view).current;
    if (!current) throw new Error("Missing historical document");
    const historyRevision = await service.receive({
      agentId: owner.agentId,
      source,
      receipt: {
        binding: current.binding,
        commandId: null,
        sequence: 1,
        stateRevision: current.document.stateRevision,
        snapshot: { state: 99, selection: null },
        actions: {},
        error: null,
      },
    });
    expect(historyRevision).toBe(current.document.stateRevision + 1);
    expect(await storage.get({ owner, id: first.id })).toEqual(latest);
    expect(await service.execute(owner, { kind: "context" }, signal)).toMatchObject({
      kind: "context",
      visual: { revision: 1, stateRevision: historyRevision, state: 99, status: "rendered" },
    });
    const restored = await service.library({
      ...input,
      operation: { kind: "select", id: first.id, revision: null },
    });
    if (restored.kind !== "view") throw new Error("Missing latest view");
    expect(decodeVisualView(restored.view).current?.document).toEqual(latest);
    expect(requiredPermissionForInbound("pi_workspace.library.request")).toBe("workspace.read");
    expect(requiredPermissionForInbound("pi_workspace.receipt.request")).toBe("workspace.write");
    observation.release();
    await expect(service.library({ ...input, operation: { kind: "list" } })).rejects.toMatchObject({
      code: "STALE_CLIENT",
    });
  } finally {
    service.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("collapsed and historical replacements remain abandoned until a visible Latest view verifies restoration", async () => {
  const root = await mkdtemp(join(tmpdir(), "library-gate-"));
  const storage = new VisualStorage(root);
  const service = new VisualService(storage);
  const source = {};
  const display = new LibraryDisplay();
  const commands = display.events;
  try {
    const observation = await service.observe({
      agentId: owner.agentId,
      owner,
      source,
      library: true,
      emit: display.emit,
    });
    const input = { owner, source, generation: observation.view.generation };
    const signal = new AbortController().signal;
    const presented = await service.execute(
      owner,
      { kind: "present", title: "Gated", html: "<p>one</p>" },
      signal,
    );
    if (presented.kind !== "visual") throw new Error("No stored drawing");
    const address = { owner, id: presented.id };
    const first = await storage.saveState({
      ...address,
      revision: 1,
      stateRevision: 1,
      snapshot: { state: { value: 7 }, selection: null },
    });
    await expect(
      service.execute(
        owner,
        { kind: "update", id: first.id, revision: 1, html: "<p>Cannot restore</p>" },
        signal,
      ),
    ).rejects.toMatchObject({ code: "NOT_DISPLAYED" });
    expect(await storage.get(address)).toEqual(first);
    expect(await storage.listVersions(address)).toEqual({
      items: [{ revision: 1 }],
      nextCursor: null,
    });
    expect(commands.filter((event) => event.kind === "command")).toEqual([]);
    const staged = await storage.stageSource({
      ...address,
      revision: 1,
      html: "<p>Valid committed fixture</p>",
    });
    const latest = await storage.commitSource({
      ...address,
      previousRevision: 1,
      revision: staged.revision,
      stateRevision: first.stateRevision,
      snapshot: first.snapshot,
    });
    await service.library({ ...input, operation: { kind: "visibility", visible: true } });
    await service.library({ ...input, operation: { kind: "select", id: first.id, revision: 1 } });
    await expect(
      service.execute(
        owner,
        { kind: "update", id: first.id, revision: latest.revision, html: "<p>Cannot restore</p>" },
        signal,
      ),
    ).rejects.toMatchObject({ code: "NOT_DISPLAYED" });
    expect(await storage.get(address)).toEqual(latest);
    expect((await storage.listVersions(address)).items).toEqual([
      { revision: latest.revision },
      { revision: 1 },
    ]);
    expect(commands.filter((event) => event.kind === "command")).toEqual([]);
    const selected = await service.library({
      ...input,
      operation: { kind: "select", id: first.id, revision: null },
    });
    if (selected.kind !== "view") throw new Error("No latest selection");
    const current = decodeVisualView(selected.view).current;
    if (!current) throw new Error("No latest document");
    await service.receive({
      agentId: owner.agentId,
      source,
      receipt: {
        binding: current.binding,
        commandId: null,
        sequence: 1,
        stateRevision: latest.stateRevision,
        snapshot: latest.snapshot,
        actions: {},
        error: null,
      },
    });
    const nextCommand = display.next;
    const failing = service.execute(
      owner,
      { kind: "update", id: first.id, revision: latest.revision, html: "<p>Cannot restore</p>" },
      signal,
    );
    const refused = expect(failing).rejects.toMatchObject({ code: "DOCUMENT_ERROR" });
    const failureCommand = await nextCommand();
    if (failureCommand.kind !== "render")
      throw new Error("Expected replacement restoration command");
    await service.receive({
      agentId: owner.agentId,
      source,
      receipt: {
        binding: failureCommand.current.binding,
        commandId: failureCommand.commandId,
        sequence: 1,
        stateRevision: latest.stateRevision,
        snapshot: latest.snapshot,
        actions: {},
        error: { code: "DOCUMENT_ERROR", message: "Replacement cannot restore saved choices" },
      },
    });
    await refused;
    expect(await storage.get(address)).toEqual(latest);
    expect((await storage.listVersions(address)).items).toEqual([
      { revision: latest.revision },
      { revision: 1 },
    ]);
    const updating = service.execute(
      owner,
      {
        kind: "update",
        id: first.id,
        revision: latest.revision,
        html: "<p>Restoration verified</p>",
      },
      signal,
    );
    const validCommand = await nextCommand();
    if (validCommand.kind !== "render") throw new Error("Expected verified restoration command");
    await service.receive({
      agentId: owner.agentId,
      source,
      receipt: {
        binding: validCommand.current.binding,
        commandId: validCommand.commandId,
        sequence: 1,
        stateRevision: latest.stateRevision,
        snapshot: latest.snapshot,
        actions: {},
        error: null,
      },
    });
    const updated = await updating;
    expect(updated).toMatchObject({
      kind: "visual",
      status: "rendered",
      revision: validCommand.current.document.revision,
    });
    expect((await storage.get(address)).snapshot).toEqual(latest.snapshot);
    expect((await storage.listVersions(address)).items).toEqual([
      { revision: validCommand.current.document.revision },
      { revision: latest.revision },
      { revision: 1 },
    ]);
  } finally {
    service.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("historical actions advance ephemeral state revisions, inspection reports them, and stale captures are refused", async () => {
  const root = await mkdtemp(join(tmpdir(), "history-actions-"));
  const storage = new VisualStorage(root);
  const service = new VisualService(storage);
  const source = {};
  const display = new LibraryDisplay();
  try {
    const created = await storage.create({ owner, title: "History", html: "<p>one</p>" });
    const address = { owner, id: created.id };
    const first = await storage.saveState({
      ...address,
      revision: 1,
      stateRevision: 1,
      snapshot: { state: 7, selection: null },
    });
    const staged = await storage.stageSource({ ...address, revision: 1, html: "<p>two</p>" });
    const latest = await storage.commitSource({
      ...address,
      previousRevision: 1,
      revision: staged.revision,
      stateRevision: first.stateRevision,
      snapshot: { state: 9, selection: null },
    });
    const observed = await service.observe({
      agentId: owner.agentId,
      owner,
      source,
      platform: "electron",
      library: true,
      emit: display.emit,
    });
    const input = { owner, source, generation: observed.view.generation };
    await service.library({ ...input, operation: { kind: "visibility", visible: true } });
    const selected = await service.library({
      ...input,
      operation: { kind: "select", id: created.id, revision: 1 },
    });
    if (selected.kind !== "view") throw new Error("No history view");
    const current = decodeVisualView(selected.view).current;
    if (!current) throw new Error("No historical document");
    const actions = { set: { description: "Set preview", parameters: { type: "number" } } };
    const publish = (sequence: number, stateRevision: number, state: number) =>
      service.receive({
        agentId: owner.agentId,
        source,
        receipt: {
          binding: current.binding,
          commandId: null,
          sequence,
          stateRevision,
          snapshot: { state, selection: null },
          actions,
          error: null,
        },
      });
    expect(await publish(1, first.stateRevision, 7)).toBe(first.stateRevision);
    const nextCommand = display.next;
    const signal = new AbortController().signal;
    const acting = service.execute(
      owner,
      { kind: "act", id: created.id, action: "set", value: 11 },
      signal,
    );
    const action = await nextCommand();
    if (action.kind !== "act") throw new Error("Expected actual action delivery");
    const revision = await service.receive({
      agentId: owner.agentId,
      source,
      receipt: {
        binding: current.binding,
        commandId: action.commandId,
        sequence: 2,
        stateRevision: first.stateRevision,
        snapshot: { state: 11, selection: null },
        actions,
        error: null,
      },
    });
    expect(revision).toBe(first.stateRevision + 1);
    expect(await acting).toMatchObject({
      kind: "visual",
      revision: 1,
      stateRevision: revision,
      state: 11,
    });
    const inspecting = service.execute(
      owner,
      { kind: "inspect", id: created.id, screenshot: false },
      signal,
    );
    const inspection = await nextCommand();
    if (inspection.kind !== "inspect") throw new Error("Expected actual inspection delivery");
    await service.receive({
      agentId: owner.agentId,
      source,
      receipt: {
        binding: current.binding,
        commandId: inspection.commandId,
        sequence: 3,
        stateRevision: revision,
        snapshot: { state: 11, selection: null },
        actions,
        error: null,
      },
    });
    expect(await inspecting).toMatchObject({ revision: 1, stateRevision: revision, state: 11 });
    const capturing = service.execute(
      owner,
      { kind: "inspect", id: created.id, screenshot: true },
      signal,
    );
    const refused = expect(capturing).rejects.toMatchObject({ code: "STALE_STATE" });
    const captureCommand = await nextCommand();
    if (captureCommand.kind !== "inspect") throw new Error("Expected actual capture delivery");
    const newer = await publish(4, revision, 12);
    expect(newer).toBe(revision + 1);
    await expect(
      service.receive({
        agentId: owner.agentId,
        source,
        receipt: {
          binding: current.binding,
          commandId: captureCommand.commandId,
          sequence: 5,
          stateRevision: revision,
          snapshot: { state: 11, selection: null },
          actions,
          error: null,
          capture: {
            operationId: captureCommand.commandId,
            binding: current.binding,
            data: "AAAA",
            screenshot: {
              client: observed.view.generation,
              mimeType: "image/png",
              width: 1,
              height: 1,
              viewport: { width: 1, height: 1 },
              pixelRatio: 1,
              revision: 1,
              stateRevision: revision,
            },
          },
        },
      }),
    ).rejects.toMatchObject({ code: "STALE_STATE" });
    await refused;
    await expect(publish(6, revision, 99)).rejects.toMatchObject({ code: "STALE_STATE" });
    expect(await service.execute(owner, { kind: "context" }, signal)).toMatchObject({
      visual: { revision: 1, stateRevision: newer, state: 12 },
    });
    expect(await storage.get(address)).toEqual(latest);
    expect((await storage.getVersion({ ...address, revision: 1 })).snapshot).toEqual(
      first.snapshot,
    );
    const restored = await service.library({
      ...input,
      operation: { kind: "select", id: created.id, revision: null },
    });
    if (restored.kind !== "view") throw new Error("No latest view");
    expect(decodeVisualView(restored.view).current?.document).toEqual(latest);
  } finally {
    service.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a daemon reopen reads exact persisted conversation without an agent launch", async () => {
  const root = await mkdtemp(join(tmpdir(), "library-reopen-"));
  const storage = new VisualStorage(root);
  try {
    const drawing = await storage.create({ owner, title: "Retained", html: "<p>saved</p>" });
    const service = new VisualService(new VisualStorage(root));
    try {
      const source = {};
      const observation = await service.observe({
        agentId: owner.agentId,
        owner,
        source,
        library: true,
        emit: () => {},
      });
      expect(
        await service.library({
          owner,
          source,
          generation: observation.view.generation,
          operation: { kind: "list" },
        }),
      ).toEqual({
        kind: "list",
        items: [{ id: drawing.id, title: "Retained", revision: 1 }],
        nextCursor: null,
      });
    } finally {
      service.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
