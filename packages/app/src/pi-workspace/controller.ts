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
import { DocumentMessageSchema } from "./document-bridge";

export type VisualTransport = Pick<
  DaemonClient,
  "observePiWorkspace" | "sendPiWorkspaceReceipt" | "subscribeConnectionStatus"
>;
export interface VisualSurfaceState {
  status: "loading" | "ready" | "error" | "disconnected";
  current: VisualRenderDocument | null;
  restoration: VisualRenderDocument | null;
  renderCommandId: string | null;
  command: Exclude<VisualCommand, { kind: "render" }> | null;
  error: string | null;
}

export class VisualController {
  private state: VisualSurfaceState = {
    status: "loading",
    current: null,
    restoration: null,
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
  ) {}

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
          renderCommandId: null,
          command: null,
          error: "Visual host disconnected; reconnect to restore the saved visual",
        });
      }
    });
    try {
      const observation = this.client.observePiWorkspace(this.agentId, undefined, this.platform);
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

  private acceptSnapshot(view: VisualView): void {
    const current = this.state.current;
    const next = view.current;
    const sameDocument =
      current &&
      next &&
      view.generation === this.generation &&
      current.binding.nonce === next.binding.nonce &&
      current.binding.id === next.binding.id &&
      current.binding.revision === next.binding.revision;
    this.generation = view.generation;
    this.sequence = view.sequence;
    if (sameDocument) {
      this.update({ ...this.state, restoration: next });
      return;
    }
    this.update({
      status: next ? "loading" : "ready",
      current: next,
      restoration: null,
      renderCommandId: null,
      command: null,
      error: null,
    });
  }

  private acceptEvent(event: VisualEvent): void {
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
      this.update({
        status: "loading",
        current: command.current,
        restoration: null,
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
      void this.client.sendPiWorkspaceReceipt(this.agentId, receipt).then(
        () => {
          if (
            lifetime === this.lifetime &&
            this.state.current?.binding.nonce === nonce &&
            receipt.error === null
          ) {
            this.update({ ...this.state, status: "ready", error: null });
          }
          return undefined;
        },
        (error: unknown) => {
          if (lifetime === this.lifetime && this.state.current?.binding.nonce === nonce)
            this.reportError(error);
        },
      );
    } catch (error) {
      this.reportError(error);
    }
  };
}
