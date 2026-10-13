import "@/styles/unistyles";
import React from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test } from "vitest";
import { page, userEvent } from "vitest/browser";
import { ConnectedVisualHost } from "./visual-host";
import { VisualDocument as DesktopVisualDocument } from "./document.electron";
import type { DesktopHostBridge } from "@/desktop/host";
import type {
  DesktopVisualBridge,
  DesktopVisualMount,
  DesktopVisualAddress,
  DesktopVisualBoundsUpdate,
  VisualRenderDocument,
} from "@getpaseo/protocol/pi-workspace/rpc-schemas";
import { RetainedPanelActivity } from "@/components/retained-panel";
import type { VisualTransport } from "./controller";
import type { DaemonClient, ConnectionState } from "@getpaseo/client/internal/daemon-client";
import {
  encodeVisualEvent,
  type VisualClientReceipt,
  type VisualLibraryResult,
  type VisualEvent,
} from "@getpaseo/protocol/pi-workspace/rpc-schemas";

function barrier() {
  let resolve: () => void = () => {
    throw new Error("Barrier not initialized");
  };
  let reject: (error: Error) => void = () => {
    throw new Error("Barrier not initialized");
  };
  const promise = new Promise<void>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
type Observation = ReturnType<VisualTransport["observePiWorkspace"]>;
type Observer = Parameters<Observation["subscribe"]>[0];
class HostPort implements VisualTransport, Pick<DaemonClient, "requestVisualLibrary"> {
  starts = 0;
  releases = 0;
  readonly receipts: VisualClientReceipt[] = [];
  readonly reads: Parameters<DaemonClient["requestVisualLibrary"]>[0][] = [];
  private observer: Observer | null = null;
  private sequence = 0;
  private generation = crypto.randomUUID();
  readonly enteredRelease = barrier();
  private heldRelease: ReturnType<typeof barrier> | null = null;
  holdRelease(): ReturnType<typeof barrier> {
    this.heldRelease = barrier();
    return this.heldRelease;
  }
  observePiWorkspace(): Observation {
    this.starts += 1;
    this.generation = crypto.randomUUID();
    this.sequence = 0;
    const snapshot = {
      requestId: "observe",
      subscriptionId: "owned-display",
      agentId: "agent",
      view: {
        generation: this.generation,
        sequence: 0,
        sessionId: "persisted-pi",
        selectionIntent: 0,
        current: null,
      },
    };
    let registered: Observer | null = null;
    return {
      subscriptionId: "owned-display",
      ready: Promise.resolve(snapshot),
      subscribe: (observer) => {
        registered = observer;
        this.observer = observer;
        observer.snapshot(snapshot);
        return () => {
          if (this.observer === observer) this.observer = null;
        };
      },
      release: async () => {
        this.releases += 1;
        if (this.observer === registered) this.observer = null;
        this.enteredRelease.resolve();
        if (this.heldRelease) await this.heldRelease.promise;
      },
    };
  }
  subscribeConnectionStatus(listener: (status: ConnectionState) => void): () => void {
    listener({ status: "connected" });
    return () => {};
  }
  async sendPiWorkspaceReceipt(_agentId: string, receipt: VisualClientReceipt) {
    this.receipts.push(receipt);
    return { requestId: "ack", agentId: "agent", stateRevision: this.receipts.length };
  }
  async requestVisualLibrary(
    input: Parameters<DaemonClient["requestVisualLibrary"]>[0],
  ): Promise<VisualLibraryResult> {
    this.reads.push(input);
    if (input.operation.kind === "list") return { kind: "list", items: [], nextCursor: null };
    if (input.operation.kind !== "visibility")
      throw new Error("Unexpected library operation in mounted host test");
    this.sequence += 1;
    return {
      kind: "view",
      view: {
        generation: this.generation,
        sequence: this.sequence,
        sessionId: "persisted-pi",
        selectionIntent: input.operation.intent,
        current: null,
      },
    };
  }
  error(): void {
    const observer = this.observer;
    if (!observer || !observer.error) throw new Error("Mounted observation has no error listener");
    observer.error(new Error("Reconnect required"));
  }
  event(event: VisualEvent): void {
    if (!this.observer) throw new Error("No mounted observation");
    this.observer.update({
      type: "pi_workspace.update",
      payload: {
        agentId: "agent",
        subscriptionId: "owned-display",
        event: encodeVisualEvent(event),
      },
    });
  }
}
let root: Root;
let container: HTMLDivElement;
let releasesToFinish: ReturnType<typeof barrier>[];
async function settle() {
  await new Promise<void>((done) => requestAnimationFrame(() => done()));
}
function render(port: HostPort, active = true) {
  flushSync(() =>
    root.render(
      <RetainedPanelActivity active={active}>
        <ConnectedVisualHost client={port} agentId="agent">
          <input data-testid="retained-draft" defaultValue="Unchanged draft" />
        </ConnectedVisualHost>
      </RetainedPanelActivity>,
    ),
  );
}
async function open(port: HostPort) {
  render(port);
  await expect.poll(() => port.starts).toBe(1);
  await userEvent.click(page.getByTestId("pi-visuals-toggle"));
  await expect.element(page.getByTestId("pi-visuals-sidebar")).toBeVisible();
}
async function reconnect(port: HostPort) {
  port.error();
  await expect.element(page.getByRole("button", { name: "Reconnect visual" })).toBeVisible();
  await userEvent.click(page.getByRole("button", { name: "Reconnect visual" }));
  await port.enteredRelease.promise;
}
beforeEach(async () => {
  await page.viewport(1000, 850);
  container = document.createElement("div");
  container.style.height = "700px";
  container.style.display = "flex";
  document.body.appendChild(container);
  root = createRoot(container);
  releasesToFinish = [];
});
afterEach(async () => {
  flushSync(() => root.unmount());
  for (const held of releasesToFinish) held.resolve();
  await settle();
  container.remove();
  await page.viewport(1000, 850);
});

for (const boundary of ["unmount", "inactive", "replacement"] as const) {
  test(`Reconnect held in release cannot resurrect the ${boundary} host`, async () => {
    const original = new HostPort();
    await open(original);
    const held = original.holdRelease();
    releasesToFinish.push(held);
    await reconnect(original);
    const readiness = original.receipts.length;
    const libraryReads = original.reads.length;
    const replacement = new HostPort();
    if (boundary === "unmount") flushSync(() => root.render(null));
    else if (boundary === "inactive") render(original, false);
    else {
      render(replacement);
      await expect.poll(() => replacement.starts).toBe(1);
    }
    held.resolve();
    await held.promise;
    await settle();
    expect(original.starts).toBe(1);
    expect(original.receipts).toHaveLength(readiness);
    expect(original.reads).toHaveLength(libraryReads);
    if (boundary === "replacement") expect(replacement.starts).toBe(1);
  });
}

test("an ordinary active Reconnect resumes through the mounted effect after release", async () => {
  const port = new HostPort();
  await open(port);
  const held = port.holdRelease();
  releasesToFinish.push(held);
  await reconnect(port);
  expect(port.starts).toBe(1);
  held.resolve();
  await expect.poll(() => port.starts).toBe(2);
  await expect
    .element(page.getByRole("button", { name: "Reconnect visual" }))
    .not.toBeInTheDocument();
});

test("release refusal is an explicit lifecycle error, never a successful teardown or fresh observation", async () => {
  const port = new HostPort();
  await open(port);
  const held = port.holdRelease();
  await reconnect(port);
  held.reject(new Error("Physical source release refused"));
  await expect.element(page.getByText("Physical source release refused").first()).toBeVisible();
  expect(port.starts).toBe(1);
});

function rendererLifetimeDocument(): VisualRenderDocument {
  const id = crypto.randomUUID();
  const nonce = crypto.randomUUID();
  return {
    binding: { id, nonce, revision: 1, clientGeneration: crypto.randomUUID() },
    document: {
      id,
      title: "Renderer lifetime",
      revision: 1,
      stateRevision: 2,
      html: "<p>Saved drawing</p>",
      snapshot: { state: { value: 7 }, selection: null },
    },
  };
}

class DesktopMountPort implements DesktopVisualBridge {
  readonly current = rendererLifetimeDocument();
  readonly errors: unknown[] = [];
  readonly reportError = (error: unknown): void => {
    this.errors.push(error);
  };
  readonly firstNativeMount = barrier();
  readonly secondNativeMount = barrier();
  readonly firstReply = barrier();
  readonly mounts: DesktopVisualMount[] = [];
  readonly disposals: DesktopVisualAddress[] = [];
  readonly boundOwners: string[] = [];
  readonly snapshots = new Map<string, VisualRenderDocument>();
  active: "A" | "B" | null = null;
  unsubscribed = 0;
  private readonly listeners = new Set<(value: unknown) => void>();
  readonly desktop: Pick<DesktopHostBridge, "visuals" | "events"> = {
    visuals: this,
    events: {
      on: (event, listener) => {
        if (event !== "visual") throw new Error("Unexpected desktop event channel");
        this.listeners.add(listener);
        return () => {
          this.listeners.delete(listener);
          this.unsubscribed += 1;
        };
      },
    },
  };
  async mount(input: DesktopVisualMount): Promise<void> {
    this.mounts.push(input);
    if (this.mounts.length === 1) {
      this.active = "A";
      this.snapshots.set("A", input.current);
      this.firstNativeMount.resolve();
      // Native A succeeded; only its RPC reply is delayed, not its actual creation.
      await this.firstReply.promise;
      return;
    }
    if (this.mounts.length !== 2) throw new Error("Unexpected extra native mount");
    this.active = "B";
    this.snapshots.set("B", input.current);
    this.secondNativeMount.resolve();
  }
  async dispose(input: DesktopVisualAddress): Promise<void> {
    this.disposals.push(input);
    this.active = null;
  }
  async bounds(input: DesktopVisualBoundsUpdate): Promise<void> {
    if (!this.active) throw new Error("Bounds published after disposal");
    expect(input.nonce).toBe(this.mounts[1]?.current.binding.nonce);
    this.boundOwners.push(this.active);
  }
  async command(): Promise<void> {
    throw new Error("Mount-lifetime test did not request a command");
  }
  async restore(): Promise<void> {
    throw new Error("Mount-lifetime test did not request restoration");
  }
  async acknowledge(): Promise<void> {
    throw new Error("Mount-lifetime test did not publish a receipt");
  }
}
const noDocumentMessage = (_value: unknown) => {
  throw new Error("Unexpected generated-document message");
};

test("late successful A renderer mount reply cannot dispose same-nonce B after A effect cleanup", async () => {
  const port = new DesktopMountPort();
  releasesToFinish.push(port.firstReply);
  const errors = port.errors;
  const reportError = port.reportError;
  const current = port.current;
  const nonce = current.binding.nonce;
  flushSync(() =>
    root.render(
      <DesktopVisualDocument
        key="A"
        current={current}
        desktop={port.desktop}
        renderCommandId={null}
        command={null}
        receive={noDocumentMessage}
        reportError={reportError}
      />,
    ),
  );
  await port.firstNativeMount.promise;
  expect(port.active).toBe("A");
  expect(port.disposals).toEqual([]);
  // React cleanup sends A's one cancellation before the replacement effect requests B.
  flushSync(() =>
    root.render(
      <DesktopVisualDocument
        key="B"
        current={current}
        desktop={port.desktop}
        renderCommandId={null}
        command={null}
        receive={noDocumentMessage}
        reportError={reportError}
      />,
    ),
  );
  await port.secondNativeMount.promise;
  expect(port.disposals).toEqual([{ nonce }]);
  expect(port.active).toBe("B");
  expect(port.unsubscribed).toBe(1);
  port.firstReply.resolve();
  await port.firstReply.promise;
  await settle();
  expect(port.disposals).toEqual([{ nonce }]);
  expect(port.active).toBe("B");
  expect(port.mounts).toHaveLength(2);
  expect(port.snapshots.get("B")).toEqual(current);
  expect(port.boundOwners.length).toBeGreaterThan(0);
  expect(port.boundOwners.every((owner) => owner === "B")).toBe(true);
  expect(errors).toEqual([]);
  await expect.element(page.getByTestId("pi-workspace-document")).toBeVisible();
  flushSync(() => root.render(null));
  await settle();
  expect(port.disposals).toEqual([{ nonce }, { nonce }]);
  expect(port.active).toBe(null);
  expect(port.unsubscribed).toBe(2);
});
