import { describe, expect, test } from "vitest";
import type {
  BackgroundJob,
  BackgroundJobsReadyState,
  BackgroundJobsState,
} from "@getpaseo/protocol/pi-background-jobs/rpc-schemas";
import {
  elapsedLabel,
  formatBytes,
  isTrackVisible,
  jobRows,
  jobsPanelViewport,
  logWindowLabel,
  pillSegments,
  plainLogText,
  presentResult,
  stateMessage,
  telemetryRows,
} from "./view-model";

const counts = {
  running: 0,
  completed: 0,
  failed: 0,
  killed: 0,
  unseenCompleted: 0,
  unseenFailed: 0,
  unseenKilled: 0,
  total: 0,
};

function ready(patch: Partial<BackgroundJobsReadyState["counts"]>): BackgroundJobsState {
  return {
    status: "ready",
    runtimeId: "rt",
    activationId: "act",
    sessionId: "s",
    revision: 1,
    observedAt: 1,
    counts: { ...counts, ...patch },
  };
}

const job: BackgroundJob = {
  id: "task-1",
  name: "Build",
  command: "npm run build",
  status: "running",
  outputPath: ".pi/tasks/task-1.output",
  cwd: "/tmp/project",
  startTime: 1_000,
  bytesWritten: 0,
  isAgent: false,
  surviveReload: false,
  notifyOnCompletion: true,
  triggerOnCompletion: false,
};

describe("entry visibility and pill", () => {
  test("a ready empty runtime keeps an entry; absence and initialization are not empty successes", () => {
    expect(isTrackVisible(null)).toBe(false);
    expect(isTrackVisible(ready({}))).toBe(true);
    expect(pillSegments(ready({}))).toEqual([{ bucket: null, text: "Jobs" }]);
    expect(isTrackVisible(ready({ total: 1, killed: 1 }))).toBe(true);
    expect(isTrackVisible({ status: "missing", runtimeId: "rt", message: "absent" })).toBe(false);
    expect(isTrackVisible({ status: "initializing", runtimeId: "rt" })).toBe(false);
    expect(isTrackVisible({ status: "outdated", runtimeId: "rt", message: "old" })).toBe(true);
  });

  test("one segment per state; seen history reads as plain Jobs", () => {
    expect(
      pillSegments(ready({ running: 2, unseenFailed: 1, unseenKilled: 1, total: 4 })).map(
        (segment) => segment.text,
      ),
    ).toEqual(["2 running", "1 failed", "1 stopped"]);
    expect(pillSegments(ready({ total: 3, completed: 3 }))).toEqual([
      { bucket: null, text: "Jobs" },
    ]);
  });

  test("every non-ready state has its own explanation", () => {
    expect(stateMessage({ status: "missing", runtimeId: "rt", message: "not installed" })).toBe(
      "not installed",
    );
    expect(stateMessage({ status: "initializing", runtimeId: "rt" })).toMatch(/Waiting/);
    expect(stateMessage(null)).toMatch(/Connecting/);
  });
});

describe("jobs panel viewport", () => {
  test("list and long detail use the same bounded frame on desktop and compact", () => {
    expect(jobsPanelViewport(1440, 1000)).toEqual({ width: 620, height: 440 });
    expect(jobsPanelViewport(393, 851)).toEqual({ width: 361, height: 440 });
    expect(jobsPanelViewport(393, 400)).toEqual({ width: 361, height: 240 });
  });
});

describe("detail projection", () => {
  test("missing telemetry is Unavailable, never zero", () => {
    const rows = telemetryRows(job);
    expect(rows.map((row) => row.value)).toEqual([
      "Unavailable",
      "Unavailable",
      "Unavailable",
      "Unavailable",
    ]);
    const reasoned = telemetryRows({ ...job, telemetryUnavailableReason: "not an agent task" });
    expect(reasoned[0]?.value).toBe("Unavailable (not an agent task)");
    const owned = telemetryRows({
      ...job,
      model: "m",
      tokenUsage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3 },
    });
    expect(owned[0]?.value).toBe("m");
    expect(owned[2]?.value).toBe("1 in · 2 out · 3 total");
  });

  test("elapsed time comes from task timestamps; running time is client-rendered", () => {
    expect(elapsedLabel(job, 66_000)).toBe("1m 5s");
    expect(elapsedLabel({ ...job, status: "completed", endTime: 4_000 }, 99_000)).toBe("3s");
    expect(elapsedLabel({ ...job, status: "failed" }, 99_000)).toBe("Unavailable");
    const rows = jobRows({ ...job, status: "killed", signal: "SIGTERM" }, "shell", 2_000);
    expect(rows.find((row) => row.key === "status")?.value).toBe("Stopped (killed)");
    expect(rows.find((row) => row.key === "exit")?.value).toBe("Signal SIGTERM");
  });

  test("logs are plain text with an explicit window", () => {
    expect(plainLogText("\u001b[31mred\u001b[0m line\r\n\u0007bell \u001b]0;title\u0007ok")).toBe(
      "red line\nbell ok",
    );
    const window = {
      task: job,
      path: "/tmp/x",
      text: "",
      tail: true,
      maxBytes: 4,
      bytesRead: 4,
      totalBytes: 2048,
      windowStart: 2044,
      windowEnd: 2048,
      truncated: true,
      bytesWritten: 2048,
    };
    expect(logWindowLabel(window)).toBe(
      "Showing bytes 2044–2048 of 2.0 KiB; earlier output omitted",
    );
    expect(formatBytes(10)).toBe("10 B");
  });

  test("results are verified text, an artifact reference or an explicit no-answer state", () => {
    const committed = {
      taskId: "t",
      kind: "delegate" as const,
      state: "committed" as const,
      answerBytes: 5,
      answerSha256: "a".repeat(64),
      artifactPath: "/tmp/answer.md",
    };
    expect(presentResult({ ...committed, delivery: "inline", text: "hello" })).toMatchObject({
      kind: "inline",
      text: "hello",
    });
    expect(presentResult({ ...committed, delivery: "artifact" })).toMatchObject({
      kind: "artifact",
      path: "/tmp/answer.md",
    });
    expect(
      presentResult({ taskId: "t", kind: "fusion", state: "cancelled", delivery: "none" }),
    ).toMatchObject({ kind: "no_answer" });
  });
});
