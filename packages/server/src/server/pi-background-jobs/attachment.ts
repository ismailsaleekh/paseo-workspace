import { randomBytes, randomUUID } from "node:crypto";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BRIDGE_BUFFERED_FRAMES,
  BRIDGE_CALL_TIMEOUT_MS,
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
  parseUpFrame,
  utf8Length,
  type BridgeDownFrame,
  type BridgeError,
  type BridgeHostPresence,
  type BridgeOperation,
  type BridgeUpFrame,
} from "../agent/providers/pi/background-jobs-bridge/protocol.js";

/** Mac sockets have a 104-byte path limit including the terminator. */
const MAX_SOCKET_PATH_BYTES = 103;
const MAX_PEERS = 128;
/** The daemon side waits a little longer than the bridge so a late answer is still delivered. */
const CALL_DEADLINE_MS = BRIDGE_CALL_TIMEOUT_MS + 5_000;

export class BackgroundJobsAttachmentError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "BackgroundJobsAttachmentError";
  }
}

export interface PiBackgroundJobsLease {
  readonly runtimeId: string;
  readonly env: { [BRIDGE_ENV_SOCKET]: string; [BRIDGE_ENV_CAPABILITY]: string };
  readonly extensionPath: string;
  /** Called once the provider has read the runtime's actual state. */
  activate(readSessionId: () => Promise<string>): void;
  revoke(): void;
}

export type BridgeCallOutcome = { ok: true; result: unknown } | { ok: false; error: BridgeError };

/** A verified bridge connection for one runtime. */
export interface BridgePeer {
  readonly runtimeId: string;
  readonly sessionId: string;
  call(
    operation: BridgeOperation,
    activationId: string | null,
    payload: Record<string, unknown>,
  ): Promise<BridgeCallOutcome>;
}

export type BridgePeerFrame =
  | { kind: "host"; presence: BridgeHostPresence }
  | { kind: "changed"; change: unknown };

export interface BackgroundJobsAttachmentHost {
  activated(runtime: { agentId: string; runtimeId: string }): void;
  connected(peer: BridgePeer): void;
  received(peer: BridgePeer, frame: BridgePeerFrame): void;
  disconnected(peer: BridgePeer): void;
  revoked(runtimeId: string): void;
  reportFailure(error: unknown): void;
}

interface Grant {
  agentId: string;
  runtimeId: string;
  revoked: boolean;
  readSessionId: (() => Promise<string>) | null;
  activation: Set<{ resolve(): void; reject(error: Error): void }>;
  peer: Peer | null;
}

interface Pending {
  resolve(outcome: BridgeCallOutcome): void;
  timer: ReturnType<typeof setTimeout>;
}

interface Peer {
  socket: Socket;
  grant: Grant | null;
  active: boolean;
  attaching: boolean;
  pending: Map<string, Pending>;
  handle: BridgePeer | null;
}

/**
 * The daemon's private socket for Paseo-launched Pi runtimes. Capabilities exist only in runtime
 * memory and each Pi process's private launch environment; they never appear in public DTOs or logs.
 */
export class BackgroundJobsAttachment {
  private server: Server | null = null;
  private directory: string | null = null;
  private socketPath: string | null = null;
  private readonly grants = new Map<string, Grant>();
  private readonly peers = new Set<Peer>();

  constructor(private readonly host: BackgroundJobsAttachmentHost) {}

  get listening(): boolean {
    return this.socketPath !== null;
  }

  async start(): Promise<void> {
    if (this.server) throw new BackgroundJobsAttachmentError("ALREADY_STARTED", "Already running");
    if (process.platform === "win32")
      throw new BackgroundJobsAttachmentError(
        "UNSUPPORTED_PLATFORM",
        "Native background jobs are not available on Windows hosts",
      );
    const directory = await mkdtemp(join(tmpdir(), "paseo-bg-"));
    await chmod(directory, 0o700);
    const socketPath = join(directory, "h.sock");
    if (Buffer.byteLength(socketPath) > MAX_SOCKET_PATH_BYTES) {
      await rm(directory, { recursive: true, force: true });
      throw new BackgroundJobsAttachmentError(
        "SOCKET_PATH_TOO_LONG",
        "The private background jobs socket path exceeds the platform bound",
      );
    }
    const server = createServer((socket) => this.accept(socket));
    this.server = server;
    this.directory = directory;
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(socketPath, () => {
          server.off("error", reject);
          resolve();
        });
      });
      server.on("error", (error) => this.host.reportFailure(error));
      await chmod(socketPath, 0o600);
      this.socketPath = socketPath;
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  issue(agentId: string, extensionPath: string): PiBackgroundJobsLease {
    const socketPath = this.socketPath;
    if (!socketPath)
      throw new BackgroundJobsAttachmentError("UNAVAILABLE", "The private bridge is not running");
    const capability = randomBytes(32).toString("hex");
    const grant: Grant = {
      agentId,
      runtimeId: randomUUID(),
      revoked: false,
      readSessionId: null,
      activation: new Set(),
      peer: null,
    };
    this.grants.set(capability, grant);
    return {
      runtimeId: grant.runtimeId,
      env: { [BRIDGE_ENV_SOCKET]: socketPath, [BRIDGE_ENV_CAPABILITY]: capability },
      extensionPath,
      activate: (readSessionId) => {
        if (grant.revoked || grant.readSessionId)
          throw new BackgroundJobsAttachmentError(
            "STALE_RUNTIME",
            "A background jobs lease cannot be activated twice or after revocation",
          );
        grant.readSessionId = readSessionId;
        this.host.activated({ agentId: grant.agentId, runtimeId: grant.runtimeId });
        for (const waiter of grant.activation) waiter.resolve();
        grant.activation.clear();
      },
      revoke: () => {
        if (grant.revoked) return;
        grant.revoked = true;
        this.grants.delete(capability);
        const revokedError = new BackgroundJobsAttachmentError(
          "REVOKED",
          "The runtime lease was revoked",
        );
        for (const waiter of grant.activation) waiter.reject(revokedError);
        grant.activation.clear();
        // Report the end first so the hub never mistakes revocation for a lost bridge.
        this.host.revoked(grant.runtimeId);
        if (grant.peer) this.disconnect(grant.peer);
      },
    };
  }

  async stop(): Promise<void> {
    this.socketPath = null;
    for (const grant of this.grants.values()) {
      grant.revoked = true;
      for (const waiter of grant.activation)
        waiter.reject(new BackgroundJobsAttachmentError("CLOSED", "The bridge stopped"));
      grant.activation.clear();
    }
    this.grants.clear();
    for (const peer of this.peers) this.disconnect(peer);
    const server = this.server;
    this.server = null;
    if (server?.listening) {
      const completion = bridgeCompletion<Error | undefined>();
      server.close((error) => completion.finish(error));
      const error = await completion.promise;
      if (error) throw error;
    }
    const directory = this.directory;
    this.directory = null;
    if (directory) await rm(directory, { recursive: true, force: true });
  }

  private accept(socket: Socket): void {
    if (this.peers.size >= MAX_PEERS) {
      socket.destroy();
      return;
    }
    const peer: Peer = {
      socket,
      grant: null,
      active: true,
      attaching: false,
      pending: new Map(),
      handle: null,
    };
    this.peers.add(peer);
    const decoder = new FrameDecoder();
    const handshake = setTimeout(() => this.disconnect(peer), BRIDGE_HANDSHAKE_TIMEOUT_MS);
    socket.on("close", () => {
      clearTimeout(handshake);
      this.disconnect(peer);
    });
    socket.on("error", () => this.disconnect(peer));
    socket.on("data", (bytes: Buffer) => {
      try {
        for (const value of decoder.push(bytes)) {
          if (!peer.active) return;
          const frame = parseUpFrame(value);
          if (frame.kind === "attach") clearTimeout(handshake);
          this.receive(peer, frame);
        }
      } catch (error) {
        this.reject(peer, error);
      }
    });
  }

  private receive(peer: Peer, frame: BridgeUpFrame): void {
    if (frame.kind === "attach") {
      if (peer.attaching || peer.grant)
        throw new BridgeFrameError("INVALID_FRAME", "The bridge is already attached");
      peer.attaching = true;
      void this.attach(peer, frame.capability, frame.sessionId).catch((error: unknown) =>
        this.reject(peer, error),
      );
      return;
    }
    const handle = peer.handle;
    if (!handle)
      throw new BridgeFrameError("UNATTACHED", "Bridge frame precedes a verified attachment");
    if (frame.kind === "result") {
      const pending = peer.pending.get(frame.callId);
      if (!pending) return;
      peer.pending.delete(frame.callId);
      clearTimeout(pending.timer);
      pending.resolve(
        frame.ok ? { ok: true, result: frame.result } : { ok: false, error: frame.error },
      );
      return;
    }
    this.host.received(handle, frame);
  }

  /** Sends one bounded rejection without any attached identity, then closes. */
  private reject(peer: Peer, error: unknown): void {
    if (!peer.active) return;
    const rejection =
      error instanceof BridgeFrameError || error instanceof BackgroundJobsAttachmentError
        ? { code: error.code, message: error.message }
        : { code: "HOST_ERROR", message: "Background jobs attachment failed" };
    if (!(error instanceof BridgeFrameError || error instanceof BackgroundJobsAttachmentError))
      this.host.reportFailure(error);
    this.trySend(peer, {
      kind: "error",
      code: rejection.code,
      message: boundedMessage(rejection.message),
    });
    this.disconnect(peer);
  }

  private async attach(peer: Peer, capability: string, sessionId: string): Promise<void> {
    const grant = this.grants.get(capability);
    if (!grant || grant.revoked)
      throw new BackgroundJobsAttachmentError(
        "UNAUTHORIZED",
        "The runtime capability is invalid or revoked",
      );
    if (!grant.readSessionId) await this.awaitActivation(grant);
    const readSessionId = grant.readSessionId;
    if (!readSessionId)
      throw new BackgroundJobsAttachmentError("STALE_RUNTIME", "The runtime was not activated");
    const actualSessionId = await readSessionId();
    if (!peer.active || grant.revoked || actualSessionId !== sessionId)
      throw new BackgroundJobsAttachmentError(
        "STALE_SESSION",
        "The attachment does not match the actual Pi session",
      );
    // One connection per runtime: a reloaded extension replaces its predecessor's writer.
    if (grant.peer) this.disconnect(grant.peer);
    peer.grant = grant;
    grant.peer = peer;
    const handle: BridgePeer = {
      runtimeId: grant.runtimeId,
      sessionId,
      call: (operation, activationId, payload) => this.call(peer, operation, activationId, payload),
    };
    peer.handle = handle;
    if (
      !this.trySend(peer, {
        kind: "attached",
        protocol: BRIDGE_PROTOCOL,
        runtimeId: grant.runtimeId,
      })
    )
      return;
    this.host.connected(handle);
  }

  private async awaitActivation(grant: Grant): Promise<void> {
    const completion = bridgeCompletion<Error | null>();
    const finish = (error: Error | null) => {
      if (!completion.finish(error)) return;
      clearTimeout(timer);
      grant.activation.delete(waiter);
    };
    const waiter = { resolve: () => finish(null), reject: finish };
    const timer = setTimeout(
      () =>
        finish(
          new BackgroundJobsAttachmentError(
            "STARTUP_TIMEOUT",
            "The runtime was not activated within the startup deadline",
          ),
        ),
      BRIDGE_STARTUP_ACTIVATION_TIMEOUT_MS,
    );
    grant.activation.add(waiter);
    const error = await completion.promise;
    if (error) throw error;
  }

  private async call(
    peer: Peer,
    operation: BridgeOperation,
    activationId: string | null,
    payload: Record<string, unknown>,
  ): Promise<BridgeCallOutcome> {
    if (!peer.active || !peer.grant || peer.grant.revoked)
      return failure("DISCONNECTED", "The runtime bridge is disconnected");
    if (peer.pending.size >= BRIDGE_MAX_IN_FLIGHT)
      return failure("BUSY", "Too many background job operations are in flight");
    const callId = randomUUID();
    const completion = bridgeCompletion<BridgeCallOutcome>();
    const finish = (outcome: BridgeCallOutcome) => {
      if (!completion.finish(outcome)) return;
      peer.pending.delete(callId);
      clearTimeout(timer);
    };
    const timer = setTimeout(
      () =>
        finish(failure("TIMEOUT", "The runtime did not answer in time; the outcome is unknown")),
      CALL_DEADLINE_MS,
    );
    peer.pending.set(callId, { resolve: finish, timer });
    try {
      if (!this.trySend(peer, { kind: "call", callId, operation, activationId, payload }))
        finish(failure("BACKPRESSURE", "The runtime bridge is not reading its input"));
    } catch (error) {
      if (!(error instanceof BridgeFrameError)) {
        clearTimeout(timer);
        peer.pending.delete(callId);
        throw error;
      }
      finish(failure(error.code, error.message));
    }
    return completion.promise;
  }

  /** Encodes and writes one frame; an unread peer is disconnected and reported as false. */
  private trySend(peer: Peer, frame: BridgeDownFrame): boolean {
    if (!peer.active) return false;
    const line = encodeFrame(frame);
    if (
      peer.socket.writableLength + utf8Length(line) >
      BRIDGE_FRAME_BYTES * BRIDGE_BUFFERED_FRAMES
    ) {
      this.disconnect(peer);
      return false;
    }
    peer.socket.write(line);
    return true;
  }

  private disconnect(peer: Peer): void {
    if (!peer.active) return;
    peer.active = false;
    this.peers.delete(peer);
    for (const pending of peer.pending.values()) {
      clearTimeout(pending.timer);
      pending.resolve(
        failure("DISCONNECTED", "The runtime bridge disconnected; the outcome is unknown"),
      );
    }
    peer.pending.clear();
    peer.socket.destroy();
    const grant = peer.grant;
    if (grant?.peer === peer) grant.peer = null;
    if (peer.handle) this.host.disconnected(peer.handle);
  }
}

function failure(code: string, message: string): BridgeCallOutcome {
  return { ok: false, error: { code, message } };
}
