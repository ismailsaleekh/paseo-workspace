import { appendLibraryPage, appendVersionPage } from "./library";
import type {
  VisualLibraryPage,
  VisualVersionsPage,
} from "@getpaseo/protocol/pi-workspace/contracts";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import {
  assertVisualJsonBound,
  VISUAL_CAPTURE_PLATFORMS,
  VISUAL_FRAME_BYTES,
  type VisualPlatform,
} from "@getpaseo/protocol/pi-workspace/contracts";
import {
  decodeVisualEvent,
  decodeVisualView,
  VisualHostSignalSchema,
  type VisualHostSignal,
  type VisualCommand,
  type VisualEvent,
  type VisualRenderDocument,
  type VisualView,
} from "@getpaseo/protocol/pi-workspace/rpc-schemas";
import { DocumentMessageSchema, type VisualAcknowledgement } from "./document-bridge";

export type VisualTransport = Pick<
  DaemonClient,
  "observePiWorkspace" | "sendPiWorkspaceReceipt" | "subscribeConnectionStatus"
>;
export interface VisualSurfaceState {
  status: "loading" | "ready" | "error" | "disconnected";
  current: VisualRenderDocument | null;
  restoration: VisualRenderDocument | null;
  /** The latest answer to the current document's awaited receipt (see `visualDocumentHtml`). */
  acknowledgement: VisualAcknowledgement | null;
  renderCommandId: string | null;
  command: Exclude<VisualCommand, { kind: "render" }> | null;
  error: string | null;
}

export interface VisualLibraryState {
  visible: boolean;
  status: "idle" | "loading" | "ready" | "error";
  items: VisualLibraryPage["items"];
  nextCursor: string | null;
  versions: VisualVersionsPage["items"];
  versionsId: string | null;
  versionsCursor: number | null;
  error: string | null;
}

export class VisualController {
  private libraryState: VisualLibraryState = {
    visible: false,
    status: "idle",
    items: [],
    nextCursor: null,
    versions: [],
    versionsId: null,
    versionsCursor: null,
    error: null,
  };
  private libraryRequest = 0;
  private libraryListRequest = 0;
  private selectionIntent = 0;
  private sessionId: string | null = null;
  getLibrarySnapshot = (): VisualLibraryState => this.libraryState;
  private updateLibrary(state: VisualLibraryState): void {
    this.libraryState = state;
    for (const listener of this.listeners) listener();
  }
  private state: VisualSurfaceState = {
    status: "loading",
    current: null,
    restoration: null,
    acknowledgement: null,
    renderCommandId: null,
    command: null,
    error: null,
  };
  private readonly listeners = new Set<() => void>();
  private observation: ReturnType<VisualTransport["observePiWorkspace"]> | null = null;
  private disconnectStatus: (() => void) | null = null;
  private generation: string | null = null;
  private sequence = 0;
  private lifetime = 0;
  private stopping: Promise<void> = Promise.resolve();

  constructor(
    private readonly client: VisualTransport,
    private readonly agentId: string,
    private readonly platform: VisualPlatform = "web",
    private readonly library: Pick<DaemonClient, "requestVisualLibrary"> | null = null,
  ) {}

  private async libraryOperation(
    operation: Parameters<DaemonClient["requestVisualLibrary"]>[0]["operation"],
  ): Promise<Awaited<ReturnType<DaemonClient["requestVisualLibrary"]>>> {
    if (!this.library || !this.generation)
      throw new Error("Reconnect the host to browse this conversation's drawings");
    const generation = this.generation;
    const sessionId = this.sessionId;
    const result = await this.library.requestVisualLibrary({
      agentId: this.agentId,
      clientGeneration: generation,
      operation,
    });
    if (generation !== this.generation || sessionId !== this.sessionId)
      throw new Error("Library conversation changed; retry after reconnecting");
    return result;
  }

  private async runLibrary(operation: (isCurrent: () => boolean) => Promise<void>): Promise<void> {
    const request = ++this.libraryRequest;
    this.updateLibrary({ ...this.libraryState, status: "loading", error: null });
    try {
      await operation(() => request === this.libraryRequest);
      if (request === this.libraryRequest)
        this.updateLibrary({ ...this.libraryState, status: "ready", error: null });
    } catch (error) {
      if (request === this.libraryRequest)
        this.updateLibrary({
          ...this.libraryState,
          status: "error",
          error: error instanceof Error ? error.message : "Library operation failed",
        });
    }
  }

  refreshLibrary = (more = false): Promise<void> =>
    this.runLibrary(async (isCurrent) => {
      const listRequest = ++this.libraryListRequest;
      const cursor = more ? this.libraryState.nextCursor : null;
      const result = await this.libraryOperation({
        kind: "list",
        ...(cursor === null ? {} : { cursor }),
      });
      if (!isCurrent() || listRequest !== this.libraryListRequest) return;
      if (result.kind !== "list") throw new Error("Host returned the wrong library result");
      this.updateLibrary({
        ...this.libraryState,
        items: appendLibraryPage(this.libraryState.items, result),
        nextCursor: result.nextCursor,
      });
    });

  private refreshLibraryFromObservation(): void {
    const listRequest = ++this.libraryListRequest;
    const operatorRequest = this.libraryRequest;
    const current = () =>
      listRequest === this.libraryListRequest && operatorRequest === this.libraryRequest;
    // A server snapshot can arrive before its UI RPC reply. This read must not supersede that choice.
    void this.libraryOperation({ kind: "list" })
      .then((result) => {
        if (!current()) return undefined;
        if (result.kind !== "list") throw new Error("Host returned the wrong library result");
        this.updateLibrary({
          ...this.libraryState,
          items: appendLibraryPage(this.libraryState.items, result),
          nextCursor: result.nextCursor,
        });
        return undefined;
      })
      .catch((error: unknown) => {
        if (!current()) return;
        this.updateLibrary({
          ...this.libraryState,
          status: "error",
          error: error instanceof Error ? error.message : "Library refresh failed",
        });
      });
  }

  loadVersions = (id: string, more = false): Promise<void> =>
    this.runLibrary(async (isCurrent) => {
      const cursor =
        more && this.libraryState.versionsId === id ? this.libraryState.versionsCursor : null;
      const result = await this.libraryOperation({
        kind: "versions",
        id,
        ...(cursor === null ? {} : { cursor }),
      });
      if (!isCurrent()) return;
      if (result.kind !== "versions") throw new Error("Host returned the wrong version result");
      this.updateLibrary({
        ...this.libraryState,
        versionsId: id,
        versions: appendVersionPage(more ? this.libraryState.versions : [], result),
        versionsCursor: result.nextCursor,
      });
    });

  selectVisual = (id: string, revision: number | null = null): Promise<void> =>
    this.runLibrary(async (isCurrent) => {
      const intent = ++this.selectionIntent;
      const result = await this.libraryOperation({ kind: "select", id, revision, intent });
      if (!isCurrent()) return;
      if (result.kind !== "view") throw new Error("Host returned the wrong selection result");
      this.updateLibrary({
        ...this.libraryState,
        versions: [],
        versionsId: null,
        versionsCursor: null,
      });
      this.acceptSnapshot(decodeVisualView(result.view));
    });

  setLibraryVisible = (visible: boolean): Promise<void> =>
    this.runLibrary(async (isCurrent) => {
      const intent = ++this.selectionIntent;
      const result = await this.libraryOperation({ kind: "visibility", visible, intent });
      if (!isCurrent()) return;
      if (result.kind !== "view") throw new Error("Host returned the wrong visibility result");
      this.updateLibrary({ ...this.libraryState, visible });
      this.acceptSnapshot(decodeVisualView(result.view));
      if (visible) await this.refreshLibrary();
    });

  getSnapshot = (): VisualSurfaceState => this.state;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private update(state: VisualSurfaceState): void {
    this.state = state;
    for (const listener of this.listeners) listener();
  }

  reportError(error: unknown): void {
    const message = error instanceof Error ? error.message : "Visual surface failed";
    this.update({ ...this.state, status: "error", error: message });
  }

  start(): void {
    if (this.observation) throw new Error("Visual observation already started");
    const lifetime = ++this.lifetime;
    this.disconnectStatus = this.client.subscribeConnectionStatus((status) => {
      if (lifetime !== this.lifetime) return;
      if (status.status === "disconnected" || status.status === "disposed") {
        this.generation = null;
        this.update({
          status: "disconnected",
          current: null,
          restoration: null,
          acknowledgement: null,
          renderCommandId: null,
          command: null,
          error: "Visual host disconnected; reconnect to restore the saved visual",
        });
      }
    });
    try {
      const observation = this.client.observePiWorkspace(
        this.agentId,
        undefined,
        this.platform,
        this.library !== null,
      );
      this.observation = observation;
      observation.subscribe({
        snapshot: (snapshot) => {
          if (lifetime !== this.lifetime) return;
          try {
            this.acceptSnapshot(decodeVisualView(snapshot.view));
          } catch (error) {
            this.reportError(error);
          }
        },
        update: (message) => {
          if (
            lifetime !== this.lifetime ||
            message.type !== "pi_workspace.update" ||
            message.payload.agentId !== this.agentId
          )
            return;
          try {
            this.acceptEvent(decodeVisualEvent(message.payload.event));
          } catch (error) {
            this.reportError(error);
          }
        },
        error: (error) => {
          if (lifetime === this.lifetime) this.reportError(error);
        },
      });
    } catch (error) {
      this.reportError(error);
    }
  }

  async stop(): Promise<void> {
    this.lifetime += 1;
    this.libraryRequest += 1;
    this.disconnectStatus?.();
    this.disconnectStatus = null;
    const observation = this.observation;
    this.observation = null;
    this.generation = null;
    // A released observation no longer owns a display; never remount its obsolete binding when
    // the surface resumes before the next snapshot arrives.
    if (this.state.current || this.state.command || this.state.restoration) {
      this.update({
        status: "loading",
        current: null,
        restoration: null,
        acknowledgement: null,
        renderCommandId: null,
        command: null,
        error: null,
      });
    }
    this.stopping = this.stopping.then(async () => {
      if (observation) await observation.release();
      return undefined;
    });
    await this.stopping;
  }

  private obsoleteSnapshot(view: VisualView): boolean {
    if (this.generation === view.generation && view.sequence < this.sequence) return true;
    if (
      this.library &&
      this.generation === view.generation &&
      view.selectionIntent !== undefined &&
      view.selectionIntent < this.selectionIntent
    ) {
      // Consume the authenticated observation sequence without reviving an obsolete UI choice.
      this.sequence = Math.max(this.sequence, view.sequence);
      return true;
    }
    return false;
  }

  private acceptLibrarySnapshot(view: VisualView): boolean {
    if (!this.library) return false;
    const changedSession = view.sessionId !== undefined && view.sessionId !== this.sessionId;
    if (changedSession) {
      this.sessionId = view.sessionId ?? null;
      this.libraryRequest += 1;
      this.updateLibrary({
        ...this.libraryState,
        items: [],
        nextCursor: null,
        versions: [],
        versionsId: null,
        versionsCursor: null,
        error: null,
      });
    }
    const next = view.current;
    if (next && next.document.historyState === undefined) {
      const item = {
        id: next.document.id,
        title: next.document.title,
        revision: next.document.revision,
      };
      this.updateLibrary({
        ...this.libraryState,
        items: appendLibraryPage(this.libraryState.items, { items: [item], nextCursor: null }),
      });
    }
    return changedSession;
  }

  private refreshObservedLibrary(
    view: VisualView,
    current: VisualRenderDocument | null,
    freshObservation: boolean,
    changedSession: boolean,
  ): void {
    if (!this.library) return;
    if (freshObservation) {
      if (this.libraryState.visible) void this.setLibraryVisible(true);
      else void this.refreshLibrary();
      return;
    }
    const next = view.current;
    if (changedSession || (next && current?.binding.nonce !== next.binding.nonce))
      this.refreshLibraryFromObservation();
  }

  private acceptSnapshot(view: VisualView): void {
    if (this.obsoleteSnapshot(view)) return;
    const changedSession = this.acceptLibrarySnapshot(view);
    const current = this.state.current;
    const next = view.current;
    const sameDocument =
      current &&
      next &&
      view.generation === this.generation &&
      current.binding.nonce === next.binding.nonce &&
      current.binding.id === next.binding.id &&
      current.binding.revision === next.binding.revision;
    const freshObservation = view.generation !== this.generation;
    this.generation = view.generation;
    this.sequence = view.sequence;
    if (freshObservation) {
      this.selectionIntent = view.selectionIntent ?? 0;
    }
    this.refreshObservedLibrary(view, current, freshObservation, changedSession);
    if (sameDocument) {
      this.update({ ...this.state, restoration: next });
      return;
    }
    this.update({
      status: next ? "loading" : "ready",
      current: next,
      restoration: null,
      acknowledgement: null,
      renderCommandId: null,
      command: null,
      error: null,
    });
  }

  private acceptEvent(event: VisualEvent): void {
    // App speech has its own subscription (speech-connection.ts); a visual observation never plays.
    if (event.kind === "speech")
      throw new Error("Speech arrived for an observation without a player");
    if (event.kind === "snapshot") {
      if (this.generation === event.view.generation && event.view.sequence < this.sequence) return;
      this.acceptSnapshot(event.view);
      return;
    }
    if (event.sequence <= this.sequence) return;
    if (event.sequence !== this.sequence + 1) {
      this.reportError(
        new Error(
          "Visual observation has a sequence gap; reopen the surface to restore a snapshot",
        ),
      );
      return;
    }
    const command = event.command;
    const binding = command.kind === "render" ? command.current.binding : command.binding;
    if (binding.clientGeneration !== this.generation) {
      this.reportError(new Error("Visual command belongs to an obsolete app connection"));
      return;
    }
    this.sequence = event.sequence;
    if (command.kind === "render") {
      if (this.library) this.refreshLibraryFromObservation();
      this.update({
        status: "loading",
        current: command.current,
        restoration: null,
        acknowledgement: null,
        renderCommandId: command.commandId,
        command: null,
        error: null,
      });
    } else {
      const current = this.state.current;
      if (!current || current.binding.nonce !== binding.nonce) {
        this.reportError(new Error("Visual command belongs to a replaced document"));
        return;
      }
      this.update({ ...this.state, command });
    }
  }

  hostEvent = (event: VisualHostSignal): void => {
    try {
      const signal = VisualHostSignalSchema.parse(event);
      const current = this.state.current;
      if (
        !current ||
        signal.binding.clientGeneration !== this.generation ||
        signal.binding.nonce !== current.binding.nonce ||
        signal.binding.id !== current.binding.id ||
        signal.binding.revision !== current.binding.revision
      )
        throw new Error("Rejected host activity from an obsolete visual");
      const lifetime = this.lifetime;
      void this.client.sendPiWorkspaceReceipt(this.agentId, signal).catch((error: unknown) => {
        if (lifetime === this.lifetime) this.reportError(error);
      });
    } catch (error) {
      this.reportError(error);
    }
  };

  receive = (value: unknown): void => {
    try {
      // Receipts carrying an actual-client capture may approach the capture byte bound.
      assertVisualJsonBound(
        value,
        VISUAL_CAPTURE_PLATFORMS.has(this.platform) ? VISUAL_FRAME_BYTES : 128 * 1024,
      );
      const { receipt } = DocumentMessageSchema.parse(value);
      const current = this.state.current;
      if (
        !current ||
        receipt.binding.nonce !== current.binding.nonce ||
        receipt.binding.clientGeneration !== this.generation ||
        receipt.binding.id !== current.binding.id ||
        receipt.binding.revision !== current.binding.revision
      ) {
        throw new Error("Rejected visual receipt from an obsolete document");
      }
      const lifetime = this.lifetime;
      const nonce = current.binding.nonce;
      if (receipt.error) this.reportError(new Error(receipt.error.message));
      // A document waits for the answer to each publication (a state receipt without a command)
      // and each command result before it publishes again, so every outcome of those receipts is
      // acknowledged to the document. The render receipt is not awaited.
      const awaited =
        receipt.error === null &&
        (receipt.commandId === null || receipt.commandId !== this.state.renderCommandId);
      const acknowledge = (stateRevision: number | null): VisualAcknowledgement | null =>
        awaited ? { binding: receipt.binding, sequence: receipt.sequence, stateRevision } : null;
      void this.client.sendPiWorkspaceReceipt(this.agentId, receipt).then(
        (result) => {
          if (lifetime !== this.lifetime || this.state.current?.binding.nonce !== nonce)
            return undefined;
          const acknowledgement = acknowledge(result.stateRevision) ?? this.state.acknowledgement;
          if (receipt.error === null) {
            this.update({ ...this.state, status: "ready", error: null, acknowledgement });
          }
          return undefined;
        },
        (error: unknown) => {
          if (lifetime !== this.lifetime || this.state.current?.binding.nonce !== nonce) return;
          const acknowledgement = acknowledge(null);
          if (acknowledgement) this.update({ ...this.state, acknowledgement });
          this.reportError(error);
        },
      );
    } catch (error) {
      this.reportError(error);
    }
  };
}
