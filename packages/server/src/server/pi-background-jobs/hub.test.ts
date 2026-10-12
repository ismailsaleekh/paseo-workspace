import { afterEach, describe, expect, test } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  BackgroundJobsListResultSchema,
  type BackgroundJobsState,
} from "@getpaseo/protocol/pi-background-jobs/rpc-schemas";
import {
  BackgroundJobsBridge,
  type BridgeEventBus,
} from "../agent/providers/pi/background-jobs-bridge/extension.js";
import { BackgroundJobsFailure, PiBackgroundJobsHub } from "./hub.js";

const HOST_REQUEST = "pi-background-tasks:host:request:v1";
const HOST_RESPONSE = "pi-background-tasks:host:response:v1";
const HOST_CHANGED = "pi-background-tasks:host:changed:v1";
const silent = { warn: () => {}, error: () => {} };

class Bus implements BridgeEventBus {
  private readonly handlers = new Map<string, Set<(data: unknown) => void>>();
  on(channel: string, handler: (data: unknown) => void): () => void {
    const set = this.handlers.get(channel) ?? new Set();
    set.add(handler);
    this.handlers.set(channel, set);
    return () => set.delete(handler);
  }
  emit(channel: string, data: unknown): void {
    for (const handler of this.handlers.get(channel) ?? []) handler(data);
  }
}

interface Task {
  id: string;
  status: "running" | "killed";
}

/** A small stand-in for the package's host-v1 service: leases, counts and change frames. */
class HostDouble {
  readonly operations: string[] = [];
  readonly tasks: Task[] = [{ id: "task-1", status: "running" }];
  activationId = "act-1";
  revision = 1;
  leases = 0;
  refuse = false;

  constructor(
    private readonly bus: Bus,
    private readonly sessionId: string,
  ) {
    bus.on(HOST_REQUEST, (data) => this.handle(data));
  }

  counts() {
    const running = this.tasks.filter((task) => task.status === "running").length;
    const killed = this.tasks.length - running;
    return {
      running,
      completed: 0,
      failed: 0,
      killed,
      unseenCompleted: 0,
      unseenFailed: 0,
      unseenKilled: killed,
      total: this.tasks.length,
    };
  }

  announce(kind: "ready" | "changed" | "closed", revision = this.revision): void {
    this.bus.emit(HOST_CHANGED, {
      schema_version: "pi-background-tasks.host-changed.v1",
      kind,
      activationId: this.activationId,
      sessionId: this.sessionId,
      revision,
      observedAt: Date.now(),
      counts: this.counts(),
    });
  }

  private reply(requestId: string, operation: string, result: unknown): void {
    this.bus.emit(HOST_RESPONSE, {
      schema_version: "pi-background-tasks.host-response.v1",
      request_id: requestId,
      operation,
      ok: true,
      result,
    });
  }

  private facts() {
    return {
      activationId: this.activationId,
      sessionId: this.sessionId,
      revision: this.revision,
      observedAt: Date.now(),
      counts: this.counts(),
    };
  }

  private view(task: Task) {
    return {
      task: {
        id: task.id,
        command: "sleep 90",
        status: task.status,
        outputPath: `.pi/tasks/${task.id}.output`,
        cwd: "/tmp/project",
        startTime: 1,
        bytesWritten: 0,
        isAgent: false,
        surviveReload: false,
        notified: false,
        notifyOnCompletion: false,
        triggerOnCompletion: false,
        shellPolicy: { shell: "/bin/sh" },
      },
      kind: "shell",
      seen: false,
      canRerun: true,
      canReadResult: false,
      truncatedFields: [],
    };
  }

  private handle(data: unknown): void {
    const requestId = String(Reflect.get(Object(data), "request_id"));
    const operation = String(Reflect.get(Object(data), "operation"));
    this.operations.push(operation);
    switch (operation) {
      case "capabilities":
        this.reply(requestId, operation, { api_version: 1 });
        return;
      case "subscribe":
        if (this.refuse) {
          this.bus.emit(HOST_RESPONSE, {
            schema_version: "pi-background-tasks.host-response.v1",
            request_id: requestId,
            operation,
            ok: false,
            error: { code: "LEASE_LIMIT", message: "at most 8 leases" },
          });
          return;
        }
        this.leases = 1;
        this.reply(requestId, operation, { leaseId: "lease-1", ...this.facts() });
        return;
      case "unsubscribe":
        this.leases = 0;
        this.reply(requestId, operation, { leaseId: "lease-1", released: true });
        return;
      case "list":
        this.reply(requestId, operation, {
          ...this.facts(),
          tasks: this.tasks.map((task) => this.view(task)),
          nextCursor: null,
        });
        return;
      case "stop": {
        const task = this.tasks.find((entry) => entry.id === "task-1");
        if (task) task.status = "killed";
        this.revision += 1;
        if (this.leases > 0) this.announce("changed");
        this.reply(requestId, operation, {
          task: this.view(this.tasks[0] ?? { id: "x", status: "killed" }).task,
          alreadyTerminal: false,
        });
        return;
      }
    }
  }
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

async function startedHub(): Promise<PiBackgroundJobsHub> {
  const root = await mkdtemp(path.join(tmpdir(), "paseo-bg-hub-"));
  const moduleFile = path.join(root, "dist/pi-background-jobs/hub.js");
  const bundle = path.join(
    root,
    "dist/agent/providers/pi/background-jobs-bridge/extension.bundle.mjs",
  );
  await mkdir(path.dirname(moduleFile), { recursive: true });
  await mkdir(path.dirname(bundle), { recursive: true });
  await writeFile(moduleFile, "");
  await writeFile(bundle, "export default function () {}\n");
  const hub = new PiBackgroundJobsHub({
    paseoHome: path.join(root, "home"),
    logger: silent,
    moduleUrl: pathToFileURL(path.join(root, "dist/pi-background-jobs/artifact.js")).href,
    describeAgent: (agentId) => (agentId === "agent-1" ? { kind: "pi" } : { kind: "unknown" }),
  });
  await hub.start();
  cleanups.push(async () => {
    await hub.stop();
    await rm(root, { recursive: true, force: true });
  });
  return hub;
}

function observer() {
  const states: BackgroundJobsState[] = [];
  return {
    states,
    listener: (state: BackgroundJobsState) => states.push(state),
    async until(predicate: (state: BackgroundJobsState) => boolean): Promise<BackgroundJobsState> {
      const started = Date.now();
      for (;;) {
        const match = states.find(predicate);
        if (match) return match;
        if (Date.now() - started > 8000)
          throw new Error(`No matching state in ${JSON.stringify(states)}`);
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    },
  };
}

/** One Pi runtime: lease issued, activated after get_state, bridge attached over the real socket. */
function launch(hub: PiBackgroundJobsHub, sessionId = "session-1") {
  const lease = hub.issue("agent-1");
  if (!lease) throw new Error("The hub issued no lease");
  const bus = new Bus();
  const host = new HostDouble(bus, sessionId);
  const bridge = new BackgroundJobsBridge(bus, {
    socketPath: lease.env.PASEO_BG_SOCKET,
    capability: lease.env.PASEO_BG_CAPABILITY,
  });
  cleanups.push(async () => bridge.close());
  lease.activate(async () => sessionId);
  host.announce("ready");
  bridge.start(sessionId);
  return { lease, host, bridge };
}

describe("PiBackgroundJobsHub", () => {
  test("a refused lease is a visible error, never a hot retry; new demand or a fresh ready asks once", async () => {
    const hub = await startedHub();
    const { host } = launch(hub);
    host.refuse = true;
    const subscribes = () =>
      host.operations.filter((operation) => operation === "subscribe").length;
    const watch = observer();
    hub.observe("agent-1", watch.listener);
    const refused = await watch.until((state) => state.status === "error");
    expect(refused).toMatchObject({ code: "LEASE_LIMIT" });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(subscribes()).toBe(1);
    hub.observe("agent-1", () => {});
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(subscribes()).toBe(2);
    host.refuse = false;
    host.activationId = "act-2";
    host.announce("ready");
    await watch.until((state) => state.status === "ready" && state.activationId === "act-2");
    await watch.until(() => host.leases === 1);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(subscribes()).toBe(3);
  });
  test("an agent without a runtime is explicitly unavailable and is never started", async () => {
    const hub = await startedHub();
    const observation = hub.observe("unknown-agent", () => {});
    expect(observation.state).toMatchObject({ status: "unavailable", reason: "unknown_agent" });
    expect(hub.observe("agent-1", () => {}).state).toMatchObject({
      status: "unavailable",
      reason: "not_running",
    });
  });

  test("a hub that is not started issues no capability, so ordinary Pi launches are unaffected", () => {
    const hub = new PiBackgroundJobsHub({
      paseoHome: "/nonexistent",
      logger: silent,
      describeAgent: () => ({ kind: "pi" }),
    });
    expect(hub.issue("agent-1")).toBeUndefined();
  });

  test("holds the host lease only while observed and reaches ready through the real socket", async () => {
    const hub = await startedHub();
    const { host } = launch(hub);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(host.operations).toEqual(["capabilities"]);
    const watch = observer();
    const observation = hub.observe("agent-1", watch.listener);
    const ready = await watch.until((state) => state.status === "ready");
    expect(ready).toMatchObject({ activationId: "act-1", sessionId: "session-1" });
    await watch.until(() => host.leases === 1);
    observation.release();
    const started = Date.now();
    while (host.leases !== 0 && Date.now() - started < 5000)
      await new Promise((resolve) => setTimeout(resolve, 10));
    expect(host.operations).toContain("unsubscribe");
  });

  test("validates and narrows results, and fences stale bindings before any host call", async () => {
    const hub = await startedHub();
    const { host, lease } = launch(hub);
    const watch = observer();
    hub.observe("agent-1", watch.listener);
    await watch.until((state) => state.status === "ready");
    const binding = { agentId: "agent-1", runtimeId: lease.runtimeId, activationId: "act-1" };
    const list = await hub.invoke(binding, "list", {}, BackgroundJobsListResultSchema);
    expect(list.tasks[0]?.task.id).toBe("task-1");
    expect(list.tasks[0]?.task).not.toHaveProperty("shellPolicy");
    expect(list.tasks[0]?.task).not.toHaveProperty("notified");
    const before = host.operations.length;
    for (const stale of [
      { ...binding, runtimeId: "other-runtime" },
      { ...binding, activationId: "other-activation" },
      { ...binding, agentId: "unknown-agent" },
    ]) {
      await expect(
        hub.invoke(stale, "list", {}, BackgroundJobsListResultSchema),
      ).rejects.toBeInstanceOf(BackgroundJobsFailure);
      expect(() => hub.assertBinding(stale)).toThrow(BackgroundJobsFailure);
    }
    expect(host.operations.length).toBe(before);
  });

  test("applies newer change frames and ignores older revisions", async () => {
    const hub = await startedHub();
    const { host } = launch(hub);
    const watch = observer();
    hub.observe("agent-1", watch.listener);
    await watch.until((state) => state.status === "ready");
    await watch.until(() => host.leases === 1);
    host.tasks.push({ id: "task-2", status: "running" });
    host.announce("changed", 5);
    await watch.until((state) => state.status === "ready" && state.revision === 5);
    host.tasks.pop();
    host.announce("changed", 3);
    await new Promise((resolve) => setTimeout(resolve, 150));
    const last = watch.states.at(-1);
    expect(last).toMatchObject({ status: "ready", revision: 5, counts: { running: 2 } });
  });

  test("an observer outlives runtime replacement: ended, then a fresh ready runtime", async () => {
    const hub = await startedHub();
    const first = launch(hub);
    const watch = observer();
    hub.observe("agent-1", watch.listener);
    await watch.until((state) => state.status === "ready");
    first.lease.revoke();
    await watch.until((state) => state.status === "ended");
    const second = launch(hub, "session-2");
    const fresh = await watch.until(
      (state) => state.status === "ready" && state.runtimeId === second.lease.runtimeId,
    );
    expect(fresh).toMatchObject({ sessionId: "session-2" });
    expect(second.lease.runtimeId).not.toBe(first.lease.runtimeId);
    expect(watch.states.some((state) => state.status === "error")).toBe(false);
  });
});
