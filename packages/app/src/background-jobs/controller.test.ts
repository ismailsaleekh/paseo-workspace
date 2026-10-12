import { describe, expect, test } from "vitest";
import { DaemonConnectionError } from "@getpaseo/client/internal/daemon-client";
import type {
  BackgroundJob,
  BackgroundJobView,
  BackgroundJobsState,
} from "@getpaseo/protocol/pi-background-jobs/rpc-schemas";
import { isTrackVisible, pillSegments } from "./view-model";
import {
  BackgroundJobsController,
  type BackgroundJobsTransport,
  type ConfirmRequest,
} from "./controller";

type Observation = ReturnType<BackgroundJobsTransport["observeBackgroundJobs"]>;
type Observer = Parameters<Observation["subscribe"]>[0];

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

function readyState(runtimeId = "rt-1", revision = 1): BackgroundJobsState {
  return {
    status: "ready",
    runtimeId,
    activationId: `act-${runtimeId}`,
    sessionId: "session",
    revision,
    observedAt: 1,
    counts,
  };
}

function task(id: string, status: BackgroundJob["status"] = "running"): BackgroundJob {
  return {
    id,
    command: "sleep 90",
    status,
    outputPath: `.pi/tasks/${id}.output`,
    cwd: "/tmp",
    startTime: 1,
    bytesWritten: 0,
    isAgent: false,
    surviveReload: false,
    notifyOnCompletion: false,
    triggerOnCompletion: false,
  };
}

function view(job: BackgroundJob, seen = false): BackgroundJobView {
  return {
    task: job,
    kind: "shell",
    seen,
    canRerun: true,
    canReadResult: false,
    truncatedFields: [],
  };
}

function deferred<T>() {
  const handle: { resolve: (value: T) => void; reject: (error: unknown) => void } = {
    resolve: () => {},
    reject: () => {},
  };
  const promise = new Promise<T>((resolve, reject) => {
    handle.resolve = resolve;
    handle.reject = reject;
  });
  return {
    promise,
    resolve: (value: T) => handle.resolve(value),
    reject: (e: unknown) => handle.reject(e),
  };
}

/** A daemon client double: it records calls and lets each test settle them deliberately. */
class FakeJobsClient implements BackgroundJobsTransport {
  observer: Observer | null = null;
  tasks: BackgroundJobView[] = [view(task("a")), view(task("b", "completed"))];
  readonly calls: Array<{ method: string; input: Record<string, unknown> }> = [];
  logs = deferred<void>();
  logsFail: unknown = null;
  stopOutcome: unknown = null;
  subscriptionId = "sub-1";
  version = 0;

  observeBackgroundJobs = (): Observation => {
    const currentId = () => this.subscriptionId;
    return {
      get subscriptionId() {
        return currentId();
      },
      ready: new Promise(() => {}),
      subscribe: (observer) => {
        this.observer = observer;
        return () => {};
      },
      release: async () => {},
    };
  };

  /** The next publication of the current observation: its snapshot first, then updates. */
  emit(state: BackgroundJobsState): void {
    const version = this.version;
    this.version += 1;
    this.publish(this.subscriptionId, version, state);
  }

  /** Delivers one publication exactly as given, to model delayed or reordered frames. */
  publish(subscriptionId: string, version: number, state: BackgroundJobsState): void {
    if (version === 0) {
      this.observer?.snapshot({
        requestId: "r",
        agentId: "agent-1",
        subscriptionId,
        version,
        state,
      });
      return;
    }
    this.observer?.update({
      type: "agent.background_jobs.update",
      payload: { subscriptionId, agentId: "agent-1", version, state },
    });
  }

  /** A reconnect: the observation is restored under a new subscription ID and version scope. */
  restore(subscriptionId: string): void {
    this.subscriptionId = subscriptionId;
    this.version = 0;
  }

  private record(method: string, input: object) {
    this.calls.push({ method, input: Object.fromEntries(Object.entries(input)) });
  }

  private result<T>(
    input: { agentId: string; runtimeId: string; activationId: string },
    result: T,
  ) {
    return { requestId: "r", ...input, result };
  }

  listBackgroundJobs: BackgroundJobsTransport["listBackgroundJobs"] = async (input) => {
    this.record("list", input);
    const start = input.cursor ? Number(input.cursor) : 0;
    const end = start + 50;
    return this.result(input, {
      activationId: input.activationId,
      sessionId: "session",
      revision: 1,
      observedAt: 1,
      counts,
      tasks: this.tasks.slice(start, end),
      nextCursor: end < this.tasks.length ? String(end) : null,
    });
  };

  getBackgroundJob: BackgroundJobsTransport["getBackgroundJob"] = async (input) => {
    this.record("detail", input);
    const found = this.tasks.find((entry) => entry.task.id === input.taskId);
    if (!found) throw new Error("NOT_FOUND");
    return this.result(input, { task: found });
  };

  readBackgroundJobLogs: BackgroundJobsTransport["readBackgroundJobLogs"] = async (input) => {
    this.record("logs", input);
    await this.logs.promise;
    if (this.logsFail) throw this.logsFail;
    return this.result(input, {
      task: task(input.taskId),
      path: "/tmp/out",
      text: `output of ${input.taskId}`,
      tail: true,
      maxBytes: 32768,
      bytesRead: 10,
      totalBytes: 10,
      windowStart: 0,
      windowEnd: 10,
      truncated: false,
      bytesWritten: 10,
    });
  };

  readBackgroundJobResult: BackgroundJobsTransport["readBackgroundJobResult"] = async (input) => {
    this.record("result", input);
    throw Object.assign(new Error("tampered requestType=x code=RESULT_INVALID"), {
      code: "RESULT_INVALID",
    });
  };

  stopBackgroundJob: BackgroundJobsTransport["stopBackgroundJob"] = async (input) => {
    this.record("stop", input);
    if (this.stopOutcome) throw this.stopOutcome;
    return this.result(input, { task: task(input.taskId, "killed"), alreadyTerminal: false });
  };

  rerunBackgroundJob: BackgroundJobsTransport["rerunBackgroundJob"] = async (input) => {
    this.record("rerun", input);
    this.tasks.push(view(task("rerun-1")));
    return this.result(input, { sourceTaskId: input.taskId, task: task("rerun-1") });
  };

  stopAllBackgroundJobs: BackgroundJobsTransport["stopAllBackgroundJobs"] = async (input) => {
    this.record("stop_all", input);
    return this.result(input, {
      results: input.taskIds.map((taskId) => ({ taskId, outcome: "stopped" as const })),
      stopped: input.taskIds.length,
      alreadyTerminal: 0,
      notFound: 0,
      failed: 0,
    });
  };

  markBackgroundJobsSeen: BackgroundJobsTransport["markBackgroundJobsSeen"] = async (input) => {
    this.record("mark_seen", input);
    return this.result(input, { results: [], revision: 2, counts });
  };
}

interface Harness {
  client: FakeJobsClient;
  controller: BackgroundJobsController;
  confirms: ConfirmRequest[];
  answer: { value: boolean; during?: () => void; gate?: Promise<void> };
  ticks: Array<() => void>;
}

function harness(): Harness {
  const client = new FakeJobsClient();
  const confirms: ConfirmRequest[] = [];
  const answer: Harness["answer"] = { value: true };
  const ticks: Array<() => void> = [];
  const controller = new BackgroundJobsController(client, "agent-1", {
    confirm: async (request) => {
      confirms.push(request);
      answer.during?.();
      if (answer.gate) await answer.gate;
      return answer.value;
    },
    copy: async () => {},
    setInterval: (callback) => {
      ticks.push(callback);
      return setInterval(() => {}, 1_000_000);
    },
    clearInterval: (handle) => {
      ticks.length = 0;
      clearInterval(handle);
    },
  });
  controller.start();
  client.emit(readyState());
  return { client, controller, confirms, answer, ticks };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function calls(h: Harness, method: string) {
  return h.client.calls.filter((call) => call.method === method);
}

/** Holds every confirmation dialog open until `release` is called. */
function holdConfirmations(h: Harness): () => void {
  const gate = deferred<void>();
  h.answer.gate = gate.promise;
  return () => gate.resolve();
}

async function openDetail(h: Harness, taskId: string): Promise<void> {
  h.controller.setDisplayed(true);
  h.controller.select(taskId);
  h.client.logs.resolve();
  await flush();
}

describe("BackgroundJobsController control intents", () => {
  test("two clicks while a confirmation is open produce one dialog and one execution", async () => {
    const h = harness();
    await openDetail(h, "a");
    const release = holdConfirmations(h);
    const first = h.controller.rerunJob();
    const second = h.controller.rerunJob();
    await flush();
    expect(h.confirms).toHaveLength(1);
    release();
    await Promise.all([first, second]);
    expect(calls(h, "rerun")).toHaveLength(1);
  });

  test("a cancelled confirmation sends nothing and releases the intent", async () => {
    const h = harness();
    await openDetail(h, "a");
    h.answer.value = false;
    await h.controller.rerunJob();
    expect(calls(h, "rerun")).toHaveLength(0);
    h.answer.value = true;
    await h.controller.rerunJob();
    expect(calls(h, "rerun")).toHaveLength(1);
  });

  test("a runtime replaced while the dialog is open receives no mutation", async () => {
    const h = harness();
    await openDetail(h, "a");
    const release = holdConfirmations(h);
    const stopping = h.controller.stopJob();
    await flush();
    h.client.emit(readyState("rt-2"));
    release();
    await stopping;
    expect(calls(h, "stop")).toHaveLength(0);
    expect(h.controller.getSnapshot().action).toMatchObject({
      status: "failed",
      kind: "stop",
      message: expect.stringMatching(/nothing was sent/),
    });
  });

  test("stop-all keeps its frozen authority: a replaced binding during paging sends nothing", async () => {
    const h = harness();
    h.controller.setDisplayed(true);
    await flush();
    const release = holdConfirmations(h);
    const stopping = h.controller.stopAllJobs();
    await flush();
    expect(h.confirms).toHaveLength(1);
    h.client.emit(readyState("rt-2"));
    release();
    await stopping;
    expect(calls(h, "stop_all")).toHaveLength(0);
  });

  test("copy and mark-seen status never release a control that is still confirming", async () => {
    const h = harness();
    await openDetail(h, "a");
    const release = holdConfirmations(h);
    const stopping = h.controller.stopJob();
    await flush();
    await h.controller.copy("x", "output path");
    const again = h.controller.stopJob();
    await flush();
    expect(h.confirms).toHaveLength(1);
    release();
    await Promise.all([stopping, again]);
    expect(calls(h, "stop")).toHaveLength(1);
  });

  test("more running jobs than one request can cover are refused, never clipped", async () => {
    const h = harness();
    h.client.tasks = Array.from({ length: 1001 }, (_, index) => view(task(`job-${index}`)));
    await h.controller.stopAllJobs();
    expect(calls(h, "list").length).toBe(21);
    expect(h.confirms).toHaveLength(0);
    expect(calls(h, "stop_all")).toHaveLength(0);
    expect(h.controller.getSnapshot().action).toMatchObject({
      status: "failed",
      kind: "stop_all",
      message: expect.stringMatching(/1001 jobs are running.*Nothing was stopped/),
    });
  });

  test("exactly the per-request bound is one confirmed stop of every running job", async () => {
    const h = harness();
    h.client.tasks = Array.from({ length: 1000 }, (_, index) => view(task(`job-${index}`)));
    await h.controller.stopAllJobs();
    const [stopAll] = calls(h, "stop_all");
    const taskIds = stopAll?.input.taskIds;
    expect(Array.isArray(taskIds) ? taskIds.length : 0).toBe(1000);
  });
});

describe("BackgroundJobsController observation ordering", () => {
  test("a lower revision of the current activation never rolls the view back", async () => {
    const h = harness();
    h.controller.setDisplayed(true);
    h.client.emit(readyState("rt-1", 5));
    await flush();
    const listed = calls(h, "list").length;
    h.client.emit(readyState("rt-1", 3));
    await flush();
    expect(h.controller.getSnapshot().state).toMatchObject({ revision: 5 });
    expect(calls(h, "list")).toHaveLength(listed);
    h.client.emit(readyState("rt-1", 6));
    await flush();
    expect(calls(h, "list")).toHaveLength(listed + 1);
  });

  test("a superseded runtime cannot revive its state or controls", async () => {
    const h = harness();
    h.client.emit(readyState("rt-2"));
    h.client.publish("sub-1", 1, readyState("rt-1", 9));
    h.client.publish("sub-1", 1, { status: "ended", runtimeId: "rt-1", message: "ended" });
    expect(h.controller.getSnapshot().state).toMatchObject({ status: "ready", runtimeId: "rt-2" });
  });

  test("after more than 32 replacements a delayed publication still cannot revive the first runtime", async () => {
    const h = harness();
    for (let generation = 2; generation <= 41; generation += 1)
      h.client.emit(readyState(`rt-${generation}`));
    h.client.publish("sub-1", 2, readyState("rt-1", 99));
    h.client.publish("sub-1", 3, { status: "ended", runtimeId: "rt-2", message: "ended" });
    expect(h.controller.getSnapshot().state).toMatchObject({ status: "ready", runtimeId: "rt-41" });
    await h.controller.stopAllJobs();
    expect(calls(h, "list").at(-1)?.input).toMatchObject({ runtimeId: "rt-41" });
  });

  test("a restored observation starts a new version scope; the replaced one is ignored", async () => {
    const h = harness();
    for (let generation = 2; generation <= 5; generation += 1)
      h.client.emit(readyState(`rt-${generation}`));
    h.client.restore("sub-2");
    h.client.emit(readyState("rt-6"));
    expect(h.controller.getSnapshot().state).toMatchObject({ runtimeId: "rt-6" });
    h.client.publish("sub-1", 99, readyState("rt-3"));
    h.client.publish("sub-2", 0, readyState("rt-4"));
    expect(h.controller.getSnapshot().state).toMatchObject({ runtimeId: "rt-6" });
    h.client.emit(readyState("rt-7"));
    expect(h.controller.getSnapshot().state).toMatchObject({ runtimeId: "rt-7" });
  });

  test("a restored snapshot of the same binding keeps the selection", async () => {
    const h = harness();
    await openDetail(h, "a");
    h.client.restore("sub-2");
    h.client.emit(readyState("rt-1", 2));
    expect(h.controller.getSnapshot().selectedTaskId).toBe("a");
  });

  test("a pending control stays tied to the observation it started on", async () => {
    const h = harness();
    await openDetail(h, "a");
    const release = holdConfirmations(h);
    const stopping = h.controller.stopJob();
    await flush();
    h.client.restore("sub-2");
    h.client.emit(readyState("rt-1", 2));
    release();
    await stopping;
    expect(calls(h, "stop")).toHaveLength(0);
  });
});

describe("BackgroundJobsController", () => {
  test("reload clears old controls but keeps the ready empty entry and binds a later new job", async () => {
    const h = harness();
    await openDetail(h, "a");
    h.client.tasks = [];
    const empty = readyState("rt-2");
    if (empty.status !== "ready") throw new Error("Expected a ready test state");
    h.client.emit({ ...empty, counts: { ...empty.counts, running: 0, total: 0 } });
    await flush();
    const current = h.controller.getSnapshot();
    expect(isTrackVisible(current.state)).toBe(true);
    expect(pillSegments(current.state)).toEqual([{ bucket: null, text: "Jobs" }]);
    expect(current.list.jobs).toEqual([]);
    expect(current.selectedTaskId).toBeNull();
    expect(current.detail.view).toBeNull();
    expect(h.ticks).toHaveLength(0);
    h.client.tasks = [view(task("after-reload"))];
    h.client.emit(readyState("rt-2", 2));
    await flush();
    expect(h.controller.getSnapshot().list.jobs.map((entry) => entry.task.id)).toEqual([
      "after-reload",
    ]);
    expect(calls(h, "list").at(-1)?.input.runtimeId).toBe("rt-2");
  });

  test("lists only while displayed, and a new runtime resets selection and cursor authority", async () => {
    const h = harness();
    await flush();
    expect(h.client.calls).toEqual([]);
    h.controller.setDisplayed(true);
    await flush();
    expect(h.controller.getSnapshot().list.jobs.map((job) => job.task.id)).toEqual(["a", "b"]);
    h.controller.select("a");
    h.client.logs.resolve();
    await flush();
    expect(h.controller.getSnapshot().selectedTaskId).toBe("a");
    h.client.emit(readyState("rt-2"));
    const snapshot = h.controller.getSnapshot();
    expect(snapshot.selectedTaskId).toBeNull();
    expect(snapshot.detail.view).toBeNull();
    await flush();
    expect(h.client.calls.at(-1)).toMatchObject({ method: "list", input: { runtimeId: "rt-2" } });
  });

  test("a stale response never lands on a newer selection", async () => {
    const h = harness();
    h.controller.setDisplayed(true);
    h.controller.select("a");
    h.controller.select("b");
    h.client.logs.resolve();
    await flush();
    await flush();
    const logs = h.controller.getSnapshot().logs.result;
    expect(logs?.text).toBe("output of b");
    expect(h.controller.getSnapshot().detail.view?.task.id).toBe("b");
  });

  test("follows a running job only while displayed; pause freezes; terminal jobs never poll", async () => {
    const h = harness();
    h.controller.setDisplayed(true);
    h.controller.select("a");
    h.client.logs.resolve();
    await flush();
    expect(h.controller.getSnapshot().logs.following).toBe(true);
    expect(h.ticks).toHaveLength(1);
    h.controller.pause();
    expect(h.ticks).toHaveLength(0);
    h.controller.follow();
    expect(h.ticks).toHaveLength(1);
    h.controller.setDisplayed(false);
    expect(h.ticks).toHaveLength(0);
    h.controller.setDisplayed(true);
    h.controller.setForeground(false);
    expect(h.ticks).toHaveLength(0);
    h.controller.setForeground(true);
    h.controller.select("b");
    await flush();
    expect(h.ticks).toHaveLength(0);
  });

  test("a log failure stops following until a deliberate retry", async () => {
    const h = harness();
    h.controller.setDisplayed(true);
    h.client.logsFail = Object.assign(new Error("gone"), { code: "LOG_UNAVAILABLE" });
    h.controller.select("a");
    h.client.logs.resolve();
    await flush();
    await flush();
    const failed = h.controller.getSnapshot().logs;
    expect(failed.status).toBe("error");
    expect(failed.error).toMatch(/output log file/);
    expect(h.ticks).toHaveLength(0);
    h.client.logsFail = null;
    h.controller.retryLogs();
    await flush();
    expect(h.controller.getSnapshot().logs).toMatchObject({ status: "ready", following: true });
  });

  test("viewing a terminal job marks it seen once; a running job is never pre-acknowledged", async () => {
    const h = harness();
    h.controller.setDisplayed(true);
    h.controller.select("a");
    h.client.logs.resolve();
    await flush();
    expect(h.client.calls.some((call) => call.method === "mark_seen")).toBe(false);
    h.controller.select("b");
    await flush();
    await flush();
    const marks = h.client.calls.filter((call) => call.method === "mark_seen");
    expect(marks).toHaveLength(1);
    expect(marks[0]?.input).toMatchObject({ taskIds: ["b"], subscriptionId: "sub-1" });
  });

  test("stop-all freezes the running IDs before confirmation", async () => {
    const h = harness();
    h.controller.setDisplayed(true);
    h.answer.during = () => h.client.tasks.push(view(task("late")));
    await h.controller.stopAllJobs();
    const stopAll = h.client.calls.find((call) => call.method === "stop_all");
    expect(stopAll?.input).toMatchObject({ taskIds: ["a"] });
    expect(h.confirms[0]?.message).toMatch(/1 job running now/);
  });

  test("a cancelled confirmation sends nothing; each confirmed action uses a fresh sequence", async () => {
    const h = harness();
    h.controller.setDisplayed(true);
    h.controller.select("a");
    h.client.logs.resolve();
    await flush();
    h.answer.value = false;
    await h.controller.stopJob();
    expect(h.client.calls.some((call) => call.method === "stop")).toBe(false);
    h.answer.value = true;
    await h.controller.stopJob();
    await h.controller.rerunJob();
    const sequences = h.client.calls
      .filter((call) => call.method === "stop" || call.method === "rerun")
      .map((call) => call.input.sequence);
    expect(new Set(sequences).size).toBe(2);
    expect(h.controller.getSnapshot().selectedTaskId).toBe("rerun-1");
  });

  test("a lost connection is an unknown outcome and is not retried", async () => {
    const h = harness();
    h.controller.setDisplayed(true);
    h.controller.select("a");
    h.client.logs.resolve();
    await flush();
    h.client.stopOutcome = new DaemonConnectionError("Connection lost");
    await h.controller.stopJob();
    expect(h.controller.getSnapshot().action).toMatchObject({ status: "unknown", kind: "stop" });
    expect(h.client.calls.filter((call) => call.method === "stop")).toHaveLength(1);
  });

  test("an integrity failure shows a verification error, never a result", async () => {
    const h = harness();
    h.controller.setDisplayed(true);
    h.controller.select("b");
    await flush();
    h.controller.openResult();
    await flush();
    const result = h.controller.getSnapshot().result;
    expect(result.view).toBeNull();
    expect(result.error).toBe("The result failed verification and was not shown: tampered");
  });

  test("controls without a ready binding fail visibly", async () => {
    const h = harness();
    h.client.emit({ status: "missing", runtimeId: "rt", message: "not installed" });
    await h.controller.stopAllJobs();
    expect(h.client.calls).toEqual([]);
    expect(h.controller.getSnapshot().state).toMatchObject({ status: "missing" });
  });
});
