import { describe, expect, test } from "vitest";
import { SessionInboundMessageSchema, WSOutboundMessageSchema } from "../messages.js";
import { validateWSOutboundMessage } from "../validation/ws-outbound.js";

const address = {
  requestId: "req-1",
  agentId: "agent-1",
  runtimeId: "runtime-1",
  activationId: "act-1",
};
const control = { ...address, subscriptionId: "sub-1", sequence: 3 };
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
const task = {
  id: "task-1",
  name: "Build",
  command: "npm run build",
  status: "running",
  outputPath: ".pi/tasks/task-1.output",
  cwd: "/tmp/project",
  startTime: 1,
  bytesWritten: 12,
  isAgent: false,
  surviveReload: false,
  notifyOnCompletion: true,
  triggerOnCompletion: false,
};

function envelope(message: unknown) {
  return { type: "session", message };
}

describe("background jobs requests", () => {
  test.each([
    { type: "agent.background_jobs.observe.request", requestId: "r", agentId: "agent-1" },
    { type: "agent.background_jobs.list.request", ...address, cursor: "c1.x", limit: 50 },
    { type: "agent.background_jobs.detail.request", ...address, taskId: "task-1" },
    {
      type: "agent.background_jobs.logs.request",
      ...address,
      taskId: "task-1",
      maxBytes: 65536,
      tail: false,
    },
    { type: "agent.background_jobs.result.request", ...address, taskId: "task-1" },
    { type: "agent.background_jobs.stop.request", ...control, taskId: "task-1" },
    { type: "agent.background_jobs.rerun.request", ...control, taskId: "task-1" },
    { type: "agent.background_jobs.stop_all.request", ...control, taskIds: ["a", "b"] },
    { type: "agent.background_jobs.mark_seen.request", ...control, taskIds: ["a"] },
  ])("accepts $type", (message) => {
    expect(SessionInboundMessageSchema.safeParse(message).success).toBe(true);
  });

  test("requests are closed: no path, PID or command operand is accepted", () => {
    for (const extra of [{ path: "/etc/passwd" }, { pid: 1 }, { command: "rm -rf /" }]) {
      const parsed = SessionInboundMessageSchema.safeParse({
        type: "agent.background_jobs.logs.request",
        ...address,
        taskId: "task-1",
        ...extra,
      });
      expect(parsed.success).toBe(false);
    }
  });

  test("bounds pages, log windows, selections and sequences", () => {
    const rejected = [
      { type: "agent.background_jobs.list.request", ...address, limit: 51 },
      { type: "agent.background_jobs.list.request", ...address, limit: 0 },
      { type: "agent.background_jobs.logs.request", ...address, taskId: "t", maxBytes: 65537 },
      { type: "agent.background_jobs.stop_all.request", ...control, taskIds: [] },
      {
        type: "agent.background_jobs.stop_all.request",
        ...control,
        taskIds: Array.from({ length: 1001 }, (_, index) => `t${index}`),
      },
      { type: "agent.background_jobs.stop.request", ...control, sequence: 0, taskId: "t" },
      { type: "agent.background_jobs.stop.request", ...control, sequence: 1.5, taskId: "t" },
      { type: "agent.background_jobs.stop.request", ...address, taskId: "t" },
      { type: "agent.background_jobs.detail.request", ...address, taskId: "" },
    ];
    for (const message of rejected)
      expect(SessionInboundMessageSchema.safeParse(message).success, JSON.stringify(message)).toBe(
        false,
      );
  });
});

describe("background jobs responses", () => {
  const ready = {
    status: "ready",
    runtimeId: "runtime-1",
    activationId: "act-1",
    sessionId: "session-1",
    revision: 4,
    observedAt: 10,
    counts,
  };
  const messages = [
    {
      type: "agent.background_jobs.observe.response",
      payload: {
        requestId: "r",
        agentId: "agent-1",
        subscriptionId: "sub-1",
        version: 0,
        state: ready,
      },
    },
    {
      type: "agent.background_jobs.update",
      payload: {
        subscriptionId: "sub-1",
        agentId: "agent-1",
        version: 1,
        state: { status: "missing", runtimeId: "runtime-1", message: "not installed" },
      },
    },
    {
      type: "agent.background_jobs.list.response",
      payload: {
        ...address,
        result: {
          activationId: "act-1",
          sessionId: "session-1",
          revision: 4,
          observedAt: 10,
          counts,
          tasks: [
            {
              task,
              kind: "shell",
              seen: false,
              canRerun: true,
              canReadResult: false,
              truncatedFields: ["command"],
            },
          ],
          nextCursor: null,
        },
      },
    },
    {
      type: "agent.background_jobs.result.response",
      payload: {
        ...address,
        result: {
          taskId: "task-1",
          kind: "delegate",
          state: "committed",
          delivery: "inline",
          answerBytes: 5,
          answerSha256: "a".repeat(64),
          artifactPath: "/tmp/answer.md",
          text: "hello",
        },
      },
    },
    {
      type: "agent.background_jobs.stop_all.response",
      payload: {
        ...address,
        result: {
          results: [{ taskId: "a", outcome: "stopped", status: "killed" }],
          stopped: 1,
          alreadyTerminal: 0,
          notFound: 0,
          failed: 0,
        },
      },
    },
  ];

  test.each(messages)("$type passes the source schema and the generated validator", (message) => {
    expect(WSOutboundMessageSchema.safeParse(envelope(message)).success).toBe(true);
    expect(validateWSOutboundMessage(envelope(message)).success).toBe(true);
  });

  test("the generated validator rejects a corrupted state and a truncated answer", () => {
    expect(
      validateWSOutboundMessage(
        envelope({
          type: "agent.background_jobs.update",
          payload: {
            subscriptionId: "s",
            agentId: "a",
            state: { status: "initializing", runtimeId: "rt" },
          },
        }),
      ).success,
    ).toBe(false);
    expect(
      validateWSOutboundMessage(
        envelope({
          type: "agent.background_jobs.update",
          payload: { subscriptionId: "s", agentId: "a", version: 1, state: { status: "ready" } },
        }),
      ).success,
    ).toBe(false);
    expect(
      validateWSOutboundMessage(
        envelope({
          type: "agent.background_jobs.result.response",
          payload: {
            ...address,
            result: {
              taskId: "t",
              kind: "delegate",
              state: "committed",
              delivery: "inline",
              answerBytes: 1,
              answerSha256: "x",
              artifactPath: "/a",
              text: "x".repeat(49153),
            },
          },
        }),
      ).success,
    ).toBe(false);
  });

  test("server_info keeps parsing with and without the optional feature flag", () => {
    for (const features of [{}, { piBackgroundJobs: true }]) {
      const parsed = WSOutboundMessageSchema.safeParse(
        envelope({
          type: "status",
          payload: { status: "server_info", serverId: "srv", features },
        }),
      );
      expect(parsed.success).toBe(true);
    }
  });
});
