import { afterEach, describe, expect, test } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import paseoBackgroundJobsBridge, {
  BackgroundJobsBridge,
  readBridgeConfig,
  type BridgeEventBus,
} from "./extension.js";
import {
  BRIDGE_MAX_IN_FLIGHT,
  BRIDGE_PROTOCOL,
  FrameDecoder,
  parseUpFrame,
  bridgeCompletion,
} from "./protocol.js";
import type { BridgeUpFrame } from "./protocol.js";

const HOST_REQUEST = "pi-background-tasks:host:request:v1";
const HOST_RESPONSE = "pi-background-tasks:host:response:v1";
const HOST_CHANGED = "pi-background-tasks:host:changed:v1";
const V1_REQUEST = "pi-background-tasks:request:v1";
const V1_RESPONSE = "pi-background-tasks:response:v1";
const CAPABILITY = "c".repeat(64);

class Bus implements BridgeEventBus {
  readonly emitted: string[] = [];
  private readonly handlers = new Map<string, Set<(data: unknown) => void>>();

  on(channel: string, handler: (data: unknown) => void): () => void {
    const set = this.handlers.get(channel) ?? new Set();
    set.add(handler);
    this.handlers.set(channel, set);
    return () => set.delete(handler);
  }

  emit(channel: string, data: unknown): void {
    this.emitted.push(channel);
    for (const handler of this.handlers.get(channel) ?? []) handler(data);
  }
}

interface HostRequest {
  request_id: string;
  operation: string;
  payload: Record<string, unknown>;
}

/** Answers the host-v1 request channel the way the package does, recording every request. */
function hostDouble(bus: Bus, answer: (request: HostRequest) => unknown | null) {
  const requests: HostRequest[] = [];
  bus.on(HOST_REQUEST, (data) => {
    if (typeof data !== "object" || data === null) return;
    const request = {
      request_id: String(Reflect.get(data, "request_id")),
      operation: String(Reflect.get(data, "operation")),
      payload: Object.fromEntries(Object.entries(Reflect.get(data, "payload") ?? {})),
    };
    requests.push(request);
    const result = answer(request);
    if (result === null) return;
    bus.emit(HOST_RESPONSE, {
      schema_version: "pi-background-tasks.host-response.v1",
      request_id: request.request_id,
      operation: request.operation,
      ok: true,
      result,
    });
  });
  return requests;
}

class FakeDaemon {
  readonly frames: BridgeUpFrame[] = [];
  socket: Socket | null = null;
  closed = false;

  constructor(readonly server: Server) {
    server.on("connection", (socket) => {
      this.socket = socket;
      const decoder = new FrameDecoder();
      socket.on("data", (bytes: Buffer) => {
        for (const value of decoder.push(bytes)) this.frames.push(parseUpFrame(value));
      });
      socket.on("close", () => {
        this.closed = true;
      });
    });
  }

  send(value: unknown): void {
    this.socket?.write(`${JSON.stringify(value)}\n`);
  }

  async until(predicate: () => boolean): Promise<void> {
    const started = Date.now();
    while (!predicate()) {
      if (Date.now() - started > 8000) throw new Error("Timed out waiting for the bridge");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

function results(daemon: FakeDaemon) {
  return daemon.frames.filter(
    (frame): frame is Extract<BridgeUpFrame, { kind: "result" }> => frame.kind === "result",
  );
}

function busy(daemon: FakeDaemon): boolean {
  return results(daemon).some((frame) => !frame.ok && frame.error.code === "BUSY");
}

async function fakeDaemon(): Promise<{ daemon: FakeDaemon; socketPath: string }> {
  const directory = await mkdtemp(path.join(tmpdir(), "paseo-bgx-"));
  const socketPath = path.join(directory, "h.sock");
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  const daemon = new FakeDaemon(server);
  cleanups.push(async () => {
    daemon.socket?.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  });
  return { daemon, socketPath };
}

function attachedBridge(bus: Bus, socketPath: string): BackgroundJobsBridge {
  const bridge = new BackgroundJobsBridge(bus, { socketPath, capability: CAPABILITY });
  cleanups.push(async () => bridge.close());
  return bridge;
}

const activation = {
  schema_version: "pi-background-tasks.host-changed.v1",
  kind: "ready",
  activationId: "act-1",
  sessionId: "session-1",
  revision: 1,
  observedAt: 1,
  counts: {
    running: 0,
    completed: 0,
    failed: 0,
    killed: 0,
    unseenCompleted: 0,
    unseenFailed: 0,
    unseenKilled: 0,
    total: 0,
  },
};

test("bridge completion admits one terminal outcome across response, timeout and close", async () => {
  const completion = bridgeCompletion<string>();
  expect(completion.finish("response")).toBe(true);
  expect(completion.finish("timeout")).toBe(false);
  expect(completion.finish("closed")).toBe(false);
  await expect(completion.promise).resolves.toBe("response");
});

describe("bridge configuration", () => {
  test("only an injected private socket and 64-hex capability enable the bridge", () => {
    expect(readBridgeConfig({})).toBeNull();
    expect(
      readBridgeConfig({ PASEO_BG_SOCKET: "relative.sock", PASEO_BG_CAPABILITY: CAPABILITY }),
    ).toBeNull();
    expect(
      readBridgeConfig({ PASEO_BG_SOCKET: "/tmp/h.sock", PASEO_BG_CAPABILITY: "short" }),
    ).toBeNull();
    expect(
      readBridgeConfig({ PASEO_BG_SOCKET: "/tmp/h.sock", PASEO_BG_CAPABILITY: CAPABILITY }),
    ).toEqual({
      socketPath: "/tmp/h.sock",
      capability: CAPABILITY,
    });
  });

  test("ordinary terminal Pi without the environment registers nothing", () => {
    const saved = process.env.PASEO_BG_CAPABILITY;
    delete process.env.PASEO_BG_CAPABILITY;
    try {
      const events: string[] = [];
      paseoBackgroundJobsBridge({
        events: new Bus(),
        on: (event) => {
          events.push(event);
        },
      });
      expect(events).toEqual([]);
    } finally {
      if (saved !== undefined) process.env.PASEO_BG_CAPABILITY = saved;
    }
  });
});

describe("bridge relay", () => {
  test("attaches with its session, then reports host presence and the cached ready frame", async () => {
    const { daemon, socketPath } = await fakeDaemon();
    const bus = new Bus();
    hostDouble(bus, (request) =>
      request.operation === "capabilities" ? { api_version: 1, operations: [] } : null,
    );
    const bridge = attachedBridge(bus, socketPath);
    bus.emit(HOST_CHANGED, activation);
    bridge.start("session-1");
    await daemon.until(() => daemon.frames.length === 1);
    expect(daemon.frames[0]).toEqual({
      kind: "attach",
      protocol: BRIDGE_PROTOCOL,
      capability: CAPABILITY,
      sessionId: "session-1",
    });
    daemon.send({ kind: "attached", protocol: BRIDGE_PROTOCOL, runtimeId: "runtime-1" });
    await daemon.until(() => daemon.frames.length === 3);
    expect(daemon.frames[1]).toEqual({ kind: "host", presence: "available" });
    expect(daemon.frames[2]).toEqual({ kind: "changed", change: activation });
    expect(bus.emitted.filter((channel) => !channel.startsWith("pi-background-tasks:"))).toEqual(
      [],
    );
  });

  test("reports an absent package as missing and a v1-only package as outdated", async () => {
    for (const [v1, expected] of [
      [false, "missing"],
      [true, "outdated"],
    ] as const) {
      const { daemon, socketPath } = await fakeDaemon();
      const bus = new Bus();
      if (v1)
        bus.on(V1_REQUEST, (data) => {
          bus.emit(V1_RESPONSE, { request_id: Reflect.get(Object(data), "request_id"), ok: false });
        });
      const bridge = attachedBridge(bus, socketPath);
      bridge.start("session-1");
      await daemon.until(() => daemon.frames.length === 1);
      daemon.send({ kind: "attached", protocol: BRIDGE_PROTOCOL, runtimeId: "runtime-1" });
      await daemon.until(() => daemon.frames.length === 2);
      expect(daemon.frames[1]).toEqual({ kind: "host", presence: expected });
    }
  }, 20_000);

  test("owns the host lease and sequence; obsolete activations are refused locally", async () => {
    const { daemon, socketPath } = await fakeDaemon();
    const bus = new Bus();
    const requests = hostDouble(bus, (request) => {
      if (request.operation === "capabilities") return { api_version: 1 };
      if (request.operation === "subscribe") return { leaseId: "lease-1", activationId: "act-1" };
      return { ok: request.operation };
    });
    const bridge = attachedBridge(bus, socketPath);
    bridge.start("session-1");
    await daemon.until(() => daemon.frames.length === 1);
    daemon.send({ kind: "attached", protocol: BRIDGE_PROTOCOL, runtimeId: "runtime-1" });
    daemon.send({
      kind: "call",
      callId: "c1",
      operation: "subscribe",
      activationId: null,
      payload: {},
    });
    await daemon.until(() => results(daemon).length === 1);
    daemon.send({
      kind: "call",
      callId: "c2",
      operation: "list",
      activationId: "act-1",
      payload: { limit: 2 },
    });
    daemon.send({
      kind: "call",
      callId: "c3",
      operation: "stop",
      activationId: "act-1",
      payload: { taskId: "t" },
    });
    daemon.send({
      kind: "call",
      callId: "c4",
      operation: "stop",
      activationId: "act-0",
      payload: { taskId: "t" },
    });
    await daemon.until(() => results(daemon).length === 4);
    const leased = requests.filter(
      (request) => request.operation === "list" || request.operation === "stop",
    );
    expect(leased.map((request) => request.payload)).toEqual([
      { limit: 2, leaseId: "lease-1", activationId: "act-1", sequence: 1 },
      { taskId: "t", leaseId: "lease-1", activationId: "act-1", sequence: 2 },
    ]);
    expect(requests.find((request) => request.operation === "subscribe")?.payload).toEqual({
      clientId: "paseo-runtime-1",
    });
    const refused = results(daemon).find((frame) => frame.callId === "c4");
    expect(refused).toMatchObject({ ok: false, error: { code: "ACTIVATION_MISMATCH" } });
  });

  test("bounds in-flight calls and closes on calls before attachment", async () => {
    const { daemon, socketPath } = await fakeDaemon();
    const bus = new Bus();
    hostDouble(bus, (request) => {
      if (request.operation === "capabilities") return { api_version: 1 };
      if (request.operation === "subscribe") return { leaseId: "lease-1", activationId: "act-1" };
      return null; // never answers: keeps calls in flight
    });
    const bridge = attachedBridge(bus, socketPath);
    bridge.start("session-1");
    await daemon.until(() => daemon.frames.length === 1);
    daemon.send({ kind: "attached", protocol: BRIDGE_PROTOCOL, runtimeId: "runtime-1" });
    daemon.send({
      kind: "call",
      callId: "s",
      operation: "subscribe",
      activationId: null,
      payload: {},
    });
    await daemon.until(() => results(daemon).length === 1);
    for (let index = 0; index <= BRIDGE_MAX_IN_FLIGHT; index += 1)
      daemon.send({
        kind: "call",
        callId: `l${index}`,
        operation: "list",
        activationId: "act-1",
        payload: {},
      });
    await daemon.until(() => busy(daemon));

    const second = await fakeDaemon();
    const early = attachedBridge(new Bus(), second.socketPath);
    early.start("session-1");
    await second.daemon.until(() => second.daemon.frames.length === 1);
    second.daemon.send({
      kind: "call",
      callId: "x",
      operation: "list",
      activationId: "a",
      payload: {},
    });
    await second.daemon.until(() => second.daemon.closed);
  });
});
