/**
 * Private Paseo <-> Pi background-jobs bridge protocol (`paseo.pi-bg.v1`).
 *
 * Shared by the bundled Pi extension and the daemon attachment, so it uses no dependency beyond
 * the JavaScript standard library. Frames are bounded UTF-8 JSON lines. Every frame is a closed,
 * kind-tagged object; anything else is rejected without echoing its contents.
 */

export const BRIDGE_PROTOCOL = "paseo.pi-bg.v1";
export const BRIDGE_ENV_SOCKET = "PASEO_BG_SOCKET";
export const BRIDGE_ENV_CAPABILITY = "PASEO_BG_CAPABILITY";
/** Outer frame bound; a host response is at most 256 KiB before this envelope. */
export const BRIDGE_FRAME_BYTES = 320 * 1024;
/** Unsent output beyond this many full frames means the peer is not reading; disconnect. */
export const BRIDGE_BUFFERED_FRAMES = 2;
export const BRIDGE_MAX_IN_FLIGHT = 16;
export const BRIDGE_HANDSHAKE_TIMEOUT_MS = 5_000;
/** A startup attach may arrive before the provider has read Pi's state; it waits at most this. */
export const BRIDGE_STARTUP_ACTIVATION_TIMEOUT_MS = 30_000;
/** `stop` resolves only after real terminal settlement, which can take the registry's grace. */
export const BRIDGE_CALL_TIMEOUT_MS = 45_000;
export const BRIDGE_DISCOVERY_TIMEOUT_MS = 2_000;
const MAX_ERROR_CHARS = 512;
const MAX_ID_CHARS = 128;

export const BRIDGE_OPERATIONS = [
  "subscribe",
  "unsubscribe",
  "list",
  "detail",
  "logs",
  "stop",
  "stop_all",
  "rerun",
  "result",
  "mark_seen",
] as const;
export type BridgeOperation = (typeof BRIDGE_OPERATIONS)[number];
export type BridgeLeasedOperation = Exclude<BridgeOperation, "subscribe" | "unsubscribe">;

export type BridgeHostPresence = "available" | "outdated" | "missing";

export interface BridgeError {
  code: string;
  message: string;
}

/** One terminal outcome when response, deadline and disconnect callbacks race. */
export function bridgeCompletion<T>(): { promise: Promise<T>; finish(value: T): boolean } {
  let deliver: (value: T) => void = () => {
    throw new Error("Bridge completion is not initialized");
  };
  const promise = new Promise<T>((resolve) => {
    deliver = resolve;
  });
  let settled = false;
  return {
    promise,
    finish: (value) => {
      if (settled) return false;
      settled = true;
      deliver(value);
      return true;
    },
  };
}

/** Pi extension -> daemon. */
export type BridgeUpFrame =
  | { kind: "attach"; protocol: typeof BRIDGE_PROTOCOL; capability: string; sessionId: string }
  | { kind: "host"; presence: BridgeHostPresence }
  | { kind: "changed"; change: unknown }
  | { kind: "result"; callId: string; ok: true; result: unknown }
  | { kind: "result"; callId: string; ok: false; error: BridgeError };

/** Daemon -> Pi extension. */
export type BridgeDownFrame =
  | { kind: "attached"; protocol: typeof BRIDGE_PROTOCOL; runtimeId: string }
  | {
      kind: "call";
      callId: string;
      operation: BridgeOperation;
      activationId: string | null;
      payload: Record<string, unknown>;
    }
  | { kind: "error"; code: string; message: string };

export class BridgeFrameError extends Error {
  constructor(
    readonly code: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "BridgeFrameError";
  }
}

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function closed(record: JsonRecord, keys: readonly string[]): void {
  for (const key of Object.keys(record)) {
    if (!keys.includes(key)) throw new BridgeFrameError("INVALID_FRAME", "Unexpected frame field");
  }
}

function boundedString(value: unknown, maximum: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum)
    throw new BridgeFrameError("INVALID_FRAME", "Invalid frame string");
  return value;
}

function isOperation(value: unknown): value is BridgeOperation {
  return BRIDGE_OPERATIONS.some((operation) => operation === value);
}

function parseError(value: unknown): BridgeError {
  if (!isRecord(value)) throw new BridgeFrameError("INVALID_FRAME", "Invalid frame error");
  closed(value, ["code", "message"]);
  return {
    code: boundedString(value["code"], 64),
    message: boundedMessage(value["message"]),
  };
}

export function boundedMessage(value: unknown): string {
  const text = (typeof value === "string" ? value : String(value)).replace(/\s+/g, " ").trim();
  const nonEmpty = text.length > 0 ? text : "Unspecified bridge error";
  return nonEmpty.length <= MAX_ERROR_CHARS
    ? nonEmpty
    : `${nonEmpty.slice(0, MAX_ERROR_CHARS - 1)}…`;
}

function parseResult(value: JsonRecord): BridgeUpFrame {
  const callId = boundedString(value["callId"], MAX_ID_CHARS);
  if (value["ok"] === true) {
    closed(value, ["kind", "callId", "ok", "result"]);
    if (!("result" in value)) throw new BridgeFrameError("INVALID_FRAME", "Missing result");
    return { kind: "result", callId, ok: true, result: value["result"] };
  }
  if (value["ok"] === false) {
    closed(value, ["kind", "callId", "ok", "error"]);
    return { kind: "result", callId, ok: false, error: parseError(value["error"]) };
  }
  throw new BridgeFrameError("INVALID_FRAME", "Invalid result frame");
}

export function parseUpFrame(value: unknown): BridgeUpFrame {
  if (!isRecord(value)) throw new BridgeFrameError("INVALID_FRAME", "Frame must be an object");
  switch (value["kind"]) {
    case "attach":
      closed(value, ["kind", "protocol", "capability", "sessionId"]);
      if (value["protocol"] !== BRIDGE_PROTOCOL)
        throw new BridgeFrameError("PROTOCOL_MISMATCH", "Unsupported bridge protocol");
      return {
        kind: "attach",
        protocol: BRIDGE_PROTOCOL,
        capability: boundedString(value["capability"], 128),
        sessionId: boundedString(value["sessionId"], 256),
      };
    case "host": {
      closed(value, ["kind", "presence"]);
      const presence = value["presence"];
      if (presence !== "available" && presence !== "outdated" && presence !== "missing")
        throw new BridgeFrameError("INVALID_FRAME", "Invalid host presence");
      return { kind: "host", presence };
    }
    case "changed":
      closed(value, ["kind", "change"]);
      return { kind: "changed", change: value["change"] };
    case "result":
      return parseResult(value);
    default:
      throw new BridgeFrameError("INVALID_FRAME", "Unknown frame kind");
  }
}

export function parseDownFrame(value: unknown): BridgeDownFrame {
  if (!isRecord(value)) throw new BridgeFrameError("INVALID_FRAME", "Frame must be an object");
  switch (value["kind"]) {
    case "attached":
      closed(value, ["kind", "protocol", "runtimeId"]);
      if (value["protocol"] !== BRIDGE_PROTOCOL)
        throw new BridgeFrameError("PROTOCOL_MISMATCH", "Unsupported bridge protocol");
      return {
        kind: "attached",
        protocol: BRIDGE_PROTOCOL,
        runtimeId: boundedString(value["runtimeId"], MAX_ID_CHARS),
      };
    case "call": {
      closed(value, ["kind", "callId", "operation", "activationId", "payload"]);
      const operation = value["operation"];
      if (!isOperation(operation))
        throw new BridgeFrameError("INVALID_FRAME", "Unknown bridge operation");
      const payload = value["payload"];
      if (!isRecord(payload)) throw new BridgeFrameError("INVALID_FRAME", "Invalid call payload");
      const activationId = value["activationId"];
      return {
        kind: "call",
        callId: boundedString(value["callId"], MAX_ID_CHARS),
        operation,
        activationId: activationId === null ? null : boundedString(activationId, MAX_ID_CHARS),
        payload,
      };
    }
    case "error":
      closed(value, ["kind", "code", "message"]);
      return {
        kind: "error",
        code: boundedString(value["code"], 64),
        message: boundedMessage(value["message"]),
      };
    default:
      throw new BridgeFrameError("INVALID_FRAME", "Unknown frame kind");
  }
}

/** Serializes one frame, refusing anything over the outer bound. */
export function encodeFrame(frame: BridgeUpFrame | BridgeDownFrame): string {
  const line = `${JSON.stringify(frame)}\n`;
  if (utf8Length(line) > BRIDGE_FRAME_BYTES)
    throw new BridgeFrameError("TOO_LARGE", "Bridge frame exceeds its byte bound");
  return line;
}

export function utf8Length(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

/**
 * Splits a byte stream into bounded JSON values. Invalid UTF-8, malformed JSON and oversized
 * lines throw; the caller closes the connection.
 */
export class FrameDecoder {
  private readonly decoder = new TextDecoder("utf-8", { fatal: true });
  private buffered = "";

  push(bytes: Uint8Array): unknown[] {
    let text: string;
    try {
      text = this.decoder.decode(bytes, { stream: true });
    } catch (error) {
      throw new BridgeFrameError("INVALID_FRAME", "Bridge frame is not valid UTF-8", {
        cause: error,
      });
    }
    this.buffered += text;
    const values: unknown[] = [];
    let end = this.buffered.indexOf("\n");
    while (end !== -1) {
      const line = this.buffered.slice(0, end);
      this.buffered = this.buffered.slice(end + 1);
      if (utf8Length(line) > BRIDGE_FRAME_BYTES)
        throw new BridgeFrameError("TOO_LARGE", "Bridge frame exceeds its byte bound");
      values.push(parseJsonLine(line));
      end = this.buffered.indexOf("\n");
    }
    if (utf8Length(this.buffered) > BRIDGE_FRAME_BYTES)
      throw new BridgeFrameError("TOO_LARGE", "Bridge frame exceeds its byte bound");
    return values;
  }
}

function parseJsonLine(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch (error) {
    throw new BridgeFrameError("INVALID_FRAME", "Bridge frame is not valid JSON", {
      cause: error,
    });
  }
}
