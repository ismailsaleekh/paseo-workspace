import assert from "node:assert/strict";
import { test } from "vitest";
import type { ConnectionState } from "@getpaseo/client/internal/daemon-client";
import {
  encodeVisualEvent,
  decodeVisualEvent,
  type VisualEvent,
  type VisualReceipt,
  type VisualRenderDocument,
} from "@getpaseo/protocol/pi-workspace/rpc-schemas";
import { validateWSOutboundMessage } from "@getpaseo/protocol/validation/ws-outbound";
import { VisualController, type VisualTransport } from "./controller";

type Observation = ReturnType<VisualTransport["observePiWorkspace"]>;
type Observer = Parameters<Observation["subscribe"]>[0];
type Snapshot = Parameters<Observer["snapshot"]>[0];
type ReceiptResult = Awaited<ReturnType<VisualTransport["sendPiWorkspaceReceipt"]>>;
const agentId = "agent";
const generation = "b5bed943-2cd8-48bd-ab77-8808b6284674";
const id = "25afcecf-bc68-4c7f-b408-2640ed2a0026";
const nonce = "7c6c0224-4617-4c5b-bbfe-03c3c330c608";
const current: VisualRenderDocument = {
  binding: { id, revision: 1, nonce, clientGeneration: generation },
  document: {
    id,
    title: "Controller test",
    revision: 1,
    stateRevision: 1,
    html: "<p>document</p>",
    snapshot: { state: null, selection: null },
  },
};

class Transport implements VisualTransport {
  observer: Observer | null = null;
  status: ((value: ConnectionState) => void) | null = null;
  releases = 0;
  readonly receipts: VisualReceipt[] = [];
  failure: Error | null = null;
  pending: Promise<ReceiptResult> | null = null;
  observePiWorkspace(): Observation {
    const snapshot: Snapshot = {
      requestId: "request",
      subscriptionId: "subscription",
      agentId,
      view: { generation, sequence: 0, current: null },
    };
    return {
      subscriptionId: "subscription",
      ready: Promise.resolve(snapshot),
      subscribe: (observer) => {
        this.observer = observer;
        observer.snapshot(snapshot);
        return () => {
          this.observer = null;
        };
      },
      release: async () => {
        this.releases += 1;
        this.observer = null;
      },
    };
  }
  async sendPiWorkspaceReceipt(_agentId: string, incoming: VisualReceipt): Promise<ReceiptResult> {
    this.receipts.push(incoming);
    if (this.failure) throw this.failure;
    if (this.pending) return this.pending;
    return { requestId: "ack", agentId, stateRevision: 2 };
  }
  subscribeConnectionStatus(listener: (status: ConnectionState) => void): () => void {
    this.status = listener;
    listener({ status: "connected" });
    return () => {
      this.status = null;
    };
  }
  event(event: VisualEvent): void {
    if (!this.observer) throw new Error("Observation is not active");
    this.observer.update({
      type: "pi_workspace.update",
      payload: { agentId, subscriptionId: "subscription", event: encodeVisualEvent(event) },
    });
  }
}

function throughGeneratedValidator(event: VisualEvent): VisualEvent {
  const result = validateWSOutboundMessage({
    type: "session",
    message: {
      type: "pi_workspace.update",
      payload: { subscriptionId: "subscription", agentId, event: encodeVisualEvent(event) },
    },
  });
  assert.equal(result.success, true, JSON.stringify(result));
  if (
    !result.success ||
    result.data.type !== "session" ||
    result.data.message.type !== "pi_workspace.update"
  ) {
    throw new Error("Generated validator did not deliver the visual event");
  }
  return decodeVisualEvent(result.data.message.payload.event);
}

test("all JSON action kinds and saved object snapshots cross the shipped generated validator intact", () => {
  for (const value of [null, false, 3.5, "π", { value: 5 }, [1, { nested: ["a", false] }]]) {
    const event: VisualEvent = {
      kind: "command",
      sequence: 1,
      command: { kind: "act", commandId: id, binding: current.binding, action: "set", value },
    };
    assert.deepEqual(throughGeneratedValidator(event), event);
  }
  const restored = {
    ...current,
    document: {
      ...current.document,
      stateRevision: 2,
      snapshot: { state: { values: [1, 2] }, selection: { id: "selected", text: "two" } },
    },
  };
  const snapshot: VisualEvent = {
    kind: "snapshot",
    view: { generation, sequence: 2, current: restored },
  };
  assert.deepEqual(throughGeneratedValidator(snapshot), snapshot);
  const renderEvent: VisualEvent = {
    kind: "command",
    sequence: 3,
    command: { kind: "render", commandId: id, current: restored },
  };
  assert.deepEqual(throughGeneratedValidator(renderEvent), renderEvent);
  const invalid = validateWSOutboundMessage({
    type: "session",
    message: {
      type: "pi_workspace.update",
      payload: {
        subscriptionId: "subscription",
        agentId,
        event: {
          kind: "command",
          sequence: 4,
          command: {
            kind: "act",
            commandId: id,
            binding: current.binding,
            action: "set",
            valueJson: { invalid: "not encoded text" },
          },
        },
      },
    },
  });
  assert.equal(invalid.success, false);
});

test("malformed or excessively deep wire JSON fails at decoding and is visible on the surface", async () => {
  const transport = new Transport();
  const controller = new VisualController(transport, agentId);
  controller.start();
  render(transport);
  const observer = transport.observer;
  if (!observer) throw new Error("Missing observer");
  for (const valueJson of [
    "{broken",
    "[".repeat(30) + "0" + "]".repeat(30),
    JSON.stringify("é".repeat(20000)),
  ]) {
    observer.update({
      type: "pi_workspace.update",
      payload: {
        subscriptionId: "subscription",
        agentId,
        event: {
          kind: "command",
          sequence: 2,
          command: {
            kind: "act",
            commandId: id,
            binding: current.binding,
            action: "set",
            valueJson,
          },
        },
      },
    });
    assert.equal(controller.getSnapshot().status, "error");
    assert.equal(controller.getSnapshot().command, null);
  }
  assert.deepEqual(transport.receipts, []);
  await controller.stop();
});

function render(transport: Transport): void {
  transport.event({
    kind: "command",
    sequence: 1,
    command: { kind: "render", commandId: id, current },
  });
}
function receipt(sequence = 1): VisualReceipt {
  return {
    binding: current.binding,
    commandId: id,
    sequence,
    snapshot: { state: { speed: 12 }, selection: "speed" },
    actions: {},
    error: null,
  };
}

test("owned snapshot, render acknowledgement and local updates keep the document identity stable", async () => {
  const transport = new Transport();
  const controller = new VisualController(transport, agentId);
  controller.start();
  assert.equal(controller.getSnapshot().current, null);
  render(transport);
  assert.equal(controller.getSnapshot().status, "loading");
  const decodedDocument = controller.getSnapshot().current;
  assert.deepEqual(decodedDocument, current);
  controller.receive({ type: "paseo-visual", receipt: receipt() });
  await Promise.resolve();
  assert.equal(controller.getSnapshot().status, "ready");
  assert.equal(controller.getSnapshot().current, decodedDocument);
  controller.receive({ type: "paseo-visual", receipt: { ...receipt(2), commandId: null } });
  await Promise.resolve();
  assert.equal(transport.receipts.length, 2);
  assert.equal(
    controller.getSnapshot().current,
    decodedDocument,
    "Local interaction must not recreate the iframe or restore over its state",
  );
  await controller.stop();
  assert.equal(transport.releases, 1);
  assert.equal(transport.status, null);
});

test("malformed, oversized and cross-document receipts never reach the authenticated transport", async () => {
  const transport = new Transport();
  const controller = new VisualController(transport, agentId);
  controller.start();
  render(transport);
  controller.receive({
    type: "paseo-visual",
    receipt: { ...receipt(), binding: { ...current.binding, nonce: generation } },
  });
  assert.match(controller.getSnapshot().error ?? "", /obsolete document/);
  controller.receive({
    type: "paseo-visual",
    receipt: { ...receipt(), snapshot: { state: undefined, selection: null } },
  });
  assert.equal(controller.getSnapshot().status, "error");
  controller.receive({
    type: "paseo-visual",
    receipt: { ...receipt(), snapshot: { state: "x".repeat(140000), selection: null } },
  });
  assert.equal(controller.getSnapshot().status, "error");
  assert.deepEqual(transport.receipts, []);
  await controller.stop();
});

test("command sequence gaps and old connection generations are visible failures", async () => {
  const transport = new Transport();
  const controller = new VisualController(transport, agentId);
  controller.start();
  transport.event({
    kind: "command",
    sequence: 2,
    command: { kind: "render", commandId: id, current },
  });
  assert.match(controller.getSnapshot().error ?? "", /sequence gap/);
  transport.event({
    kind: "command",
    sequence: 1,
    command: {
      kind: "render",
      commandId: id,
      current: { ...current, binding: { ...current.binding, clientGeneration: nonce } },
    },
  });
  assert.match(controller.getSnapshot().error ?? "", /obsolete app connection/);
  assert.equal(controller.getSnapshot().current, null);
  await controller.stop();
});

test("receipt rejection stays visible; disconnect drops document authority and reconnect accepts a new snapshot", async () => {
  const transport = new Transport();
  const controller = new VisualController(transport, agentId);
  controller.start();
  render(transport);
  transport.failure = new Error("Display receipt rejected");
  controller.receive({ type: "paseo-visual", receipt: receipt() });
  await Promise.resolve();
  assert.equal(controller.getSnapshot().error, "Display receipt rejected");
  transport.status?.({ status: "disconnected", reason: "test" });
  assert.equal(controller.getSnapshot().current, null);
  assert.equal(controller.getSnapshot().status, "disconnected");
  const restored = {
    ...current,
    binding: { ...current.binding, clientGeneration: nonce, nonce: generation },
  };
  transport.event({
    kind: "snapshot",
    view: { generation: nonce, sequence: 0, current: restored },
  });
  assert.deepEqual(controller.getSnapshot().current, restored);
  assert.notEqual(controller.getSnapshot().current?.binding.nonce, current.binding.nonce);
  assert.equal(controller.getSnapshot().status, "loading");
  await controller.stop();
});

test("suspending and reopening a retained surface releases demand and ignores prior-lifetime events", async () => {
  const transport = new Transport();
  const controller = new VisualController(transport, agentId);
  controller.start();
  render(transport);
  const previousObserver = transport.observer;
  if (!previousObserver) throw new Error("Missing first observation");
  await controller.stop();
  assert.equal(transport.releases, 1);
  controller.start();
  const resumed = controller.getSnapshot();
  assert.equal(resumed.current, null);
  previousObserver.update({
    type: "pi_workspace.update",
    payload: {
      agentId,
      subscriptionId: "subscription",
      event: encodeVisualEvent({
        kind: "command",
        sequence: 1,
        command: { kind: "render", commandId: id, current },
      }),
    },
  });
  assert.equal(controller.getSnapshot(), resumed);
  render(transport);
  assert.deepEqual(controller.getSnapshot().current, current);
  await controller.stop();
  assert.equal(transport.releases, 2);
});

test("late acknowledgements after stop cannot restore an obsolete surface", async () => {
  const transport = new Transport();
  let resolveAck: (result: ReceiptResult) => void = () => {
    throw new Error("Not initialized");
  };
  transport.pending = new Promise((resolve) => {
    resolveAck = resolve;
  });
  const controller = new VisualController(transport, agentId);
  controller.start();
  render(transport);
  controller.receive({ type: "paseo-visual", receipt: receipt() });
  await controller.stop();
  const stopped = controller.getSnapshot();
  resolveAck({ requestId: "late", agentId, stateRevision: 2 });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(controller.getSnapshot(), stopped);
});
