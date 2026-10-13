import assert from "node:assert/strict";
import { test } from "vitest";
import type { ConnectionState } from "@getpaseo/client/internal/daemon-client";
import {
  encodeVisualEvent,
  encodeVisualView,
  type VisualClientReceipt,
  type VisualEvent,
} from "@getpaseo/protocol/pi-workspace/rpc-schemas";
import { VisualController, type VisualTransport } from "./controller";

type Observation = ReturnType<VisualTransport["observePiWorkspace"]>;
type Observer = Parameters<Observation["subscribe"]>[0];
type Snapshot = Parameters<Observer["snapshot"]>[0];
type ReceiptAck = Awaited<ReturnType<VisualTransport["sendPiWorkspaceReceipt"]>>;
const agentId = "speech-agent";
const generation = "c5bed943-2cd8-48bd-ab77-8808b6284674";
const utterance = "1a2b3c4d-1c1a-4a8e-9f3c-6f1f6d2f0a01";

class SpeechTransport implements VisualTransport {
  observer: Observer | null = null;
  readonly receipts: VisualClientReceipt[] = [];
  observePiWorkspace(): Observation {
    const snapshot: Snapshot = {
      requestId: "observe",
      subscriptionId: "speech",
      agentId,
      view: encodeVisualView({ generation, sequence: 0, current: null }),
    };
    return {
      subscriptionId: "speech",
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
    return { requestId: "receipt", agentId, stateRevision: this.receipts.length };
  }
  subscribeConnectionStatus(listener: (state: ConnectionState) => void): () => void {
    listener({ status: "connected" });
    return () => undefined;
  }
  emit(event: VisualEvent): void {
    if (!this.observer) throw new Error("Display is not observing");
    this.observer.update({
      type: "pi_workspace.update",
      payload: { subscriptionId: "speech", agentId, event: encodeVisualEvent(event) },
    });
  }
}

test("speech for an observation without a player is reported as an error, never played", async () => {
  const transport = new SpeechTransport();
  const controller = new VisualController(transport, agentId, "electron");
  controller.start();
  try {
    transport.emit({ kind: "speech", speech: { type: "cancel", utterance } });
    assert.match(controller.getSnapshot().error ?? "", /without a player/);
    assert.deepEqual(transport.receipts, []);
  } finally {
    await controller.stop();
  }
});
