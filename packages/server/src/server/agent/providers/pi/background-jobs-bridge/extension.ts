import { randomUUID } from "node:crypto";
import { createConnection, type Socket } from "node:net";
import {
  BRIDGE_BUFFERED_FRAMES,
  BRIDGE_CALL_TIMEOUT_MS,
  BRIDGE_DISCOVERY_TIMEOUT_MS,
  BRIDGE_ENV_CAPABILITY,
  BRIDGE_ENV_SOCKET,
  BRIDGE_FRAME_BYTES,
  BRIDGE_HANDSHAKE_TIMEOUT_MS,
  BRIDGE_MAX_IN_FLIGHT,
  BRIDGE_PROTOCOL,
  BRIDGE_STARTUP_ACTIVATION_TIMEOUT_MS,
  BridgeFrameError,
  FrameDecoder,
  boundedMessage,
  bridgeCompletion,
  encodeFrame,
  parseDownFrame,
  utf8Length,
  type BridgeDownFrame,
  type BridgeError,
  type BridgeHostPresence,
  type BridgeUpFrame,
} from "./protocol.js";

/**
 * Paseo's private Pi extension for native background jobs.
 *
 * Paseo injects this bundled file only into the Pi runtimes it launches, with a private socket and
 * a one-runtime capability in the environment. It relays the generic pi-background-tasks host-v1
 * EventBus surface to the daemon over that socket. It never prompts, steers, appends entries or
 * sends messages, so UI actions cannot reach the model. Without the injected environment it does
 * nothing, so ordinary terminal Pi is unaffected.
 */

const HOST_REQUEST_CHANNEL = "pi-background-tasks:host:request:v1";
const HOST_RESPONSE_CHANNEL = "pi-background-tasks:host:response:v1";
const HOST_CHANGED_CHANNEL = "pi-background-tasks:host:changed:v1";
const HOST_REQUEST_SCHEMA = "pi-background-tasks.host-request.v1";
const V1_REQUEST_CHANNEL = "pi-background-tasks:request:v1";
const V1_RESPONSE_CHANNEL = "pi-background-tasks:response:v1";
const V1_REQUEST_SCHEMA = "pi-background-tasks.extension-request.v1";

/** Minimal structural view of Pi's extension API; the bridge needs nothing else. */
export interface BridgeEventBus {
  on(channel: string, handler: (data: unknown) => void): unknown;
  emit(channel: string, data: unknown): void;
}
export interface BridgeSessionContext {
  sessionManager: { getSessionId(): string };
}
export interface BridgeExtensionApi {
  events: BridgeEventBus;
  on(
    event: "session_start" | "session_shutdown",
    handler: (event: unknown, ctx: BridgeSessionContext) => void,
  ): void;
}

export interface BridgeConfig {
  socketPath: string;
  capability: string;
}

type HostAnswer = { ok: true; result: unknown } | { ok: false; error: BridgeError };

interface HostLease {
  leaseId: string;
  activationId: string;
  sequence: number;
}

interface LiveConnection {
  socket: Socket;
  sessionId: string;
  attached: boolean;
  ended: boolean;
  runtimeId: string | null;
  lease: HostLease | null;
  pending: Set<string>;
  timer: ReturnType<typeof setTimeout> | null;
}

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readBridgeConfig(
  env: Readonly<Record<string, string | undefined>>,
): BridgeConfig | null {
  const socketPath = env[BRIDGE_ENV_SOCKET];
  const capability = env[BRIDGE_ENV_CAPABILITY];
  if (!socketPath || !capability) return null;
  if (!socketPath.startsWith("/") || !/^[a-f0-9]{64}$/.test(capability)) return null;
  return { socketPath, capability };
}

function readHostError(value: unknown): BridgeError {
  const code = isRecord(value) ? value["code"] : undefined;
  if (isRecord(value) && typeof code === "string")
    return { code: code.slice(0, 64), message: boundedMessage(value["message"]) };
  return { code: "OPERATION_FAILED", message: "Background task host returned a malformed error" };
}

function readString(record: JsonRecord, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value.length > 0 && value.length <= 128 ? value : null;
}

/** One bridge per Pi extension activation. */
export class BackgroundJobsBridge {
  private live: LiveConnection | null = null;
  private lastChange: JsonRecord | null = null;
  private readonly hostWaiters = new Map<string, (answer: HostAnswer) => void>();
  private readonly v1Waiters = new Map<string, () => void>();

  constructor(
    private readonly events: BridgeEventBus,
    private readonly config: BridgeConfig,
    private readonly connect: (socketPath: string) => Socket = (socketPath) =>
      createConnection({ path: socketPath }),
  ) {
    events.on(HOST_CHANGED_CHANNEL, (data) => this.hostChanged(data));
    events.on(HOST_RESPONSE_CHANNEL, (data) => this.hostResponse(data));
    events.on(V1_RESPONSE_CHANNEL, (data) => this.v1Response(data));
  }

  /** Starts the connection asynchronously; session_start never waits for the daemon. */
  start(sessionId: string): void {
    if (this.live && this.live.sessionId === sessionId) return;
    this.close();
    const socket = this.connect(this.config.socketPath);
    const live: LiveConnection = {
      socket,
      sessionId,
      attached: false,
      ended: false,
      runtimeId: null,
      lease: null,
      pending: new Set(),
      timer: null,
    };
    this.live = live;
    live.timer = setTimeout(
      () => this.fail(live),
      BRIDGE_HANDSHAKE_TIMEOUT_MS + BRIDGE_STARTUP_ACTIVATION_TIMEOUT_MS,
    );
    live.timer.unref?.();
    const decoder = new FrameDecoder();
    socket.on("connect", () => {
      this.send(live, {
        kind: "attach",
        protocol: BRIDGE_PROTOCOL,
        capability: this.config.capability,
        sessionId,
      });
    });
    socket.on("data", (bytes: Buffer) => {
      try {
        for (const value of decoder.push(bytes)) this.receive(live, parseDownFrame(value));
      } catch (error) {
        if (!(error instanceof BridgeFrameError)) throw error;
        this.fail(live);
      }
    });
    socket.on("error", () => this.fail(live));
    socket.on("close", () => this.fail(live));
  }

  close(): void {
    if (this.live) this.fail(this.live);
  }

  private fail(live: LiveConnection): void {
    if (live.ended) return;
    live.ended = true;
    if (live.timer) clearTimeout(live.timer);
    live.timer = null;
    live.lease = null;
    live.pending.clear();
    live.socket.destroy();
    if (this.live === live) this.live = null;
  }

  private send(live: LiveConnection, frame: BridgeUpFrame): void {
    if (live.ended) return;
    let line: string;
    try {
      line = encodeFrame(frame);
    } catch (error) {
      if (!(error instanceof BridgeFrameError) || frame.kind !== "result") throw error;
      line = encodeFrame({
        kind: "result",
        callId: frame.callId,
        ok: false,
        error: {
          code: "TOO_LARGE",
          message: "Background task host response exceeds the frame bound",
        },
      });
    }
    if (
      live.socket.writableLength + utf8Length(line) >
      BRIDGE_FRAME_BYTES * BRIDGE_BUFFERED_FRAMES
    ) {
      this.fail(live);
      return;
    }
    live.socket.write(line);
  }

  private receive(live: LiveConnection, frame: BridgeDownFrame): void {
    if (frame.kind === "error") {
      this.fail(live);
      return;
    }
    if (frame.kind === "attached") {
      if (live.attached) throw new BridgeFrameError("INVALID_FRAME", "Duplicate attachment");
      live.attached = true;
      live.runtimeId = frame.runtimeId;
      if (live.timer) clearTimeout(live.timer);
      live.timer = null;
      void this.announce(live);
      return;
    }
    if (!live.attached) throw new BridgeFrameError("INVALID_FRAME", "Call before attachment");
    if (live.pending.has(frame.callId))
      throw new BridgeFrameError("INVALID_FRAME", "Duplicate call identity");
    if (live.pending.size >= BRIDGE_MAX_IN_FLIGHT) {
      this.send(live, {
        kind: "result",
        callId: frame.callId,
        ok: false,
        error: { code: "BUSY", message: "Too many background job operations are in flight" },
      });
      return;
    }
    live.pending.add(frame.callId);
    void this.call(live, frame).then((answer) => {
      if (!live.pending.delete(frame.callId)) return undefined;
      this.send(
        live,
        answer.ok
          ? { kind: "result", callId: frame.callId, ok: true, result: answer.result }
          : { kind: "result", callId: frame.callId, ok: false, error: answer.error },
      );
      return undefined;
    });
  }

  private async announce(live: LiveConnection): Promise<void> {
    const presence = await this.discover();
    if (live.ended) return;
    this.send(live, { kind: "host", presence });
    if (this.lastChange) this.send(live, { kind: "changed", change: this.lastChange });
  }

  /** A bounded capability check: discovery only, never a fallback data plane. */
  private async discover(): Promise<BridgeHostPresence> {
    const answer = await this.hostRequest("capabilities", {}, BRIDGE_DISCOVERY_TIMEOUT_MS);
    if (answer && answer.ok && isRecord(answer.result) && answer.result["api_version"] === 1)
      return "available";
    if (answer) return "outdated";
    return (await this.v1Present()) ? "outdated" : "missing";
  }

  private v1Present(): Promise<boolean> {
    const requestId = randomUUID();
    const completion = bridgeCompletion<boolean>();
    const finish = (present: boolean) => {
      if (!completion.finish(present)) return;
      clearTimeout(timer);
      this.v1Waiters.delete(requestId);
    };
    const timer = setTimeout(() => finish(false), BRIDGE_DISCOVERY_TIMEOUT_MS);
    this.v1Waiters.set(requestId, () => finish(true));
    try {
      this.events.emit(V1_REQUEST_CHANNEL, {
        schema_version: V1_REQUEST_SCHEMA,
        request_id: requestId,
        operation: "capabilities",
        payload: {},
      });
    } catch {
      // Only a registered v1 listener can throw here, so the v1 service is present.
      finish(true);
    }
    return completion.promise;
  }

  private async call(
    live: LiveConnection,
    frame: Extract<BridgeDownFrame, { kind: "call" }>,
  ): Promise<HostAnswer> {
    if (frame.operation === "subscribe") return this.subscribe(live);
    if (frame.operation === "unsubscribe") return this.unsubscribe(live);
    const lease = live.lease;
    if (!lease)
      return failure("LEASE_UNAVAILABLE", "The background task host lease is not established");
    if (lease.activationId !== frame.activationId)
      return failure("ACTIVATION_MISMATCH", "The request names an obsolete host activation");
    lease.sequence += 1;
    const answer = await this.hostRequest(
      frame.operation,
      {
        ...frame.payload,
        leaseId: lease.leaseId,
        activationId: lease.activationId,
        sequence: lease.sequence,
      },
      BRIDGE_CALL_TIMEOUT_MS,
    );
    if (!answer)
      return failure(
        "TIMEOUT",
        "The background task host did not answer in time; the outcome is unknown",
      );
    const leaseLost =
      !answer.ok && (answer.error.code === "LEASE_INVALID" || answer.error.code === "CLOSED");
    if (leaseLost && live.lease === lease) live.lease = null;
    return answer;
  }

  private async subscribe(live: LiveConnection): Promise<HostAnswer> {
    const runtimeId = live.runtimeId;
    if (!runtimeId) return failure("UNATTACHED", "The bridge is not attached");
    const answer = await this.hostRequest(
      "subscribe",
      { clientId: `paseo-${runtimeId}`.slice(0, 128) },
      BRIDGE_CALL_TIMEOUT_MS,
    );
    if (!answer) return failure("TIMEOUT", "The background task host did not answer in time");
    if (!answer.ok) return answer;
    const result = answer.result;
    const leaseId = isRecord(result) ? readString(result, "leaseId") : null;
    const activationId = isRecord(result) ? readString(result, "activationId") : null;
    if (!leaseId || !activationId)
      return failure("INVALID_HOST_RESULT", "The background task host returned an invalid lease");
    if (live.lease?.leaseId !== leaseId) live.lease = { leaseId, activationId, sequence: 0 };
    return answer;
  }

  private async unsubscribe(live: LiveConnection): Promise<HostAnswer> {
    const lease = live.lease;
    live.lease = null;
    if (!lease) return { ok: true, result: { released: false } };
    const answer = await this.hostRequest(
      "unsubscribe",
      { leaseId: lease.leaseId, activationId: lease.activationId, sequence: lease.sequence + 1 },
      BRIDGE_CALL_TIMEOUT_MS,
    );
    return answer ?? failure("TIMEOUT", "The background task host did not answer in time");
  }

  private hostRequest(
    operation: string,
    payload: JsonRecord,
    timeoutMs: number,
  ): Promise<HostAnswer | null> {
    const requestId = randomUUID();
    const completion = bridgeCompletion<HostAnswer | null>();
    const finish = (answer: HostAnswer | null) => {
      if (!completion.finish(answer)) return;
      clearTimeout(timer);
      this.hostWaiters.delete(requestId);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    this.hostWaiters.set(requestId, finish);
    try {
      this.events.emit(HOST_REQUEST_CHANNEL, {
        schema_version: HOST_REQUEST_SCHEMA,
        request_id: requestId,
        operation,
        payload,
      });
    } catch (error) {
      finish(
        failure("OPERATION_FAILED", boundedMessage(error instanceof Error ? error.message : error)),
      );
    }
    return completion.promise;
  }

  private hostResponse(data: unknown): void {
    const requestId = isRecord(data) ? data["request_id"] : undefined;
    if (!isRecord(data) || typeof requestId !== "string") return;
    const waiter = this.hostWaiters.get(requestId);
    if (!waiter) return;
    if (data["ok"] === true) waiter({ ok: true, result: data["result"] });
    else waiter({ ok: false, error: readHostError(data["error"]) });
  }

  private v1Response(data: unknown): void {
    const requestId = isRecord(data) ? data["request_id"] : undefined;
    if (typeof requestId !== "string") return;
    this.v1Waiters.get(requestId)?.();
  }

  private hostChanged(data: unknown): void {
    if (!isRecord(data)) return;
    this.lastChange = data;
    const live = this.live;
    if (!live || live.ended) return;
    const kind = data["kind"];
    if (live.lease && (kind === "closed" || data["activationId"] !== live.lease.activationId))
      live.lease = null;
    if (live.attached) this.send(live, { kind: "changed", change: data });
  }
}

function failure(code: string, message: string): HostAnswer {
  return { ok: false, error: { code, message } };
}

export default function paseoBackgroundJobsBridge(pi: BridgeExtensionApi): void {
  const config = readBridgeConfig(process.env);
  if (!config) return;
  const bridge = new BackgroundJobsBridge(pi.events, config);
  pi.on("session_start", (_event, ctx) => {
    bridge.start(ctx.sessionManager.getSessionId());
  });
  pi.on("session_shutdown", () => {
    bridge.close();
  });
}
