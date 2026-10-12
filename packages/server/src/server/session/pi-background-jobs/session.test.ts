import { describe, expect, test } from "vitest";
import type { z } from "zod";
import type { BackgroundJobsState } from "@getpaseo/protocol/pi-background-jobs/rpc-schemas";
import type { SessionInboundMessage, SessionOutboundMessage } from "../../messages.js";
import { SessionDelivery } from "../owned-subscriptions/index.js";
import {
  BackgroundJobsFailure,
  type BackgroundJobsBinding,
  type BackgroundJobsOperation,
} from "../../pi-background-jobs/hub.js";
import { BackgroundJobsSession, type BackgroundJobsHubPort } from "./session.js";

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
const READY: BackgroundJobsState = {
  status: "ready",
  runtimeId: "runtime-1",
  activationId: "act-1",
  sessionId: "session-1",
  revision: 1,
  observedAt: 1,
  counts,
};
const job = {
  id: "task-1",
  command: "sleep 90",
  status: "running",
  outputPath: ".pi/tasks/task-1.output",
  cwd: "/tmp",
  startTime: 1,
  bytesWritten: 0,
  isAgent: false,
  surviveReload: false,
  notifyOnCompletion: false,
  triggerOnCompletion: false,
};

/** Records host calls; the session's own ownership and replay rules are what is under test. */
class HubPort implements BackgroundJobsHubPort {
  readonly calls: Array<{ operation: BackgroundJobsOperation; payload: Record<string, unknown> }> =
    [];
  readonly listeners = new Set<(state: BackgroundJobsState) => void>();
  current = { runtimeId: "runtime-1", activationId: "act-1" };
  released = 0;
  gate: Promise<void> = Promise.resolve();

  observe(_agentId: string, listener: (state: BackgroundJobsState) => void) {
    this.listeners.add(listener);
    return {
      state: READY,
      release: () => {
        this.released += 1;
        this.listeners.delete(listener);
      },
    };
  }

  assertBinding(binding: BackgroundJobsBinding): void {
    if (
      binding.runtimeId !== this.current.runtimeId ||
      binding.activationId !== this.current.activationId
    )
      throw new BackgroundJobsFailure("STALE_RUNTIME", "stale");
  }

  async invoke<S extends z.ZodType>(
    binding: BackgroundJobsBinding,
    operation: BackgroundJobsOperation,
    payload: Record<string, unknown>,
    schema: S,
  ): Promise<z.output<S>> {
    this.assertBinding(binding);
    this.calls.push({ operation, payload });
    await this.gate;
    const results: Record<string, unknown> = {
      rerun: { sourceTaskId: "task-1", task: { ...job, id: `task-${this.calls.length + 1}` } },
      stop: { task: { ...job, status: "killed" }, alreadyTerminal: false },
      detail: {
        task: {
          task: job,
          kind: "shell",
          seen: false,
          canRerun: true,
          canReadResult: false,
          truncatedFields: [],
        },
      },
      stop_all: { results: [], stopped: 0, alreadyTerminal: 0, notFound: 0, failed: 0 },
    };
    return schema.parse(results[operation]);
  }
}

function harness() {
  const sent: Array<{ source: object; message: SessionOutboundMessage }> = [];
  const delivery = new SessionDelivery((source, message) => sent.push({ source, message }));
  const hub = new HubPort();
  const session = new BackgroundJobsSession({
    hub,
    delivery,
    reply: (message) => {
      if (!delivery.reply(message)) throw new Error(`Unroutable reply ${message.type}`);
    },
  });
  const a = {};
  const b = {};
  delivery.attach(a, true);
  delivery.attach(b, true);
  const send = (source: object, message: SessionInboundMessage) =>
    delivery.request(source, message, async () => {
      const handled = session.handle(message);
      if (!handled) throw new Error(`Unhandled ${message.type}`);
      await handled;
    });
  const to = (source: object) =>
    sent.filter((entry) => entry.source === source).map((entry) => entry.message);
  return { sent, delivery, hub, session, a, b, send, to };
}

async function observe(h: ReturnType<typeof harness>, source: object, requestId = "observe-1") {
  await h.send(source, {
    type: "agent.background_jobs.observe.request",
    requestId,
    agentId: "agent-1",
  });
  const response = h
    .to(source)
    .find((message) => message.type === "agent.background_jobs.observe.response");
  if (!response || response.type !== "agent.background_jobs.observe.response")
    throw new Error("No observe response");
  return response.payload.subscriptionId;
}

const address = { agentId: "agent-1", runtimeId: "runtime-1", activationId: "act-1" };

function errorCodes(messages: SessionOutboundMessage[]): Array<string | undefined> {
  return messages.flatMap((message) =>
    message.type === "rpc_error" ? [message.payload.code] : [],
  );
}

describe("BackgroundJobsSession", () => {
  test("observation replies first, then routes updates only to the owning source", async () => {
    const h = harness();
    const subscriptionId = await observe(h, h.a);
    for (const listener of h.hub.listeners) listener({ ...READY, revision: 2 });
    const updates = h.to(h.a).filter((message) => message.type === "agent.background_jobs.update");
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({
      payload: { subscriptionId, version: 1, state: { revision: 2 } },
    });
    expect(h.to(h.b)).toEqual([]);
  });

  test("a retained observation keeps one generation's ledger and refuses older generations", async () => {
    const h = harness();
    const subscriptionId = await observe(h, h.a);
    const control = (runtimeId: string, requestId: string) =>
      h.send(h.a, {
        type: "agent.background_jobs.stop.request",
        requestId,
        agentId: "agent-1",
        runtimeId,
        activationId: `act-${runtimeId}`,
        subscriptionId,
        sequence: 1,
        taskId: "task-1",
      });
    for (let generation = 2; generation <= 41; generation += 1) {
      const runtimeId = `runtime-${generation}`;
      h.hub.current = { runtimeId, activationId: `act-${runtimeId}` };
      for (const listener of h.hub.listeners)
        listener({ ...READY, runtimeId, activationId: `act-${runtimeId}`, revision: generation });
      await control(runtimeId, `stop-${generation}`);
      expect(h.session.replayScopeCount).toBe(1);
    }
    const versions = h
      .to(h.a)
      .flatMap((message) =>
        message.type === "agent.background_jobs.update" ? [message.payload.version] : [],
      );
    expect(versions).toEqual(Array.from({ length: 40 }, (_, index) => index + 1));
    const before = h.hub.calls.length;
    await control("runtime-2", "stale");
    expect(errorCodes(h.to(h.a)).at(-1)).toBe("STALE_RUNTIME");
    expect(h.hub.calls).toHaveLength(before);
  });

  test("reads require an observation from the same physical source", async () => {
    const h = harness();
    await observe(h, h.a);
    await h.send(h.b, {
      type: "agent.background_jobs.detail.request",
      requestId: "d1",
      ...address,
      taskId: "task-1",
    });
    expect(errorCodes(h.to(h.b))).toEqual(["NOT_OBSERVED"]);
    await h.send(h.a, {
      type: "agent.background_jobs.detail.request",
      requestId: "d2",
      ...address,
      taskId: "task-1",
    });
    expect(
      h.to(h.a).some((message) => message.type === "agent.background_jobs.detail.response"),
    ).toBe(true);
  });

  test("a sibling source with the same logical client cannot use another source's subscription", async () => {
    const h = harness();
    const subscriptionId = await observe(h, h.a);
    await observe(h, h.b, "observe-2");
    await h.send(h.b, {
      type: "agent.background_jobs.stop.request",
      requestId: "s1",
      ...address,
      subscriptionId,
      sequence: 1,
      taskId: "task-1",
    });
    expect(errorCodes(h.to(h.b))).toEqual(["FOREIGN_SUBSCRIPTION"]);
    expect(h.hub.calls).toEqual([]);
  });

  test("repeated controls execute once; an evicted sequence is stale", async () => {
    const h = harness();
    const subscriptionId = await observe(h, h.a);
    const rerun = {
      type: "agent.background_jobs.rerun.request" as const,
      ...address,
      subscriptionId,
      sequence: 1,
      taskId: "task-1",
    };
    let open: () => void = () => {};
    h.hub.gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const first = h.send(h.a, { ...rerun, requestId: "r1" });
    const second = h.send(h.a, { ...rerun, requestId: "r2" });
    open();
    await Promise.all([first, second]);
    const responses = h
      .to(h.a)
      .filter((message) => message.type === "agent.background_jobs.rerun.response");
    expect(responses.map((message) => message.payload.requestId)).toEqual(["r1", "r2"]);
    expect(h.hub.calls.filter((call) => call.operation === "rerun")).toHaveLength(1);
    for (let sequence = 2; sequence <= 70; sequence += 1)
      await h.send(h.a, {
        type: "agent.background_jobs.stop.request",
        requestId: `s${sequence}`,
        ...address,
        subscriptionId,
        sequence,
        taskId: "task-1",
      });
    await h.send(h.a, { ...rerun, requestId: "r3" });
    expect(errorCodes(h.to(h.a)).at(-1)).toBe("STALE_REQUEST");
    expect(h.hub.calls.filter((call) => call.operation === "rerun")).toHaveLength(1);
  });

  test("a stale runtime is refused before any host call", async () => {
    const h = harness();
    const subscriptionId = await observe(h, h.a);
    h.hub.current = { runtimeId: "runtime-2", activationId: "act-2" };
    await h.send(h.a, {
      type: "agent.background_jobs.stop.request",
      requestId: "s1",
      ...address,
      subscriptionId,
      sequence: 1,
      taskId: "task-1",
    });
    expect(errorCodes(h.to(h.a))).toEqual(["STALE_RUNTIME"]);
    expect(h.hub.calls).toEqual([]);
  });

  test("duplicate task IDs are refused", async () => {
    const h = harness();
    const subscriptionId = await observe(h, h.a);
    await h.send(h.a, {
      type: "agent.background_jobs.stop_all.request",
      requestId: "x",
      ...address,
      subscriptionId,
      sequence: 1,
      taskIds: ["a", "a"],
    });
    expect(errorCodes(h.to(h.a))).toEqual(["INVALID_REQUEST"]);
    expect(h.hub.calls).toEqual([]);
  });

  test("a released subscription loses authority and frees its observation", async () => {
    const h = harness();
    const subscriptionId = await observe(h, h.a);
    await h.delivery.request(
      h.a,
      { type: "subscription.release.request", requestId: "rel", subscriptionId },
      () => h.delivery.release(subscriptionId),
    );
    expect(h.hub.released).toBe(1);
    expect(h.session.subscriptionCount).toBe(0);
    await h.send(h.a, {
      type: "agent.background_jobs.stop.request",
      requestId: "s1",
      ...address,
      subscriptionId,
      sequence: 1,
      taskId: "task-1",
    });
    expect(errorCodes(h.to(h.a))).toEqual(["FOREIGN_SUBSCRIPTION"]);
  });

  test("a legacy source cannot observe", async () => {
    const h = harness();
    const legacy = {};
    h.delivery.attach(legacy, false);
    await h.send(legacy, {
      type: "agent.background_jobs.observe.request",
      requestId: "o",
      agentId: "agent-1",
    });
    expect(errorCodes(h.to(legacy))).toEqual(["UNSUPPORTED_CLIENT"]);
  });
});
