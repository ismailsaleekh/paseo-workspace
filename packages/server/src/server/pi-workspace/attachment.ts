import { randomBytes, randomUUID } from "node:crypto";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  VisualFailure,
  VisualLocalRequestSchema,
  VISUAL_FRAME_BYTES,
  VISUAL_OPERATION_TIMEOUT_MS,
  VISUAL_PROTOCOL_VERSION,
  assertVisualJsonBound,
  type VisualLocalResponse,
  type VisualOperation,
  type VisualOwner,
  type VisualResult,
} from "@getpaseo/protocol/pi-workspace/contracts";

export interface VisualRuntimeLease {
  readonly env: { PI_WORKSPACE_SOCKET: string; PI_WORKSPACE_CAPABILITY: string };
  activate(readSessionId: () => Promise<string>): void;
  revoke(): void;
}
export interface VisualAttachmentHost {
  execute(
    owner: VisualOwner,
    operation: VisualOperation,
    signal: AbortSignal,
  ): Promise<VisualResult>;
  reportFailure(error: unknown): void;
}
interface Grant {
  agentId: string;
  generation: string;
  revoked: boolean;
  readSessionId: (() => Promise<string>) | null;
  sockets: Set<Socket>;
}
interface Peer {
  socket: Socket;
  grant: Grant | null;
  sessionId: string | null;
  attaching: boolean;
  active: boolean;
  pending: Map<string, AbortController>;
  requests: Set<string>;
}

/** Credentials exist only in runtime memory and the provider's private launch environment. */
export class VisualAttachmentBridge {
  private server: Server | null = null;
  private directory: string | null = null;
  private socketPath: string | null = null;
  private readonly grants = new Map<string, Grant>();
  private readonly peers = new Set<Peer>();

  constructor(private readonly host: VisualAttachmentHost) {}

  async start(): Promise<void> {
    if (this.server)
      throw new VisualFailure("ALREADY_STARTED", "Visual attachment bridge is already running");
    const directory = await mkdtemp(join(tmpdir(), "paseo-visual-"));
    await chmod(directory, 0o700);
    const socketPath = join(directory, "host.sock");
    if (Buffer.byteLength(socketPath) >= 104) {
      await rm(directory, { recursive: true, force: true });
      throw new VisualFailure(
        "SOCKET_PATH_TOO_LONG",
        "Private visual attachment socket path exceeds the platform bound",
      );
    }
    const server = createServer((socket) => this.accept(socket));
    this.server = server;
    this.directory = directory;
    try {
      await new Promise<void>((resolve, reject) => {
        const failed = (error: Error) => {
          server.off("listening", ready);
          reject(error);
        };
        const ready = () => {
          server.off("error", failed);
          resolve();
        };
        server.once("error", failed);
        server.once("listening", ready);
        server.listen(socketPath);
      });
      server.on("error", (error) => this.host.reportFailure(error));
      await chmod(socketPath, 0o600);
      this.socketPath = socketPath;
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  issue(agentId: string): VisualRuntimeLease {
    const socketPath = this.socketPath;
    if (!socketPath)
      throw new VisualFailure("HOST_UNAVAILABLE", "Visual attachment bridge is not running");
    if (agentId.length === 0 || agentId.length > 256)
      throw new VisualFailure("INVALID_AGENT", "Visual attachment needs an exact agent identity");
    const capability = randomBytes(32).toString("hex");
    const grant: Grant = {
      agentId,
      generation: randomUUID(),
      revoked: false,
      readSessionId: null,
      sockets: new Set(),
    };
    this.grants.set(capability, grant);
    return {
      env: { PI_WORKSPACE_SOCKET: socketPath, PI_WORKSPACE_CAPABILITY: capability },
      activate: (readSessionId) => {
        if (grant.revoked || grant.readSessionId)
          throw new VisualFailure(
            "STALE_RUNTIME",
            "Visual runtime lease cannot be activated twice or after revocation",
          );
        grant.readSessionId = readSessionId;
      },
      revoke: () => {
        grant.revoked = true;
        this.grants.delete(capability);
        for (const socket of grant.sockets) socket.destroy();
        grant.sockets.clear();
      },
    };
  }

  async stop(): Promise<void> {
    this.socketPath = null;
    for (const grant of this.grants.values()) {
      grant.revoked = true;
      for (const socket of grant.sockets) socket.destroy();
    }
    this.grants.clear();
    for (const peer of this.peers) this.disconnect(peer);
    const server = this.server;
    this.server = null;
    if (server?.listening) {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    }
    if (this.directory) {
      const directory = this.directory;
      this.directory = null;
      await rm(directory, { recursive: true, force: true });
    }
  }

  private disconnect(peer: Peer): void {
    if (!peer.active) return;
    peer.active = false;
    for (const controller of peer.pending.values()) controller.abort();
    peer.pending.clear();
    peer.grant?.sockets.delete(peer.socket);
    this.peers.delete(peer);
    peer.socket.destroy();
  }

  private send(peer: Peer, response: VisualLocalResponse): void {
    if (!peer.active)
      throw new VisualFailure("DISCONNECTED", "Visual attachment peer disconnected");
    const frame = JSON.stringify(response) + "\n";
    if (
      Buffer.byteLength(frame) > VISUAL_FRAME_BYTES ||
      peer.socket.writableLength + Buffer.byteLength(frame) > VISUAL_FRAME_BYTES * 2
    ) {
      this.disconnect(peer);
      throw new VisualFailure("BACKPRESSURE", "Visual attachment exceeded its output bound");
    }
    peer.socket.write(frame);
  }

  private respondFailure(peer: Peer, requestId: string | null, error: unknown): void {
    if (!(error instanceof VisualFailure)) this.host.reportFailure(error);
    if (!peer.active) return;
    const failure =
      error instanceof VisualFailure
        ? error
        : new VisualFailure("HOST_ERROR", "Visual host operation failed");
    try {
      this.send(peer, {
        kind: "error",
        requestId,
        error: { code: failure.code, message: failure.message.slice(0, 2048) },
        artifactId: failure.artifactId,
      });
    } catch (sendError) {
      this.host.reportFailure(sendError);
      this.disconnect(peer);
    }
  }

  private accept(socket: Socket): void {
    if (this.peers.size >= 128) {
      socket.destroy();
      return;
    }
    const peer: Peer = {
      socket,
      grant: null,
      sessionId: null,
      attaching: false,
      active: true,
      pending: new Map(),
      requests: new Set(),
    };
    this.peers.add(peer);
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let buffered = "";
    const handshakeTimer = setTimeout(() => this.disconnect(peer), 3000);
    socket.on("close", () => {
      clearTimeout(handshakeTimer);
      this.disconnect(peer);
    });
    socket.on("error", () => this.disconnect(peer));
    socket.on("data", (bytes: Buffer) => {
      try {
        buffered += decoder.decode(bytes, { stream: true });
        let end = buffered.indexOf("\n");
        while (end !== -1 && peer.active) {
          const line = buffered.slice(0, end);
          buffered = buffered.slice(end + 1);
          if (Buffer.byteLength(line) > VISUAL_FRAME_BYTES)
            throw new VisualFailure("INVALID_FRAME", "Visual frame is too large");
          const value: unknown = JSON.parse(line);
          assertVisualJsonBound(value, VISUAL_FRAME_BYTES);
          const parsed = VisualLocalRequestSchema.safeParse(value);
          if (!parsed.success)
            throw new VisualFailure("INVALID_FRAME", "Invalid private visual request");
          const frame = parsed.data;
          if (frame.kind === "attach") {
            if (peer.grant || peer.attaching)
              throw new VisualFailure("INVALID_FRAME", "Visual attachment is already bound");
            peer.attaching = true;
            void this.attach(peer, frame.capability, frame.sessionId).then(
              () => {
                clearTimeout(handshakeTimer);
                return undefined;
              },
              (error: unknown) => {
                this.respondFailure(peer, null, error);
                this.disconnect(peer);
              },
            );
          } else if (frame.kind === "cancel") {
            peer.pending.get(frame.requestId)?.abort();
          } else {
            if (!peer.grant || !peer.sessionId)
              throw new VisualFailure("UNATTACHED", "Visual request precedes verified attachment");
            if (peer.requests.has(frame.requestId))
              throw new VisualFailure(
                "DUPLICATE_REQUEST",
                "Visual request identity was already used",
              );
            if (peer.requests.size >= 4096 || peer.pending.size >= 64)
              throw new VisualFailure("BUSY", "Visual attachment request limit reached; reconnect");
            peer.requests.add(frame.requestId);
            const controller = new AbortController();
            peer.pending.set(frame.requestId, controller);
            const timeout = setTimeout(
              () => controller.abort(),
              VISUAL_OPERATION_TIMEOUT_MS - 1000,
            );
            void this.execute(peer, frame.operation, controller.signal)
              .then(
                (result) => {
                  if (peer.active)
                    this.send(peer, { kind: "result", requestId: frame.requestId, result });
                  return undefined;
                },
                (error: unknown) => this.respondFailure(peer, frame.requestId, error),
              )
              .catch((error: unknown) => this.host.reportFailure(error))
              .finally(() => {
                clearTimeout(timeout);
                peer.pending.delete(frame.requestId);
              });
          }
          end = buffered.indexOf("\n");
        }
        if (Buffer.byteLength(buffered) > VISUAL_FRAME_BYTES)
          throw new VisualFailure("INVALID_FRAME", "Visual frame is too large");
      } catch (error) {
        const failure =
          error instanceof SyntaxError || error instanceof TypeError
            ? new VisualFailure("INVALID_FRAME", "Malformed visual JSON or UTF-8")
            : error;
        this.respondFailure(peer, null, failure);
        this.disconnect(peer);
      }
    });
  }

  private async attach(peer: Peer, capability: string, sessionId: string): Promise<void> {
    const grant = this.grants.get(capability);
    if (!grant || grant.revoked || !grant.readSessionId)
      throw new VisualFailure("UNAUTHORIZED", "Visual runtime capability is invalid or not active");
    const actualSessionId = await grant.readSessionId();
    if (!peer.active || grant.revoked || actualSessionId !== sessionId)
      throw new VisualFailure(
        "STALE_SESSION",
        "Visual attachment does not match the actual Pi session",
      );
    // One connection per runtime prevents a replaced extension retaining a competing writer.
    for (const socket of grant.sockets) socket.destroy();
    grant.sockets.clear();
    grant.sockets.add(peer.socket);
    peer.grant = grant;
    peer.sessionId = sessionId;
    this.send(peer, {
      kind: "attached",
      protocol: VISUAL_PROTOCOL_VERSION,
      sessionId,
      generation: grant.generation,
    });
  }

  private async execute(
    peer: Peer,
    operation: VisualOperation,
    signal: AbortSignal,
  ): Promise<VisualResult> {
    const grant = peer.grant;
    const sessionId = peer.sessionId;
    if (!grant || grant.revoked || !grant.readSessionId || !sessionId)
      throw new VisualFailure("STALE_RUNTIME", "Visual runtime is no longer attached");
    const actualSessionId = await grant.readSessionId();
    if (!peer.active || grant.revoked || actualSessionId !== sessionId)
      throw new VisualFailure("STALE_SESSION", "Visual request belongs to a previous Pi session");
    if (signal.aborted) throw new VisualFailure("CANCELLED", "Visual operation was cancelled");
    return this.host.execute({ agentId: grant.agentId, sessionId }, operation, signal);
  }
}
