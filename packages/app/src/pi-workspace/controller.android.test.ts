import assert from "node:assert/strict";
import { test } from "vitest";
import type { ConnectionState } from "@getpaseo/client/internal/daemon-client";
import type { VisualPlatform } from "@getpaseo/protocol/pi-workspace/contracts";
import {
  encodeVisualEvent,
  type VisualEvent,
  type VisualReceipt,
  type VisualRenderDocument,
} from "@getpaseo/protocol/pi-workspace/rpc-schemas";
import { VisualController, type VisualTransport } from "./controller";

type Observation = ReturnType<VisualTransport["observePiWorkspace"]>;
type Observer = Parameters<Observation["subscribe"]>[0];
type Snapshot = Parameters<Observer["snapshot"]>[0];
type ReceiptResult = Awaited<ReturnType<VisualTransport["sendPiWorkspaceReceipt"]>>;
const agentId = "android-agent";
const generation = "b5bed943-2cd8-48bd-ab77-8808b6284674";
const id = "25afcecf-bc68-4c7f-b408-2640ed2a0026";
const nonce = "7c6c0224-4617-4c5b-bbfe-03c3c330c608";
const inspectId = "4d6c2f0e-6e44-4a53-8f1a-6a5b2c1d9e01";
const current: VisualRenderDocument = {
  binding: { id, revision: 1, nonce, clientGeneration: generation },
  document: {
    id,
    title: "Android controller",
    revision: 1,
    stateRevision: 1,
    html: "<p>document</p>",
    snapshot: { state: null, selection: null },
  },
};

class Transport implements VisualTransport {
  observer: Observer | null = null;
  platforms: (VisualPlatform | undefined)[] = [];
  releases = 0;
  readonly receipts: VisualReceipt[] = [];
  observePiWorkspace(...args: Parameters<VisualTransport["observePiWorkspace"]>): Observation {
    this.platforms.push(args[2]);
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
    return { requestId: "ack", agentId, stateRevision: 1 };
  }
  subscribeConnectionStatus(listener: (status: ConnectionState) => void): () => void {
    listener({ status: "connected" });
    return () => undefined;
  }
  event(event: VisualEvent): void {
    if (!this.observer) throw new Error("Observation is not active");
    this.observer.update({
      type: "pi_workspace.update",
      payload: { agentId, subscriptionId: "subscription", event: encodeVisualEvent(event) },
    });
  }
}

function documentReceipt(): VisualReceipt {
  return {
    binding: current.binding,
    commandId: inspectId,
    sequence: 2,
    stateRevision: 1,
    snapshot: { state: null, selection: null },
    actions: {},
    error: null,
  };
}

function captureReceipt(): VisualReceipt {
  // About 300 KiB of PNG data: larger than ordinary document receipts, within the capture bound.
  const data = "A".repeat(300 * 1024);
  return {
    ...documentReceipt(),
    capture: {
      operationId: inspectId,
      binding: current.binding,
      screenshot: {
        client: generation,
        mimeType: "image/png",
        width: 1080,
        height: 945,
        viewport: { width: 411, height: 360 },
        pixelRatio: 2.625,
        revision: 1,
        stateRevision: 1,
      },
      data,
    },
  };
}

function render(transport: Transport): void {
  transport.event({
    kind: "command",
    sequence: 1,
    command: { kind: "render", commandId: id, current },
  });
}

test("an Android display declares its platform and relays capture-sized receipts that web refuses", async () => {
  const android = new Transport();
  const androidController = new VisualController(android, agentId, "android");
  androidController.start();
  assert.deepEqual(android.platforms, ["android"]);
  render(android);
  androidController.receive({ type: "paseo-visual", receipt: captureReceipt() });
  await Promise.resolve();
  assert.equal(android.receipts.length, 1);
  assert.equal(android.receipts[0]?.capture?.screenshot.client, generation);
  await androidController.stop();

  const web = new Transport();
  const webController = new VisualController(web, agentId, "web");
  webController.start();
  render(web);
  webController.receive({ type: "paseo-visual", receipt: captureReceipt() });
  assert.equal(webController.getSnapshot().status, "error");
  assert.deepEqual(web.receipts, []);
  await webController.stop();
});

test("stopping a backgrounded display drops its binding so the resumed surface never remounts it", async () => {
  const transport = new Transport();
  const controller = new VisualController(transport, agentId, "android");
  controller.start();
  render(transport);
  assert.deepEqual(controller.getSnapshot().current, current);
  await controller.stop();
  assert.equal(transport.releases, 1);
  const stopped = controller.getSnapshot();
  assert.equal(stopped.current, null);
  assert.equal(stopped.command, null);
  assert.equal(stopped.restoration, null);
  assert.equal(stopped.status, "loading");
  controller.receive({ type: "paseo-visual", receipt: { ...documentReceipt(), commandId: null } });
  assert.match(controller.getSnapshot().error ?? "", /obsolete document/);
  assert.deepEqual(transport.receipts, [], "a released binding cannot publish");
  controller.start();
  assert.equal(controller.getSnapshot().current, null);
  render(transport);
  assert.deepEqual(controller.getSnapshot().current, current);
  await controller.stop();
  assert.equal(transport.releases, 2);
});
