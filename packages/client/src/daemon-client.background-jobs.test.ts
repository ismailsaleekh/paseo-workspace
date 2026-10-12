import { afterEach, expect, test } from "vitest";
import { DaemonClient, DaemonConnectionError, type DaemonTransport } from "./daemon-client";

function createTransport() {
  const sent: string[] = [];
  let onMessage: (data: unknown) => void = () => {};
  let onOpen: () => void = () => {};
  let onClose: (event?: unknown) => void = () => {};
  const transport: DaemonTransport = {
    send: (data) => {
      if (typeof data === "string") sent.push(data);
    },
    close: () => {},
    onMessage: (handler) => {
      onMessage = (data) => handler(data, false);
      return () => {};
    },
    onOpen: (handler) => {
      onOpen = handler;
      return () => {};
    },
    onClose: (handler) => {
      onClose = handler;
      return () => {};
    },
    onError: () => () => {},
  };
  return {
    transport,
    sent,
    open(features: Record<string, boolean>) {
      onOpen();
      sent.length = 0;
      onMessage(
        JSON.stringify({
          type: "session",
          message: {
            type: "status",
            payload: {
              status: "server_info",
              serverId: "srv",
              hostname: null,
              version: null,
              features,
            },
          },
        }),
      );
    },
    close: () => onClose({ code: 1006, reason: "lost" }),
    receive: (message: unknown) => onMessage(JSON.stringify({ type: "session", message })),
    requests(type: string): Array<Record<string, unknown>> {
      return sent.flatMap((frame) => {
        const parsed: unknown = JSON.parse(frame);
        const message =
          typeof parsed === "object" && parsed !== null ? Reflect.get(parsed, "message") : null;
        if (typeof message !== "object" || message === null) return [];
        return Reflect.get(message, "type") === type
          ? [Object.fromEntries(Object.entries(message))]
          : [];
      });
    },
  };
}

const clients: DaemonClient[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
});

async function connected(features: Record<string, boolean>) {
  const mock = createTransport();
  const client = new DaemonClient({
    url: "ws://test",
    clientId: "bg-jobs-test",
    transportFactory: () => mock.transport,
    reconnect: { enabled: false },
  });
  clients.push(client);
  const connecting = client.connect();
  mock.open(features);
  await connecting;
  return { client, mock };
}

const counts = {
  running: 1,
  completed: 0,
  failed: 0,
  killed: 0,
  unseenCompleted: 0,
  unseenFailed: 0,
  unseenKilled: 0,
  total: 1,
};

test("an older host without the feature fails the observation instead of reporting no jobs", async () => {
  const { client, mock } = await connected({ ownedSubscriptions: true });
  const observation = client.observeBackgroundJobs("agent-1");
  await expect(observation.ready).rejects.toThrow(/Update the Paseo host/);
  expect(mock.requests("agent.background_jobs.observe.request")).toEqual([]);
});

test("observation is source-owned: the snapshot binds updates by subscription ID", async () => {
  const { client, mock } = await connected({ ownedSubscriptions: true, piBackgroundJobs: true });
  const observation = client.observeBackgroundJobs("agent-1");
  const [request] = mock.requests("agent.background_jobs.observe.request");
  expect(request).toMatchObject({ agentId: "agent-1" });
  const ready = {
    status: "ready",
    runtimeId: "rt",
    activationId: "act",
    sessionId: "s",
    revision: 1,
    observedAt: 1,
    counts,
  };
  mock.receive({
    type: "agent.background_jobs.observe.response",
    payload: {
      requestId: request?.requestId,
      agentId: "agent-1",
      subscriptionId: "sub-1",
      version: 0,
      state: ready,
    },
  });
  await expect(observation.ready).resolves.toMatchObject({ subscriptionId: "sub-1" });
  const updates: unknown[] = [];
  observation.subscribe({ snapshot: () => {}, update: (message) => updates.push(message) });
  mock.receive({
    type: "agent.background_jobs.update",
    payload: {
      subscriptionId: "sub-1",
      agentId: "agent-1",
      version: 1,
      state: { ...ready, revision: 2 },
    },
  });
  mock.receive({
    type: "agent.background_jobs.update",
    payload: {
      subscriptionId: "someone-else",
      agentId: "agent-1",
      version: 2,
      state: { ...ready, revision: 3 },
    },
  });
  expect(updates).toHaveLength(1);
});

test("a control in flight during a disconnect is an unknown outcome and is never re-sent", async () => {
  const { client, mock } = await connected({ ownedSubscriptions: true, piBackgroundJobs: true });
  const stopping = client.stopBackgroundJob({
    agentId: "agent-1",
    runtimeId: "rt",
    activationId: "act",
    subscriptionId: "sub-1",
    sequence: 7,
    taskId: "task-1",
  });
  const [request] = mock.requests("agent.background_jobs.stop.request");
  expect(request).toMatchObject({ subscriptionId: "sub-1", sequence: 7, taskId: "task-1" });
  mock.close();
  await expect(stopping).rejects.toBeInstanceOf(DaemonConnectionError);
  expect(mock.requests("agent.background_jobs.stop.request")).toHaveLength(1);
});

test("reads resolve their correlated payload and surface typed host errors", async () => {
  const { client, mock } = await connected({ ownedSubscriptions: true, piBackgroundJobs: true });
  const reading = client.readBackgroundJobLogs({
    agentId: "agent-1",
    runtimeId: "rt",
    activationId: "act",
    taskId: "task-1",
    maxBytes: 4,
  });
  const [request] = mock.requests("agent.background_jobs.logs.request");
  mock.receive({
    type: "rpc_error",
    payload: {
      requestId: request?.requestId,
      requestType: "agent.background_jobs.logs.request",
      code: "LOG_UNAVAILABLE",
      error: "output file is missing",
    },
  });
  await expect(reading).rejects.toMatchObject({ code: "LOG_UNAVAILABLE" });
});
