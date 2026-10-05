import { randomUUID } from "node:crypto";
import { createConnection, type Socket } from "node:net";
import {
  VisualFailure,
  VisualLocalResponseSchema,
  VISUAL_FRAME_BYTES,
  VISUAL_OPERATION_TIMEOUT_MS,
  VISUAL_PROTOCOL_VERSION,
  assertVisualJsonBound,
  type VisualLocalRequest,
  type VisualLocalResponse,
  type VisualOperation,
  type VisualResult,
} from "@getpaseo/protocol/pi-workspace/contracts";
import {
  SPEECH_OPERATION_TIMEOUT_MS,
  type SpeechResult,
} from "@getpaseo/protocol/pi-workspace/speech";

export interface VisualAttachmentConfig {
  socketPath: string;
  capability: string;
}
export interface VisualToolConnection {
  request(operation: VisualOperation, signal?: AbortSignal): Promise<VisualResult>;
}
export interface SpeakRequest {
  utterance: string;
  text: string;
}
export interface SpeechToolConnection {
  speak(request: SpeakRequest, signal?: AbortSignal): Promise<SpeechResult>;
}
type ResultFrame = Extract<VisualLocalResponse, { kind: "result" | "speech" }>;
interface PendingRequest {
  resolve(frame: ResultFrame): void;
  reject(error: VisualFailure): void;
  cleanup(): void;
}
interface LiveConnection {
  socket: Socket;
  sessionId: string;
  ready: Promise<void>;
  resolveReady(): void;
  rejectReady(error: VisualFailure): void;
  attached: boolean;
  ended: boolean;
  pending: Map<string, PendingRequest>;
  timer: ReturnType<typeof setTimeout>;
}

/** A lazy connection: session_start never waits for the provider's startup get_state RPC. */
export class VisualConnection implements VisualToolConnection, SpeechToolConnection {
  private live: LiveConnection | null = null;
  private sessionId: string | null = null;

  constructor(private readonly config: VisualAttachmentConfig | null) {}

  bind(sessionId: string): void {
    if (sessionId === this.sessionId) return;
    this.close();
    this.sessionId = sessionId;
  }

  close(): void {
    if (this.live)
      this.fail(this.live, new VisualFailure("DISCONNECTED", "Pi visual attachment was closed"));
    this.sessionId = null;
  }

  private fail(live: LiveConnection, error: VisualFailure): void {
    if (live.ended) return;
    live.ended = true;
    clearTimeout(live.timer);
    live.rejectReady(error);
    for (const pending of live.pending.values()) {
      pending.cleanup();
      pending.reject(error);
    }
    live.pending.clear();
    live.socket.destroy();
    if (this.live === live) this.live = null;
  }

  private connect(): LiveConnection {
    if (this.live) return this.live;
    const config = this.config;
    const sessionId = this.sessionId;
    if (!config || !sessionId)
      throw new VisualFailure(
        "HOST_UNAVAILABLE",
        "This Pi session is not attached to a compatible Paseo host",
      );
    if (!config.socketPath.startsWith("/") || !/^[a-f0-9]{64}$/.test(config.capability)) {
      throw new VisualFailure("HOST_UNAVAILABLE", "Invalid host-supplied Pi visual attachment");
    }
    let resolveReady: () => void = () => {
      throw new Error("Attachment readiness was not initialized");
    };
    let rejectReady: (error: VisualFailure) => void = () => {
      throw new Error("Attachment readiness was not initialized");
    };
    const ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    const socket = createConnection({ path: config.socketPath });
    const live: LiveConnection = {
      socket,
      sessionId,
      ready,
      resolveReady,
      rejectReady,
      attached: false,
      ended: false,
      pending: new Map(),
      timer: setTimeout(
        () =>
          this.fail(live, new VisualFailure("HOST_UNAVAILABLE", "Pi visual attachment timed out")),
        3000,
      ),
    };
    this.live = live;
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let buffered = "";
    socket.on("connect", () => {
      try {
        this.send(live, {
          kind: "attach",
          protocol: VISUAL_PROTOCOL_VERSION,
          capability: config.capability,
          sessionId,
        });
      } catch (error) {
        if (!(error instanceof VisualFailure)) throw error;
        this.fail(live, error);
      }
    });
    socket.on("data", (bytes: Buffer) => {
      try {
        buffered += decoder.decode(bytes, { stream: true });
        let end = buffered.indexOf("\n");
        while (end !== -1) {
          const line = buffered.slice(0, end);
          buffered = buffered.slice(end + 1);
          if (Buffer.byteLength(line, "utf8") > VISUAL_FRAME_BYTES)
            throw new VisualFailure("INVALID_FRAME", "Visual reply exceeds frame limit");
          const value: unknown = JSON.parse(line);
          assertVisualJsonBound(value, VISUAL_FRAME_BYTES);
          const parsed = VisualLocalResponseSchema.safeParse(value);
          if (!parsed.success)
            throw new VisualFailure("INVALID_FRAME", "Host sent an invalid visual reply");
          this.receiveFrame(live, parsed.data);
          end = buffered.indexOf("\n");
        }
        if (Buffer.byteLength(buffered, "utf8") > VISUAL_FRAME_BYTES)
          throw new VisualFailure("INVALID_FRAME", "Visual reply exceeds frame limit");
      } catch (error) {
        if (error instanceof VisualFailure) this.fail(live, error);
        else if (error instanceof SyntaxError || error instanceof TypeError)
          this.fail(live, new VisualFailure("INVALID_FRAME", "Host sent malformed JSON or UTF-8"));
        else throw error;
      }
    });
    socket.on("error", () =>
      this.fail(live, new VisualFailure("DISCONNECTED", "Pi visual host connection failed")),
    );
    socket.on("close", () =>
      this.fail(live, new VisualFailure("DISCONNECTED", "Pi visual host disconnected")),
    );
    return live;
  }

  private receiveFrame(live: LiveConnection, frame: VisualLocalResponse): void {
    if (frame.kind === "attached") {
      if (live.attached || frame.sessionId !== live.sessionId) {
        throw new VisualFailure(
          "INVALID_FRAME",
          "Host attachment identity does not match this Pi session",
        );
      }
      live.attached = true;
      clearTimeout(live.timer);
      live.resolveReady();
      return;
    }
    if (frame.kind === "error" && frame.requestId === null) {
      throw new VisualFailure(frame.error.code, frame.error.message, frame.artifactId);
    }
    if (!live.attached)
      throw new VisualFailure(
        "INVALID_FRAME",
        "Host sent a result before verifying the attachment",
      );
    if (frame.requestId === null)
      throw new VisualFailure("INVALID_FRAME", "Visual reply is missing correlation");
    const pending = live.pending.get(frame.requestId);
    // A cancelled/timed-out request may have an already-in-flight terminal receipt.
    if (!pending) return;
    live.pending.delete(frame.requestId);
    pending.cleanup();
    if (frame.kind === "error")
      pending.reject(new VisualFailure(frame.error.code, frame.error.message, frame.artifactId));
    else pending.resolve(frame);
  }

  private send(live: LiveConnection, frame: VisualLocalRequest): void {
    const line = JSON.stringify(frame) + "\n";
    const size = Buffer.byteLength(line, "utf8");
    if (size > VISUAL_FRAME_BYTES)
      throw new VisualFailure("INVALID_FRAME", "Visual request exceeds frame limit");
    if (live.ended || live.socket.writableLength + size > VISUAL_FRAME_BYTES * 2) {
      throw new VisualFailure("DISCONNECTED", "Visual host connection is closed or backpressured");
    }
    live.socket.write(line);
  }

  async request(operation: VisualOperation, signal?: AbortSignal): Promise<VisualResult> {
    const frame = await this.exchange(
      (requestId) => ({ kind: "request", requestId, operation }),
      VISUAL_OPERATION_TIMEOUT_MS,
      signal,
    );
    if (frame.kind !== "result")
      throw new VisualFailure("INVALID_REPLY", "Host answered a visual request with speech");
    return frame.result;
  }

  /** One utterance; resolves only with the host's terminal playback outcome. */
  async speak(request: SpeakRequest, signal?: AbortSignal): Promise<SpeechResult> {
    const frame = await this.exchange(
      (requestId) => ({
        kind: "speak",
        requestId,
        utterance: request.utterance,
        text: request.text,
      }),
      SPEECH_OPERATION_TIMEOUT_MS,
      signal,
      request.utterance,
    );
    if (frame.kind !== "speech")
      throw new VisualFailure(
        "INVALID_REPLY",
        "Host answered a speech request with a visual result",
        request.utterance,
      );
    return frame.result;
  }

  private async exchange(
    build: (requestId: string) => VisualLocalRequest,
    timeoutMs: number,
    signal: AbortSignal | undefined,
    artifactId: string | null = null,
  ): Promise<ResultFrame> {
    if (signal?.aborted)
      throw new VisualFailure("CANCELLED", "Visual operation was cancelled", artifactId);
    const live = this.connect();
    await live.ready;
    if (signal?.aborted)
      throw new VisualFailure("CANCELLED", "Visual operation was cancelled", artifactId);
    if (live.ended || live !== this.live)
      throw new VisualFailure("DISCONNECTED", "Visual attachment changed", artifactId);
    if (live.pending.size >= 64)
      throw new VisualFailure("BUSY", "Too many pending visual operations", artifactId);
    const requestId = randomUUID();
    return new Promise<ResultFrame>((resolve, reject) => {
      const cancel = (code: "CANCELLED" | "TIMEOUT") => {
        const pending = live.pending.get(requestId);
        if (!pending) return;
        live.pending.delete(requestId);
        pending.cleanup();
        pending.reject(
          new VisualFailure(
            code,
            code === "TIMEOUT"
              ? "Visual operation timed out; inspect before retrying a mutation"
              : "Visual operation was cancelled",
            artifactId,
          ),
        );
        try {
          this.send(live, { kind: "cancel", requestId });
        } catch (error) {
          if (!(error instanceof VisualFailure)) throw error;
          this.fail(live, error);
        }
      };
      const abort = () => cancel("CANCELLED");
      const timer = setTimeout(() => cancel("TIMEOUT"), timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
      };
      live.pending.set(requestId, { resolve, reject, cleanup });
      signal?.addEventListener("abort", abort, { once: true });
      try {
        this.send(live, build(requestId));
      } catch (error) {
        live.pending.delete(requestId);
        cleanup();
        reject(error);
      }
    });
  }
}
