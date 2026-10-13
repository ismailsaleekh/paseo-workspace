import { expect, test } from "vitest";
import { appendLibraryPage, appendVersionPage, visualHistoryLabel } from "./library";
import { VisualController, type VisualTransport } from "./controller";
import {
  encodeVisualView,
  type VisualLibraryOperation,
  type VisualLibraryResult,
  type VisualRenderDocument,
} from "@getpaseo/protocol/pi-workspace/rpc-schemas";
import type { DaemonClient, ConnectionState } from "@getpaseo/client/internal/daemon-client";

test("drawing and version pages accumulate beyond fifty without duplicates or source/state conflation", () => {
  const drawings = Array.from({ length: 103 }, (_, index) => ({
    id: String(index),
    title: `Drawing ${index}`,
    revision: 1,
  }));
  let items = appendLibraryPage([], { items: drawings.slice(0, 50), nextCursor: "49" });
  items = appendLibraryPage(items, { items: drawings.slice(50, 100), nextCursor: "99" });
  items = appendLibraryPage(items, { items: drawings.slice(100), nextCursor: null });
  expect(items).toEqual(drawings);
  const updated = appendLibraryPage(items, {
    items: [{ id: "2", title: "New source", revision: 3 }],
    nextCursor: null,
  });
  expect(updated).toHaveLength(103);
  expect(
    appendLibraryPage(updated, {
      items: [{ id: "2", title: "Obsolete source", revision: 1 }],
      nextCursor: null,
    }).find((item) => item.id === "2"),
  ).toEqual({ id: "2", title: "New source", revision: 3 });
  const versions = Array.from({ length: 56 }, (_, index) => ({ revision: 56 - index }));
  expect(
    appendVersionPage(versions.slice(0, 50), { items: versions.slice(50), nextCursor: null }),
  ).toEqual(versions);
  expect(appendVersionPage(versions, { items: [{ revision: 56 }], nextCursor: null })).toEqual(
    versions,
  );
});
type LibraryObservation = ReturnType<VisualTransport["observePiWorkspace"]>;
type LibraryObserver = Parameters<LibraryObservation["subscribe"]>[0];
interface PendingLibraryRead {
  operation: VisualLibraryOperation;
  finish(result: VisualLibraryResult): void;
}
const generation = "896f72f2-9d58-47e9-a4da-bc1dabd77264";
const drawingId = "120b2804-6c5b-4a95-9f26-6e5ef6f40c79";
const otherId = "7b50e1c5-a5c4-4ae3-82d4-bb1e414307ca";
function drawing(id: string, revision: number, nonce = id): VisualRenderDocument {
  return {
    binding: { id, revision, nonce, clientGeneration: generation },
    document: {
      id,
      title: id,
      revision,
      stateRevision: 1,
      html: "<p>Drawing</p>",
      snapshot: { state: null, selection: null },
    },
  };
}
class LibraryPort implements VisualTransport, Pick<DaemonClient, "requestVisualLibrary"> {
  private observer: LibraryObserver | null = null;
  private readonly pending: PendingLibraryRead[] = [];
  private waiting: ((request: PendingLibraryRead) => void) | null = null;
  observePiWorkspace(): LibraryObservation {
    const snapshot = {
      requestId: "initial",
      subscriptionId: "display",
      agentId: "agent",
      view: encodeVisualView({
        generation,
        sequence: 0,
        sessionId: "persisted",
        selectionIntent: 0,
        current: drawing(drawingId, 1),
      }),
    };
    return {
      subscriptionId: "display",
      ready: Promise.resolve(snapshot),
      subscribe: (observer) => {
        this.observer = observer;
        observer.snapshot(snapshot);
        return () => {};
      },
      release: async () => {
        this.observer = null;
      },
    };
  }
  async sendPiWorkspaceReceipt(): Promise<{
    requestId: string;
    agentId: string;
    stateRevision: number;
  }> {
    throw new Error("Library reads must not manufacture document receipts");
  }
  subscribeConnectionStatus(listener: (state: ConnectionState) => void): () => void {
    listener({ status: "connected" });
    return () => {};
  }
  requestVisualLibrary(
    input: Parameters<DaemonClient["requestVisualLibrary"]>[0],
  ): Promise<VisualLibraryResult> {
    expect(input).toMatchObject({ agentId: "agent", clientGeneration: generation });
    return new Promise((resolve) => {
      const request = { operation: input.operation, finish: resolve };
      if (this.waiting) {
        const done = this.waiting;
        this.waiting = null;
        done(request);
      } else this.pending.push(request);
    });
  }
  take(): PendingLibraryRead {
    const next = this.pending.shift();
    if (!next) throw new Error("No actual library request");
    return next;
  }
  next(): Promise<PendingLibraryRead> {
    const request = this.pending.shift();
    if (request) return Promise.resolve(request);
    if (this.waiting) throw new Error("Already waiting for a library request");
    return new Promise((resolve) => {
      this.waiting = resolve;
    });
  }
  snapshot(current: VisualRenderDocument, sequence: number, selectionIntent = 0): void {
    if (!this.observer) throw new Error("No observation");
    this.observer.update({
      type: "pi_workspace.update",
      payload: {
        agentId: "agent",
        subscriptionId: "display",
        event: {
          kind: "snapshot",
          view: encodeVisualView({
            generation,
            sequence,
            sessionId: "persisted",
            selectionIntent,
            current,
          }),
        },
      },
    });
  }
}

test("overlapping library reads cannot downgrade snapshots, overwrite paging, or undo a newer selection/version intent", async () => {
  const port = new LibraryPort();
  const controller = new VisualController(port, "agent", "web", port);
  controller.start();
  const automatic = port.take();
  const first = controller.refreshLibrary();
  const firstRead = port.take();
  firstRead.finish({
    kind: "list",
    items: [{ id: drawingId, title: drawingId, revision: 2 }],
    nextCursor: drawingId,
  });
  await first;
  automatic.finish({ kind: "list", items: [], nextCursor: null });
  const page = controller.refreshLibrary(true);
  const pageRead = port.take();
  port.snapshot(drawing(drawingId, 5), 1);
  pageRead.finish({
    kind: "list",
    items: [{ id: drawingId, title: "Stale", revision: 3 }],
    nextCursor: otherId,
  });
  await page;
  expect(controller.getLibrarySnapshot().items).toEqual([
    { id: drawingId, title: drawingId, revision: 5 },
  ]);
  expect(controller.getLibrarySnapshot().nextCursor).toBe(otherId);

  const oldPage = controller.refreshLibrary(true);
  const oldPageRead = port.take();
  const oldVersions = controller.loadVersions(drawingId);
  const oldVersionsRead = port.take();
  const oldSelection = controller.selectVisual(drawingId, 1);
  const oldSelectionRead = port.take();
  const chosen = controller.selectVisual(otherId);
  const chosenRead = port.take();
  expect(oldSelectionRead.operation).toMatchObject({ kind: "select", intent: 1 });
  expect(chosenRead.operation).toMatchObject({ kind: "select", intent: 2 });
  chosenRead.finish({
    kind: "view",
    view: encodeVisualView({
      generation,
      sequence: 2,
      sessionId: "persisted",
      selectionIntent: 2,
      current: drawing(otherId, 8),
    }),
  });
  await chosen;
  const selectionRefresh = port.take();
  const versions = controller.loadVersions(otherId);
  const versionsRead = port.take();
  versionsRead.finish({
    kind: "versions",
    items: [{ revision: 8 }, { revision: 6 }],
    nextCursor: 6,
  });
  await versions;
  oldPageRead.finish({
    kind: "list",
    items: [{ id: "obsolete-page", title: "Obsolete", revision: 100 }],
    nextCursor: null,
  });
  oldVersionsRead.finish({ kind: "versions", items: [{ revision: 99 }], nextCursor: 99 });
  oldSelectionRead.finish({
    kind: "view",
    view: encodeVisualView({
      generation,
      sequence: 3,
      sessionId: "persisted",
      selectionIntent: 1,
      current: drawing(drawingId, 1),
    }),
  });
  selectionRefresh.finish({ kind: "list", items: [], nextCursor: null });
  await Promise.all([oldPage, oldVersions, oldSelection]);
  port.snapshot(drawing(drawingId, 1), 4, 1);
  expect(controller.getSnapshot().current?.document.id).toBe(otherId);
  expect(controller.getLibrarySnapshot()).toMatchObject({
    nextCursor: otherId,
    versionsId: otherId,
    versions: [{ revision: 8 }, { revision: 6 }],
    versionsCursor: 6,
  });
  expect(controller.getLibrarySnapshot().items.some((item) => item.id === "obsolete-page")).toBe(
    false,
  );
  await controller.stop();
});

test("server snapshots preceding UI replies do not supersede opening or selection intent", async () => {
  const port = new LibraryPort();
  const controller = new VisualController(port, "agent", "web", port);
  controller.start();
  const initial = port.take();
  const opening = controller.setLibraryVisible(true);
  const visibility = port.take();
  expect(visibility.operation).toMatchObject({ kind: "visibility", visible: true, intent: 1 });
  const displayed = drawing(drawingId, 1, otherId);
  // Production restores the bound view on its observation before returning the visibility RPC.
  port.snapshot(displayed, 1, 1);
  const automaticOpeningRead = port.take();
  expect(automaticOpeningRead.operation).toEqual({ kind: "list" });
  visibility.finish({
    kind: "view",
    view: encodeVisualView({
      generation,
      sequence: 1,
      sessionId: "persisted",
      selectionIntent: 1,
      current: displayed,
    }),
  });
  const openedList = await port.next();
  expect(openedList.operation).toEqual({ kind: "list" });
  openedList.finish({
    kind: "list",
    items: [{ id: drawingId, title: drawingId, revision: 1 }],
    nextCursor: drawingId,
  });
  await opening;
  expect(controller.getLibrarySnapshot()).toMatchObject({
    visible: true,
    status: "ready",
    nextCursor: drawingId,
  });
  automaticOpeningRead.finish({ kind: "list", items: [], nextCursor: null });
  initial.finish({ kind: "list", items: [], nextCursor: null });

  const selecting = controller.selectVisual(otherId);
  const selection = port.take();
  expect(selection.operation).toMatchObject({ kind: "select", id: otherId, intent: 2 });
  // Every production selection gets a fresh document nonce, including when changing artifact ids.
  const chosen = drawing(otherId, 5, generation);
  port.snapshot(chosen, 2, 2);
  const automaticSelectionRead = port.take();
  selection.finish({
    kind: "view",
    view: encodeVisualView({
      generation,
      sequence: 2,
      sessionId: "persisted",
      selectionIntent: 2,
      current: chosen,
    }),
  });
  await selecting;
  expect(controller.getSnapshot().current?.document).toEqual(chosen.document);
  expect(controller.getLibrarySnapshot()).toMatchObject({
    visible: true,
    status: "ready",
    versionsId: null,
  });
  const versions = controller.loadVersions(otherId);
  const versionRead = port.take();
  versionRead.finish({ kind: "versions", items: [{ revision: 5 }], nextCursor: null });
  await versions;
  automaticSelectionRead.finish({
    kind: "list",
    items: [{ id: otherId, title: "Stale", revision: 2 }],
    nextCursor: null,
  });
  const closing = controller.setLibraryVisible(false);
  const close = port.take();
  close.finish({
    kind: "view",
    view: encodeVisualView({
      generation,
      sequence: 2,
      sessionId: "persisted",
      selectionIntent: 3,
      current: chosen,
    }),
  });
  await closing;
  expect(controller.getLibrarySnapshot()).toMatchObject({
    visible: false,
    status: "ready",
    versionsId: otherId,
    versions: [{ revision: 5 }],
    nextCursor: drawingId,
  });
  expect(controller.getLibrarySnapshot().items.find((item) => item.id === otherId)?.revision).toBe(
    5,
  );
  await controller.stop();
});

test("legacy history explicitly describes absent snapshots instead of promising saved choices", () => {
  const document = {
    id: "id",
    title: "Drawing",
    html: "<p>Drawing</p>",
    revision: 1,
    stateRevision: 1,
    snapshot: { state: null, selection: null },
  };
  expect(visualHistoryLabel(document)).toBe(null);
  expect(visualHistoryLabel({ ...document, historyState: "initial" })).toBe(
    "Version 1 · No archived choices; initial view",
  );
  expect(visualHistoryLabel({ ...document, historyState: "archived" })).toBe(
    "Version 1 · Archived choices",
  );
});
