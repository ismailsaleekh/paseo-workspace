import type {
  BackgroundJob,
  BackgroundJobCounts,
  BackgroundJobKind,
  BackgroundJobLogsResult,
  BackgroundJobResultView,
  BackgroundJobStatus,
  BackgroundJobsState,
} from "@getpaseo/protocol/pi-background-jobs/rpc-schemas";
import type { ComposerTrackPillSegment } from "@/composer/tracks";

/** Plain-language labels and pure projections for the native background jobs surface. */

export const UNAVAILABLE = "Unavailable";

/**
 * A stable viewport shared by list and detail, not the unbounded content height. Keeping this
 * frame stable avoids moving an anchored panel below the screen when a long detail replaces a
 * short list. The shared menu still owns placement/clamping and compact sheet presentation.
 */
export function jobsPanelViewport(width: number, height: number) {
  return {
    width: Math.max(1, Math.min(620, width - 32)),
    height: Math.max(1, Math.min(440, height - 160)),
  };
}

const KIND_LABELS: Record<BackgroundJobKind, string> = {
  shell: "Shell",
  "agent-shell": "Agent shell",
  delegate: "Delegate",
  fusion: "Fusion",
  attested: "Attested Pi run",
  managed: "Managed task",
};

const STATUS_LABELS: Record<BackgroundJobStatus, string> = {
  running: "Running",
  completed: "Completed",
  failed: "Failed",
  killed: "Stopped (killed)",
};

export function kindLabel(kind: BackgroundJobKind): string {
  return KIND_LABELS[kind];
}

export function statusLabel(status: BackgroundJobStatus): string {
  return STATUS_LABELS[status];
}

export function jobTitle(job: BackgroundJob): string {
  return job.name?.trim() || job.id;
}

/**
 * The composer entry stays visible while jobs run or unseen completions exist, and gives access to
 * retained history when nothing is active. A ready replacement with no tasks still offers an
 * empty current view, rather than making the entry disappear during reload/rebind.
 */
export function isTrackVisible(state: BackgroundJobsState | null): boolean {
  if (!state) return false;
  if (state.status === "ready") return true;
  return state.status === "outdated" || state.status === "error";
}

export function pillSegments(state: BackgroundJobsState | null): ComposerTrackPillSegment[] {
  if (!state || state.status !== "ready") return [{ bucket: "attention", text: "Jobs" }];
  const counts = state.counts;
  const segments: ComposerTrackPillSegment[] = [];
  if (counts.running > 0) segments.push({ bucket: "running", text: `${counts.running} running` });
  if (counts.unseenFailed > 0)
    segments.push({ bucket: "failed", text: `${counts.unseenFailed} failed` });
  if (counts.unseenKilled > 0)
    segments.push({ bucket: "attention", text: `${counts.unseenKilled} stopped` });
  if (counts.unseenCompleted > 0)
    segments.push({ bucket: "done", text: `${counts.unseenCompleted} done` });
  if (segments.length === 0) segments.push({ bucket: null, text: "Jobs" });
  return segments;
}

export function pillAccessibilityLabel(state: BackgroundJobsState | null): string {
  if (!state || state.status !== "ready") return `Background jobs: ${stateMessage(state)}`;
  const counts = state.counts;
  return `Background jobs: ${counts.running} running, ${counts.total} retained, ${unseenCount(counts)} unseen`;
}

export function unseenCount(counts: BackgroundJobCounts): number {
  return counts.unseenCompleted + counts.unseenFailed + counts.unseenKilled;
}

/** A human description of every non-ready availability state. Absence is never an empty list. */
export function stateMessage(state: BackgroundJobsState | null): string {
  if (!state) return "Connecting to the host";
  switch (state.status) {
    case "ready":
      return "Ready";
    case "initializing":
      return "Waiting for the Pi runtime's background task host";
    case "unavailable":
    case "unsupported":
    case "missing":
    case "outdated":
    case "ended":
    case "error":
      return state.message;
  }
}

export function formatDuration(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

/** Elapsed time comes from the task's own timestamps; a running task is measured against `now`. */
export function elapsedLabel(job: BackgroundJob, now: number): string {
  const end = job.endTime ?? (job.status === "running" ? now : undefined);
  if (end === undefined) return UNAVAILABLE;
  return formatDuration(end - job.startTime);
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

export function exitLabel(job: BackgroundJob): string {
  if (job.status === "running") return "Still running";
  if (job.signal) return `Signal ${job.signal}`;
  if (typeof job.exitCode === "number") return `Exit code ${job.exitCode}`;
  return UNAVAILABLE;
}

export interface DetailRow {
  key: string;
  label: string;
  value: string;
}

/** Task-owned telemetry only. A missing value is explicitly unavailable, never zero. */
export function telemetryRows(job: BackgroundJob): DetailRow[] {
  const reason = job.telemetryUnavailableReason;
  const missing = reason ? `${UNAVAILABLE} (${reason})` : UNAVAILABLE;
  const context = job.contextUsage;
  const tokens = job.tokenUsage;
  const tools = job.toolUsage;
  return [
    { key: "model", label: "Model", value: job.model ?? missing },
    {
      key: "context",
      label: "Context",
      value: context
        ? `${context.tokens === null ? "?" : context.tokens} / ${context.contextWindow} tokens`
        : missing,
    },
    {
      key: "tokens",
      label: "Tokens",
      value: tokens
        ? `${tokens.input} in · ${tokens.output} out · ${tokens.totalTokens} total`
        : missing,
    },
    {
      key: "tools",
      label: "Tool calls",
      value: tools ? `${tools.total} (${tools.failed} failed)` : missing,
    },
  ];
}

export function jobRows(job: BackgroundJob, kind: BackgroundJobKind, now: number): DetailRow[] {
  const rows: DetailRow[] = [
    { key: "id", label: "ID", value: job.id },
    { key: "kind", label: "Kind", value: kindLabel(kind) },
    { key: "status", label: "Status", value: statusLabel(job.status) },
    { key: "elapsed", label: "Elapsed", value: elapsedLabel(job, now) },
    { key: "exit", label: "Exit", value: exitLabel(job) },
    { key: "cwd", label: "Directory", value: job.cwd },
    { key: "output", label: "Output", value: job.outputPath },
  ];
  if (job.description)
    rows.push({ key: "description", label: "Description", value: job.description });
  if (job.error) rows.push({ key: "error", label: "Error", value: job.error });
  if (job.timeoutSeconds !== undefined)
    rows.push({ key: "timeout", label: "Timeout", value: `${job.timeoutSeconds}s` });
  return rows;
}

/** The explicit window and truncation facts that accompany a log view. */
export function logWindowLabel(logs: BackgroundJobLogsResult): string {
  if (logs.totalBytes === 0) return "No output yet";
  const window = `bytes ${logs.windowStart}–${logs.windowEnd} of ${formatBytes(logs.totalBytes)}`;
  return logs.truncated ? `Showing ${window}; earlier output omitted` : `Showing all ${window}`;
}

/** Output is untrusted text: drop terminal control sequences so nothing is interpreted. */
export function plainLogText(text: string): string {
  let output = "";
  let index = 0;
  while (index < text.length) {
    const code = text.charCodeAt(index);
    if (code === 0x1b) {
      index = skipEscapeSequence(text, index);
      continue;
    }
    if (code === 0x09 || code === 0x0a || (code >= 0x20 && code !== 0x7f)) output += text[index];
    index += 1;
  }
  return output;
}

/** Returns the index after an ESC sequence (CSI, OSC or a two-character escape). */
function skipEscapeSequence(text: string, start: number): number {
  const introducer = text[start + 1];
  if (introducer === "[") {
    let index = start + 2;
    while (index < text.length) {
      const code = text.charCodeAt(index);
      index += 1;
      if (code >= 0x40 && code <= 0x7e) break;
    }
    return index;
  }
  if (introducer === "]") {
    let index = start + 2;
    while (index < text.length) {
      const code = text.charCodeAt(index);
      if (code === 0x07) return index + 1;
      if (code === 0x1b && text[index + 1] === "\\") return index + 2;
      index += 1;
    }
    return index;
  }
  return Math.min(text.length, start + 2);
}

export type ResultPresentation =
  | { kind: "running"; message: string }
  | { kind: "inline"; text: string; summary: string }
  | { kind: "artifact"; path: string; summary: string }
  | { kind: "no_answer"; message: string };

export function presentResult(view: BackgroundJobResultView): ResultPresentation {
  switch (view.state) {
    case "running":
      return { kind: "running", message: "The task is still running; no verified result yet" };
    case "committed": {
      const summary = `Verified · ${formatBytes(view.answerBytes)} · sha256 ${view.answerSha256.slice(0, 12)}`;
      if (view.delivery === "inline" && view.text !== undefined)
        return { kind: "inline", text: view.text, summary };
      return { kind: "artifact", path: view.artifactPath, summary };
    }
    case "failed":
    case "cancelled": {
      const detail = view.message ?? view.errorCode;
      return {
        kind: "no_answer",
        message: `No answer: the task ${view.state}${detail ? ` (${detail})` : ""}`,
      };
    }
  }
}

export function isTerminal(job: BackgroundJob): boolean {
  return job.status !== "running";
}
