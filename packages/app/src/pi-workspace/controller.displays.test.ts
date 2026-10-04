import assert from "node:assert/strict";
import { test } from "vitest";
import type { ConnectionState } from "@getpaseo/client/internal/daemon-client";
import {
  encodeVisualEvent,
  encodeVisualView,
  VisualReceiptSchema,
  type VisualEvent,
  type VisualClientReceipt,
  type VisualReceipt,
  type VisualRenderDocument,
} from "@getpaseo/protocol/pi-workspace/rpc-schemas";
import { VisualController, type VisualTransport } from "./controller";
import { visualStateMessage } from "./document-bridge";

type Observation = ReturnType<VisualTransport["observePiWorkspace"]>;
type Observer = Parameters<Observation["subscribe"]>[0];
type Snapshot = Parameters<Observer["snapshot"]>[0];
type ReceiptAck = Awaited<ReturnType<VisualTransport["sendPiWorkspaceReceipt"]>>;
const agentId = "shared-agent";
const generation = "b5bed943-2cd8-48bd-ab77-8808b6284674";
const id = "25afcecf-bc68-4c7f-b408-2640ed2a0026";
const current: VisualRenderDocument = {
  binding: {
    id,
    revision: 1,
    nonce: "7c6c0224-4617-4c5b-bbfe-03c3c330c608",
    clientGeneration: generation,
  },
  document: {
    id,
    title: "State synchronization",
    revision: 1,
    stateRevision: 1,
    html: "<p>Local pixels remain mounted</p>",
    snapshot: { state: { value: 1 }, selection: null },
  },
};

class StateTransport implements VisualTransport {
  observer: Observer | null = null;
  readonly receipts: VisualClientReceipt[] = [];
  observePiWorkspace(): Observation {
    const snapshot: Snapshot = {
      requestId: "observe",
      subscriptionId: "display",
      agentId,
      view: encodeVisualView({ generation, sequence: 0, current }),
    };
    return {
      subscriptionId: "display",
      ready: Promise.resolve(snapshot),
      subscribe: (observer) => {
        this.observer = observer;
        observer.snapshot(snapshot);
        return () => {
          this.observer = null;
        };
      },
      release: async () => {
        this.observer = null;
      },
    };
  }
  async sendPiWorkspaceReceipt(
    _agentId: string,
    receipt: VisualClientReceipt,
  ): Promise<ReceiptAck> {
    this.receipts.push(receipt);
    return { requestId: "receipt", agentId, stateRevision: 2 };
  }
  subscribeConnectionStatus(listener: (state: ConnectionState) => void): () => void {
    listener({ status: "connected" });
    return () => undefined;
  }
  emit(event: VisualEvent): void {
    if (!this.observer) throw new Error("Display is not observing");
    this.observer.update({
      type: "pi_workspace.update",
      payload: { subscriptionId: "display", agentId, event: encodeVisualEvent(event) },
    });
  }
}

test("stored-state updates preserve the mounted source and binding while delivering restoration separately", async () => {
  const transport = new StateTransport();
  const controller = new VisualController(transport, agentId);
  controller.start();
  try {
    const mounted = controller.getSnapshot().current;
    assert.deepEqual(mounted, current);
    const receipt: VisualReceipt = {
      binding: current.binding,
      commandId: null,
      sequence: 1,
      stateRevision: 1,
      snapshot: current.document.snapshot,
      actions: {},
      error: null,
    };
    controller.receive({ type: "paseo-visual", receipt });
    await Promise.resolve();
    assert.deepEqual(transport.receipts, [receipt]);
    assert.equal(controller.getSnapshot().status, "ready");
    const restored: VisualRenderDocument = {
      binding: current.binding,
      document: {
        ...current.document,
        stateRevision: 3,
        snapshot: { state: { value: 8 }, selection: "other display" },
      },
    };
    transport.emit({ kind: "snapshot", view: { generation, sequence: 1, current: restored } });
    assert.equal(controller.getSnapshot().current, mounted);
    assert.equal(controller.getSnapshot().status, "ready");
    assert.deepEqual(controller.getSnapshot().restoration, restored);
    assert.deepEqual(visualStateMessage(restored), {
      type: "paseo-visual-state",
      binding: current.binding,
      snapshot: restored.document.snapshot,
      stateRevision: 3,
    });
    const beforeOldEvent = controller.getSnapshot();
    transport.emit({ kind: "snapshot", view: { generation, sequence: 0, current } });
    assert.equal(controller.getSnapshot(), beforeOldEvent);
    assert.deepEqual(
      transport.receipts,
      [receipt],
      "Restoring stored state must not manufacture a local publication",
    );
    const replacement = { ...restored, binding: { ...restored.binding, nonce: id } };
    transport.emit({ kind: "snapshot", view: { generation, sequence: 2, current: replacement } });
    assert.deepEqual(controller.getSnapshot().current, replacement);
    assert.equal(controller.getSnapshot().restoration, null);
    assert.equal(controller.getSnapshot().status, "loading");
  } finally {
    await controller.stop();
  }
});

test("only the trusted host channel can publish display activity and it cannot address a replaced document", async () => {
  const transport = new StateTransport();
  const controller = new VisualController(transport, agentId, "electron");
  controller.start();
  try {
    controller.hostEvent({ kind: "activity", binding: current.binding });
    await Promise.resolve();
    assert.deepEqual(transport.receipts, [{ kind: "activity", binding: current.binding }]);
    controller.receive({
      type: "paseo-visual-host",
      event: { kind: "activity", binding: current.binding },
    });
    controller.receive({
      type: "paseo-visual",
      receipt: { kind: "activity", binding: current.binding },
    });
    assert.equal(controller.getSnapshot().status, "error");
    assert.equal(transport.receipts.length, 1);
    controller.hostEvent({
      kind: "visibility",
      binding: { ...current.binding, nonce: id },
      visible: false,
    });
    assert.equal(transport.receipts.length, 1);
    assert.match(controller.getSnapshot().error ?? "", /obsolete visual/);
  } finally {
    await controller.stop();
  }
});

test("publication bases remain optional for V1 parsing but invalid bases never cross the controller boundary", async () => {
  const transport = new StateTransport();
  const controller = new VisualController(transport, agentId);
  const receipt: VisualReceipt = {
    binding: current.binding,
    commandId: null,
    sequence: 1,
    snapshot: current.document.snapshot,
    actions: {},
    error: null,
  };
  assert.deepEqual(VisualReceiptSchema.parse(receipt), receipt);
  controller.start();
  try {
    for (const stateRevision of [0, -1, 1.5, "2", Number.MAX_SAFE_INTEGER + 1]) {
      controller.receive({ type: "paseo-visual", receipt: { ...receipt, stateRevision } });
      assert.equal(controller.getSnapshot().status, "error");
    }
    assert.deepEqual(transport.receipts, []);
  } finally {
    await controller.stop();
  }
});
