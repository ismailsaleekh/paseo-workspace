// Supervisor-owned narrow regression: real client, browser-compliant transport contract, no network/model.
import { afterEach, expect, test, vi } from "vitest";
import { DaemonClient } from "../../packages/client/src/daemon-client.ts";

const clients = [];
const logger = { debug() {}, info() {}, warn() {}, error() {} };

class BrowserPort {
  sent = [];
  closeCalls = [];
  rejectedCloses = [];
  closed = false;
  messageHandler = () => {};
  openHandler = () => {};

  transport = {
    send: (bytes) => {
      if (this.closed) throw new Error("Socket closed");
      const frame = JSON.parse(bytes);
      this.sent.push(frame);
      if (frame.type === "ping") this.deliver({ type: "pong" });
      const request = frame.message;
      if (request?.type === "ping")
        this.reply({ type: "pong", payload: { ...request, serverReceivedAt: 1, serverSentAt: 1 } });
      if (request?.type === "send_agent_message_request")
        this.reply({
          type: "send_agent_message_response",
          payload: {
            requestId: request.requestId,
            agentId: request.agentId,
            accepted: true,
            error: null,
          },
        });
      if (request?.type === "refresh_agent_request")
        this.refuse(request, "READONLY_RELOAD_WITNESS", "Reload reached the server");
      if (request?.type === "subscription.release.request")
        this.reply({
          type: "subscription.release.response",
          payload: {
            requestId: request.requestId,
            subscriptionId: request.subscriptionId,
            released: true,
          },
        });
    },
    close: (code, reason) => {
      // WHATWG WebSocket.close accepts only1000 or application codes3000..4999.
      if (code !== undefined && code !== 1000 && !(code >= 3000 && code <= 4999)) {
        this.rejectedCloses.push(code);
        throw new DOMException("Invalid browser close code", "InvalidAccessError");
      }
      this.closeCalls.push({ code, reason });
      this.closed = true;
    },
    onOpen: (handler) => {
      this.openHandler = handler;
      return () => {
        this.openHandler = () => {};
      };
    },
    onMessage: (handler) => {
      this.messageHandler = (data) => handler(data, false);
      return () => {
        this.messageHandler = () => {};
      };
    },
    onClose: () => () => {},
    onError: () => () => {},
  };

  deliver(frame) {
    this.messageHandler(JSON.stringify(frame));
  }
  reply(message) {
    this.deliver({ type: "session", message });
  }
  requests(type) {
    return this.sent.flatMap((frame) => (frame.message?.type === type ? [frame.message] : []));
  }
  refuse(request, code = "UNKNOWN_AGENT", error = "Visuals require a managed Pi agent") {
    this.reply({
      type: "rpc_error",
      payload: { requestId: request.requestId, requestType: request.type, code, error },
    });
  }
  open(features = { piWorkspace: true, ownedSubscriptions: true }) {
    this.openHandler();
    this.reply({
      type: "status",
      payload: {
        status: "server_info",
        serverId: "visual-recovery-test",
        hostname: null,
        version: null,
        features,
      },
    });
  }
}

async function connected({ reconnect = false, features } = {}) {
  const ports = [];
  const client = new DaemonClient({
    url: "ws://no-network-fixture",
    clientId: "visual-recovery-oracle",
    logger,
    reconnect: { enabled: reconnect, baseDelayMs: 100, maxDelayMs: 100 },
    transportFactory: () => {
      const port = new BrowserPort();
      ports.push(port);
      return port.transport;
    },
  });
  clients.push(client);
  const ready = client.connect();
  ports[0].open(features);
  await ready;
  return { client, ports };
}

async function normalRequestsWork(client, port) {
  await client.sendAgentMessage("agent", "in-memory fixture only");
  expect(port.requests("send_agent_message_request")).toHaveLength(1);
  await expect(client.refreshAgent("agent")).rejects.toThrow("Reload reached the server");
  expect(port.requests("refresh_agent_request")).toHaveLength(1);
}

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  vi.useRealTimers();
});

test("explicit visual refusal stays local: Send and Reload still use the healthy connection", async () => {
  const { client, ports } = await connected();
  const port = ports[0];
  const observation = client.observePiWorkspace("agent", undefined, "electron");
  const rejected = observation.ready.catch((error) => error);
  const request = port.requests("pi_workspace.observe.request")[0];
  expect(request).toBeDefined();
  port.refuse(request);
  expect((await rejected).message).toContain("Visuals require a managed Pi agent");
  await Promise.resolve();
  expect(port.rejectedCloses).toEqual([]);
  expect(port.closeCalls).toEqual([]);
  expect(client.getConnectionState().status).toBe("connected");
  await normalRequestsWork(client, port);
  expect(port.requests("pi_workspace.observe.request")).toHaveLength(1);
});

test("unknown bootstrap outcome closes browser-safely and uses the existing reconnect lifecycle", async () => {
  vi.useFakeTimers();
  const { client, ports } = await connected({ reconnect: true });
  const first = ports[0];
  const observation = client.observePiWorkspace("agent", undefined, "electron");
  const rejected = observation.ready.catch((error) => error);
  await vi.advanceTimersByTimeAsync(60001);
  expect(await rejected).toBeInstanceOf(Error);
  expect(first.requests("pi_workspace.observe.request")).toHaveLength(1);
  expect(first.rejectedCloses).toEqual([]);
  expect(first.closeCalls).toHaveLength(1);
  expect(first.closed).toBe(true);
  expect(client.getConnectionState().status).toBe("disconnected");
  await vi.advanceTimersByTimeAsync(100);
  expect(ports).toHaveLength(2);
  ports[1].open();
  expect(client.getConnectionState().status).toBe("connected");
  await normalRequestsWork(client, ports[1]);
  expect(ports[1].requests("pi_workspace.observe.request")).toHaveLength(0);
});

test("unknown bootstrap outcome is honestly disconnected when automatic reconnect is disabled", async () => {
  vi.useFakeTimers();
  const { client, ports } = await connected();
  const observation = client.observePiWorkspace("agent", undefined, "electron");
  const rejected = observation.ready.catch((error) => error);
  await vi.advanceTimersByTimeAsync(60001);
  expect(await rejected).toBeInstanceOf(Error);
  expect(ports[0].rejectedCloses).toEqual([]);
  expect(ports[0].closed).toBe(true);
  expect(client.getConnectionState().status).toBe("disconnected");
  await expect(client.sendAgentMessage("agent", "not sent")).rejects.toThrow(
    "status: disconnected",
  );
  expect(ports[0].requests("send_agent_message_request")).toHaveLength(0);
  await vi.advanceTimersByTimeAsync(500);
  expect(ports).toHaveLength(1);
});

test("missing feature refuses locally without transport loss or reconnect loops", async () => {
  const { client, ports } = await connected({ features: { ownedSubscriptions: true } });
  const observation = client.observePiWorkspace("agent", undefined, "electron");
  await expect(observation.ready).rejects.toThrow("Update the Paseo host");
  expect(ports[0].requests("pi_workspace.observe.request")).toHaveLength(0);
  expect(ports[0].closeCalls).toHaveLength(0);
  expect(ports[0].rejectedCloses).toHaveLength(0);
  await normalRequestsWork(client, ports[0]);
});
