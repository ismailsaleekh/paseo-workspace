import {
  VisualCaptureSchema,
  VISUAL_RENDERER_UNAVAILABLE,
  type VisualCapture,
  type VisualError,
  type VisualSnapshot,
} from "@getpaseo/protocol/pi-workspace/contracts";
import {
  AndroidVisualHostEventSchema,
  type AndroidVisualHostEvent,
  type VisualCommand,
  type VisualHostSignal,
  type VisualReceipt,
  type VisualRenderDocument,
} from "@getpaseo/protocol/pi-workspace/rpc-schemas";
import { DocumentMessageSchema, visualDocumentHtml, visualStateMessage } from "./document-bridge";

/** The Paseo Android visual host module. Every call addresses one document session. */
export interface AndroidVisualNative {
  open(session: string, html: string): Promise<void>;
  post(session: string, message: string): Promise<void>;
  capture(session: string, request: string): Promise<void>;
  close(session: string): Promise<void>;
  /** Native embedding state, used to explain a display that never became ready. */
  describe(session: string): Promise<string>;
}

export type AndroidVisualSchedule = (expire: () => void, milliseconds: number) => () => void;
function scheduleTimeout(expire: () => void, milliseconds: number): () => void {
  const timer = setTimeout(expire, milliseconds);
  return () => clearTimeout(timer);
}
/** Under the daemon's 13 s display deadline, so an unready display fails explicitly. */
export const ANDROID_VISUAL_READY_MS = 12_000;

export interface AndroidVisualAdapterInput {
  current: VisualRenderDocument;
  renderCommandId: string | null;
  native: AndroidVisualNative | null;
  receive(value: unknown): void;
  hostEvent?(event: VisualHostSignal): void;
  reportError(error: unknown): void;
  /** The display can no longer show this document; the surface explains why. */
  onFailure(error: VisualError): void;
  schedule?: AndroidVisualSchedule;
}

type DocumentCommand = Exclude<VisualCommand, { kind: "render" }>;
type CaptureEvent = Extract<AndroidVisualHostEvent, { type: "capture" }>;

const MISSING_MODULE = "This Paseo build does not include the Android visual host module";

/**
 * Relays one mounted document between the controller and the companion visual host. It owns the
 * capture binding: a capture is attached only to the inspection receipt of the same live session.
 */
export class AndroidVisualAdapter {
  private lastSequence = 0;
  private lastSnapshot: VisualSnapshot;
  private stateRevision: number;
  private readonly outstanding: string[] = [];
  private readonly captureRequests = new Set<string>();
  private readonly heldCaptures = new Map<string, VisualReceipt>();
  private attached = false;
  private failure: VisualError | null = null;
  private disposed = false;
  private hostEvents = 0;
  private ready = false;
  private cancelReady: (() => void) | null = null;

  constructor(private readonly input: AndroidVisualAdapterInput) {
    this.lastSnapshot = input.current.document.snapshot;
    this.stateRevision = input.current.document.stateRevision;
    if (input.renderCommandId) this.outstanding.push(input.renderCommandId);
  }

  get session(): string {
    return this.input.current.binding.nonce;
  }

  get failed(): VisualError | null {
    return this.failure;
  }

  mount(): void {
    const native = this.input.native;
    if (!native) {
      this.fail(VISUAL_RENDERER_UNAVAILABLE, MISSING_MODULE);
      return;
    }
    const html = visualDocumentHtml({
      current: this.input.current,
      commandId: this.input.renderCommandId,
      platform: "android",
    });
    const schedule = this.input.schedule ?? scheduleTimeout;
    this.cancelReady = schedule(() => this.readyExpired(native), ANDROID_VISUAL_READY_MS);
    native.open(this.session, html).catch((error: unknown) => this.nativeFailure(error));
  }

  private readyExpired(native: AndroidVisualNative): void {
    this.cancelReady = null;
    if (this.ready || this.failure || this.disposed) return;
    const local = `attached=${this.attached} hostEvents=${this.hostEvents}`;
    const explain = (state: string) =>
      this.fail(
        VISUAL_RENDERER_UNAVAILABLE,
        `The visual host did not display the document within ${ANDROID_VISUAL_READY_MS / 1000} s (${local}; native ${state})`.slice(
          0,
          2048,
        ),
      );
    native
      .describe(this.session)
      .then(explain, (error: unknown) =>
        explain(error instanceof Error ? error.message : "state unavailable"),
      );
  }

  private stopReadyDeadline(): void {
    this.ready = true;
    this.cancelReady?.();
    this.cancelReady = null;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancelReady?.();
    this.cancelReady = null;
    this.heldCaptures.clear();
    this.captureRequests.clear();
    const native = this.input.native;
    if (native && this.failure === null)
      native.close(this.session).catch((error: unknown) => this.input.reportError(error));
  }

  command(command: DocumentCommand): void {
    if (this.disposed) return;
    if (this.failure) {
      this.receiveFailure(command.commandId, this.failure);
      return;
    }
    this.outstanding.push(command.commandId);
    if (command.kind === "inspect" && command.screenshot === true)
      this.captureRequests.add(command.commandId);
    this.post(JSON.stringify({ type: "paseo-visual-command", command }));
  }

  restore(restoration: VisualRenderDocument): void {
    if (this.disposed || this.failure) return;
    this.post(JSON.stringify(visualStateMessage(restoration)));
  }

  hostEvent(value: unknown): void {
    if (this.disposed) return;
    const parsed = AndroidVisualHostEventSchema.safeParse(value);
    if (!parsed.success) {
      this.input.reportError(new Error("Android visual host sent an invalid event"));
      return;
    }
    const event = parsed.data;
    // Events of a previous session belong to a replaced document and carry no authority here.
    if (event.session !== this.session) return;
    this.hostEvents += 1;
    switch (event.type) {
      case "attached":
        this.attached = true;
        return;
      case "message":
        this.documentMessage(event.data);
        return;
      case "capture":
        this.captured(event);
        return;
      case "captureFailed":
        this.captureFailed(event.request, event.message);
        return;
      case "error":
        this.fail(event.code, event.message);
        return;
      case "activity":
        if (this.failure === null && this.input.hostEvent)
          this.input.hostEvent({ kind: "activity", binding: this.input.current.binding });
        return;
    }
  }

  private post(message: string): void {
    const native = this.input.native;
    if (!native) {
      this.fail(VISUAL_RENDERER_UNAVAILABLE, MISSING_MODULE);
      return;
    }
    native.post(this.session, message).catch((error: unknown) => this.nativeFailure(error));
  }

  private nativeFailure(error: unknown): void {
    const message = error instanceof Error && error.message ? error.message : "Visual host failed";
    this.fail(VISUAL_RENDERER_UNAVAILABLE, message.slice(0, 2048));
  }

  private documentMessage(data: string): void {
    let value: unknown;
    try {
      value = JSON.parse(data);
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      this.input.reportError(new Error("Visual document sent malformed JSON"));
      return;
    }
    const parsed = DocumentMessageSchema.safeParse(value);
    if (!parsed.success) {
      // The controller rejects it visibly; it never reaches the daemon.
      this.input.receive(value);
      return;
    }
    const receipt = parsed.data.receipt;
    this.stopReadyDeadline();
    this.lastSequence = Math.max(this.lastSequence, receipt.sequence);
    this.lastSnapshot = receipt.snapshot;
    if (receipt.stateRevision !== undefined) this.stateRevision = receipt.stateRevision;
    const commandId = receipt.commandId;
    if (commandId !== null) {
      const index = this.outstanding.indexOf(commandId);
      if (index !== -1) this.outstanding.splice(index, 1);
    }
    if (commandId !== null && this.captureRequests.delete(commandId) && receipt.error === null) {
      this.requestCapture(commandId, receipt);
      return;
    }
    this.input.receive(value);
  }

  private requestCapture(commandId: string, receipt: VisualReceipt): void {
    const native = this.input.native;
    if (!native || !this.attached) {
      this.input.receive({
        type: "paseo-visual",
        receipt: {
          ...receipt,
          error: { code: "CAPTURE_FAILED", message: "The visual surface is not attached" },
        },
      });
      return;
    }
    this.heldCaptures.set(commandId, receipt);
    native.capture(this.session, commandId).catch((error: unknown) => {
      const message = error instanceof Error && error.message ? error.message : "Capture failed";
      this.captureFailed(commandId, message.slice(0, 2048));
    });
  }

  private captured(event: CaptureEvent): void {
    const receipt = this.heldCaptures.get(event.request);
    if (!receipt) {
      this.input.reportError(new Error("Capture result does not match a pending inspection"));
      return;
    }
    this.heldCaptures.delete(event.request);
    // Revalidate after the asynchronous capture: the same live, attached session must still own
    // this binding. A capture of a failed or replaced document never satisfies an inspection.
    if (this.failure || !this.attached || receipt.stateRevision === undefined) {
      this.receiveCaptureFailure(receipt, "The visual changed while it was being captured");
      return;
    }
    const capture: VisualCapture = {
      operationId: event.request,
      binding: receipt.binding,
      screenshot: {
        client: receipt.binding.clientGeneration,
        mimeType: "image/png",
        width: event.width,
        height: event.height,
        viewport: {
          width: Math.max(1, Math.round(event.width / event.density)),
          height: Math.max(1, Math.round(event.height / event.density)),
        },
        pixelRatio: event.density,
        revision: receipt.binding.revision,
        stateRevision: receipt.stateRevision,
      },
      data: event.data,
    };
    const valid = VisualCaptureSchema.safeParse(capture);
    if (!valid.success) {
      this.receiveCaptureFailure(receipt, "Capture exceeds the display capture bounds");
      return;
    }
    this.input.receive({ type: "paseo-visual", receipt: { ...receipt, capture: valid.data } });
  }

  private captureFailed(request: string, message: string): void {
    const receipt = this.heldCaptures.get(request);
    if (!receipt) {
      this.input.reportError(new Error("Capture failure does not match a pending inspection"));
      return;
    }
    this.heldCaptures.delete(request);
    this.receiveCaptureFailure(receipt, message);
  }

  private receiveCaptureFailure(receipt: VisualReceipt, message: string): void {
    this.input.receive({
      type: "paseo-visual",
      receipt: { ...receipt, error: { code: "CAPTURE_FAILED", message } },
    });
  }

  private fail(code: string, message: string): void {
    if (this.failure || this.disposed) return;
    const error: VisualError = { code, message: message || "Visual host failed" };
    this.failure = error;
    this.cancelReady?.();
    this.cancelReady = null;
    this.heldCaptures.clear();
    this.captureRequests.clear();
    // The daemon has at most one operation awaiting this display; the latest command is the one
    // that must observe the failure. Earlier ones were already answered or timed out.
    const commandId = this.outstanding.at(-1) ?? null;
    this.outstanding.length = 0;
    this.receiveFailure(commandId, error);
    this.input.onFailure(error);
  }

  private receiveFailure(commandId: string | null, error: VisualError): void {
    this.lastSequence += 1;
    const receipt: VisualReceipt = {
      binding: this.input.current.binding,
      commandId,
      sequence: this.lastSequence,
      stateRevision: this.stateRevision,
      snapshot: this.lastSnapshot,
      actions: {},
      error,
    };
    this.input.receive({ type: "paseo-visual", receipt });
  }
}
