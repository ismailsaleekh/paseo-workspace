import { afterEach, describe, expect, test } from "vitest";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  BRIDGE_FRAME_BYTES,
  BRIDGE_PROTOCOL,
  FrameDecoder,
  encodeFrame,
  parseDownFrame,
  type BridgeDownFrame,
} from "../agent/providers/pi/background-jobs-bridge/protocol.js";
import {
  BackgroundJobsAttachment,
  type BackgroundJobsAttachmentHost,
  type BridgePeer,
  type BridgePeerFrame,
} from "./attachment.js";

interface Recorded {
  activated: string[];
  connected: BridgePeer[];
  received: BridgePeerFrame[];
  events: string[];
}

function recordingHost(): { host: BackgroundJobsAttachmentHost; recorded: Recorded } {
  const recorded: Recorded = { activated: [], connected: [], received: [], events: [] };
  return {
    recorded,
    host: {
      activated: ({ runtimeId }) => {
        recorded.activated.push(runtimeId);
        recorded.events.push(`activated:${runtimeId}`);
      },
      connected: (peer) => {
        recorded.connected.push(peer);
        recorded.events.push(`connected:${peer.runtimeId}`);
      },
      received: (_peer, frame) => {
        recorded.received.push(frame);
      },
      disconnected: (peer) => {
        recorded.events.push(`disconnected:${peer.runtimeId}`);
      },
      revoked: (runtimeId) => {
        recorded.events.push(`revoked:${runtimeId}`);
      },
      reportFailure: (error) => {
        throw error;
      },
    },
  };
}

class RawPeer {
  readonly frames: BridgeDownFrame[] = [];
  closed = false;

  constructor(readonly socket: Socket) {
    const decoder = new FrameDecoder();
    socket.on("data", (bytes: Buffer) => {
      for (const value of decoder.push(bytes)) this.frames.push(parseDownFrame(value));
    });
    socket.on("close", () => {
      this.closed = true;
    });
    socket.on("error", () => {});
  }

  static async connect(socketPath: string): Promise<RawPeer> {
    const socket = createConnection({ path: socketPath });
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    return new RawPeer(socket);
  }

  send(value: unknown): void {
    this.socket.write(`${JSON.stringify(value)}\n`);
  }

  async until(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
    const beganAt = Date.now();
    while (!predicate()) {
      if (Date.now() - beganAt > timeoutMs) throw new Error("Timed out waiting for the peer");
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
    }
  }
}

const attachments: BackgroundJobsAttachment[] = [];
const peers: RawPeer[] = [];

function calls(peer: RawPeer) {
  return peer.frames.filter(
    (frame): frame is Extract<BridgeDownFrame, { kind: "call" }> => frame.kind === "call",
  );
}

afterEach(async () => {
  for (const peer of peers.splice(0)) peer.socket.destroy();
  for (const attachment of attachments.splice(0)) await attachment.stop();
});

async function started() {
  const { host, recorded } = recordingHost();
  const attachment = new BackgroundJobsAttachment(host);
  attachments.push(attachment);
  await attachment.start();
  return { attachment, recorded };
}

async function peerFor(socketPath: string): Promise<RawPeer> {
  const peer = await RawPeer.connect(socketPath);
  peers.push(peer);
  return peer;
}

describe("background jobs attachment", () => {
  test("the private socket is short, 0600 inside a 0700 directory", async () => {
    const { attachment } = await started();
    const lease = attachment.issue("agent-1", "/tmp/bridge.mjs");
    const socketPath = lease.env.PASEO_BG_SOCKET;
    expect(Buffer.byteLength(socketPath)).toBeLessThan(104);
    const { stat } = await import("node:fs/promises");
    expect((await stat(socketPath)).mode & 0o777).toBe(0o600);
    expect((await stat(path.dirname(socketPath))).mode & 0o777).toBe(0o700);
    expect(lease.env.PASEO_BG_CAPABILITY).toMatch(/^[0-9a-f]{64}$/);
    expect(lease.extensionPath).toBe("/tmp/bridge.mjs");
  });

  test("a wrong capability is rejected and closed without an attached frame", async () => {
    const { attachment, recorded } = await started();
    const lease = attachment.issue("agent-1", "/tmp/bridge.mjs");
    lease.activate(async () => "session-1");
    const peer = await peerFor(lease.env.PASEO_BG_SOCKET);
    peer.send({
      kind: "attach",
      protocol: BRIDGE_PROTOCOL,
      capability: "0".repeat(64),
      sessionId: "session-1",
    });
    await peer.until(() => peer.closed);
    expect(peer.frames.map((frame) => frame.kind)).toEqual(["error"]);
    expect(recorded.connected).toEqual([]);
  });

  test("the right capability with another session is refused", async () => {
    const { attachment, recorded } = await started();
    const lease = attachment.issue("agent-1", "/tmp/bridge.mjs");
    lease.activate(async () => "session-1");
    const peer = await peerFor(lease.env.PASEO_BG_SOCKET);
    peer.send({
      kind: "attach",
      protocol: BRIDGE_PROTOCOL,
      capability: lease.env.PASEO_BG_CAPABILITY,
      sessionId: "someone-else",
    });
    await peer.until(() => peer.closed);
    expect(peer.frames.some((frame) => frame.kind === "attached")).toBe(false);
    expect(recorded.connected).toEqual([]);
  });

  test("a startup attach waits for activation, then verifies the actual session", async () => {
    const { attachment, recorded } = await started();
    const lease = attachment.issue("agent-1", "/tmp/bridge.mjs");
    const peer = await peerFor(lease.env.PASEO_BG_SOCKET);
    peer.send({
      kind: "attach",
      protocol: BRIDGE_PROTOCOL,
      capability: lease.env.PASEO_BG_CAPABILITY,
      sessionId: "session-1",
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(peer.frames).toEqual([]);
    lease.activate(async () => "session-1");
    await peer.until(() => peer.frames.length > 0);
    expect(peer.frames[0]).toEqual({
      kind: "attached",
      protocol: BRIDGE_PROTOCOL,
      runtimeId: lease.runtimeId,
    });
    expect(recorded.events).toEqual([
      `activated:${lease.runtimeId}`,
      `connected:${lease.runtimeId}`,
    ]);
  });

  test("revocation cancels a pending startup attach", async () => {
    const { attachment } = await started();
    const lease = attachment.issue("agent-1", "/tmp/bridge.mjs");
    const peer = await peerFor(lease.env.PASEO_BG_SOCKET);
    peer.send({
      kind: "attach",
      protocol: BRIDGE_PROTOCOL,
      capability: lease.env.PASEO_BG_CAPABILITY,
      sessionId: "session-1",
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    lease.revoke();
    await peer.until(() => peer.closed);
    expect(peer.frames.some((frame) => frame.kind === "attached")).toBe(false);
  });

  test("calls round-trip; revocation reports the end before disconnecting and settles calls", async () => {
    const { attachment, recorded } = await started();
    const lease = attachment.issue("agent-1", "/tmp/bridge.mjs");
    lease.activate(async () => "session-1");
    const peer = await peerFor(lease.env.PASEO_BG_SOCKET);
    peer.send({
      kind: "attach",
      protocol: BRIDGE_PROTOCOL,
      capability: lease.env.PASEO_BG_CAPABILITY,
      sessionId: "session-1",
    });
    await peer.until(() => recorded.connected.length === 1);
    const bridge = recorded.connected[0];
    if (!bridge) throw new Error("No connected bridge");
    const answered = bridge.call("list", "act-1", { limit: 5 });
    await peer.until(() => calls(peer).length === 1);
    const call = calls(peer)[0];
    if (!call) throw new Error("No call frame");
    expect(call).toMatchObject({ operation: "list", activationId: "act-1", payload: { limit: 5 } });
    peer.send({ kind: "result", callId: call.callId, ok: true, result: { tasks: [] } });
    await expect(answered).resolves.toEqual({ ok: true, result: { tasks: [] } });

    const unanswered = bridge.call("stop", "act-1", { taskId: "t" });
    await peer.until(() => calls(peer).length === 2);
    lease.revoke();
    await expect(unanswered).resolves.toMatchObject({ ok: false, error: { code: "DISCONNECTED" } });
    expect(recorded.events.slice(-2)).toEqual([
      `revoked:${lease.runtimeId}`,
      `disconnected:${lease.runtimeId}`,
    ]);
    await expect(bridge.call("list", "act-1", {})).resolves.toMatchObject({
      ok: false,
      error: { code: "DISCONNECTED" },
    });
  });

  test("a reloaded extension replaces the runtime's previous connection", async () => {
    const { attachment, recorded } = await started();
    const lease = attachment.issue("agent-1", "/tmp/bridge.mjs");
    lease.activate(async () => "session-1");
    const attach = {
      kind: "attach",
      protocol: BRIDGE_PROTOCOL,
      capability: lease.env.PASEO_BG_CAPABILITY,
      sessionId: "session-1",
    };
    const first = await peerFor(lease.env.PASEO_BG_SOCKET);
    first.send(attach);
    await first.until(() => recorded.connected.length === 1);
    const second = await peerFor(lease.env.PASEO_BG_SOCKET);
    second.send(attach);
    await second.until(() => recorded.connected.length === 2);
    await first.until(() => first.closed);
    expect(second.closed).toBe(false);
  });

  test("malformed, oversized and pre-attachment frames close the peer", async () => {
    const { attachment } = await started();
    const lease = attachment.issue("agent-1", "/tmp/bridge.mjs");
    const garbage = await peerFor(lease.env.PASEO_BG_SOCKET);
    garbage.socket.write("{not json}\n");
    await garbage.until(() => garbage.closed);
    const early = await peerFor(lease.env.PASEO_BG_SOCKET);
    early.send({ kind: "host", presence: "available" });
    await early.until(() => early.closed);
    const huge = await peerFor(lease.env.PASEO_BG_SOCKET);
    huge.socket.write("x".repeat(BRIDGE_FRAME_BYTES + 1));
    await huge.until(() => huge.closed);
  });

  test("the encoder refuses frames over the outer bound", () => {
    expect(() =>
      encodeFrame({ kind: "error", code: "X", message: "y".repeat(BRIDGE_FRAME_BYTES) }),
    ).toThrow(/byte bound/);
  });

  test("a path that cannot fit the platform bound is refused before listening", async () => {
    const { host } = recordingHost();
    const original = process.env.TMPDIR;
    const deep = await mkdtemp(path.join(tmpdir(), "x".repeat(60)));
    await chmod(deep, 0o700);
    process.env.TMPDIR = path.join(deep, "y".repeat(60));
    try {
      const { mkdir } = await import("node:fs/promises");
      await mkdir(process.env.TMPDIR, { recursive: true });
      const attachment = new BackgroundJobsAttachment(host);
      await expect(attachment.start()).rejects.toThrow(/platform bound/);
      expect(attachment.listening).toBe(false);
    } finally {
      if (original === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = original;
      await rm(deep, { recursive: true, force: true });
    }
  });
});
