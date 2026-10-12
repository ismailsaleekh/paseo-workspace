import {
  DaemonConnectionError,
  type BackgroundJobsControlAddress,
  type DaemonClient,
} from "@getpaseo/client/internal/daemon-client";
import {
  BACKGROUND_JOBS_MAX_TASK_IDS,
  type BackgroundJobLogsResult,
  type BackgroundJobResultView,
  type BackgroundJobView,
  type BackgroundJobsReadyState,
  type BackgroundJobsState,
} from "@getpaseo/protocol/pi-background-jobs/rpc-schemas";
import { jobTitle } from "./view-model";

export type BackgroundJobsTransport = Pick<
  DaemonClient,
  | "observeBackgroundJobs"
  | "listBackgroundJobs"
  | "getBackgroundJob"
  | "readBackgroundJobLogs"
  | "readBackgroundJobResult"
  | "stopBackgroundJob"
  | "rerunBackgroundJob"
  | "stopAllBackgroundJobs"
  | "markBackgroundJobsSeen"
>;

export interface ConfirmRequest {
  title: string;
  message: string;
  confirmLabel: string;
  destructive: boolean;
}

type IntervalHandle = ReturnType<typeof setInterval>;

export interface BackgroundJobsControllerOptions {
  confirm(request: ConfirmRequest): Promise<boolean>;
  copy(text: string): Promise<void>;
  setInterval?(callback: () => void, milliseconds: number): IntervalHandle;
  clearInterval?(handle: IntervalHandle): void;
}

export type LoadStatus = "idle" | "loading" | "ready" | "error";
export type ActionKind = "stop" | "rerun" | "stop_all" | "mark_seen" | "copy";
export type ActionState =
  | { status: "idle" }
  | { status: "pending"; kind: ActionKind }
  | { status: "done"; kind: ActionKind; message: string }
  | { status: "failed"; kind: ActionKind; message: string }
  /** The connection was lost before the host answered; nothing is retried automatically. */
  | { status: "unknown"; kind: ActionKind; message: string };

export interface BackgroundJobsSnapshot {
  state: BackgroundJobsState | null;
  observationError: string | null;
  list: {
    status: LoadStatus;
    jobs: BackgroundJobView[];
    nextCursor: string | null;
    error: string | null;
    loadingMore: boolean;
  };
  selectedTaskId: string | null;
  detail: { status: LoadStatus; view: BackgroundJobView | null; error: string | null };
  logs: {
    status: LoadStatus;
    result: BackgroundJobLogsResult | null;
    error: string | null;
    following: boolean;
  };
  result: { status: LoadStatus; view: BackgroundJobResultView | null; error: string | null };
  action: ActionState;
}

/** Follow polls at most once a second, and only while visible, foreground and running. */
export const FOLLOW_INTERVAL_MS = 1000;
export const LOG_WINDOW_BYTES = 32768;

const EMPTY_LIST: BackgroundJobsSnapshot["list"] = {
  status: "idle",
  jobs: [],
  nextCursor: null,
  error: null,
  loadingMore: false,
};
const EMPTY_DETAIL: BackgroundJobsSnapshot["detail"] = { status: "idle", view: null, error: null };
const EMPTY_LOGS: BackgroundJobsSnapshot["logs"] = {
  status: "idle",
  result: null,
  error: null,
  following: false,
};
const EMPTY_RESULT: BackgroundJobsSnapshot["result"] = { status: "idle", view: null, error: null };
const IDLE_ACTION: ActionState = { status: "idle" };

export const INITIAL_BACKGROUND_JOBS_SNAPSHOT: BackgroundJobsSnapshot = {
  state: null,
  observationError: null,
  list: EMPTY_LIST,
  selectedTaskId: null,
  detail: EMPTY_DETAIL,
  logs: EMPTY_LOGS,
  result: EMPTY_RESULT,
  action: IDLE_ACTION,
};

const UNKNOWN_OUTCOME =
  "The connection was lost before the host answered, so the outcome is unknown. Check the job list before acting again.";

export function errorCode(error: unknown): string | null {
  if (error instanceof Error && "code" in error && typeof error.code === "string")
    return error.code;
  return null;
}

/** The daemon's message without the transport's correlation suffix. */
export function errorText(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  return error.message.split(" requestType=")[0] ?? error.message;
}

export function isUncertainOutcome(error: unknown): boolean {
  const code = errorCode(error);
  return (
    error instanceof DaemonConnectionError ||
    code === "TIMEOUT" ||
    code === "DISCONNECTED" ||
    code === "BACKPRESSURE"
  );
}

function logsFailureMessage(error: unknown): string {
  if (errorCode(error) === "LOG_UNAVAILABLE")
    return `The output log file could not be read: ${errorText(error)}`;
  return `Reading the output log failed: ${errorText(error)}`;
}

function resultFailureMessage(error: unknown): string {
  if (errorCode(error) === "RESULT_INVALID")
    return `The result failed verification and was not shown: ${errorText(error)}`;
  return `Reading the verified result failed: ${errorText(error)}`;
}

type LogsFetch = "explicit" | "tick" | "settle";
interface ControlOutcome {
  message: string;
  startedTaskId?: string;
}
interface Authority {
  lifetime: number;
  bindingKey: string;
  subscriptionId: string;
  ready: BackgroundJobsReadyState;
  epoch: number;
}

const STALE_INTENT =
  "The jobs view changed while this action was waiting, so nothing was sent. Review the current jobs and act again.";

function bindingKeyOf(state: BackgroundJobsReadyState): string {
  return `${state.runtimeId}\u0000${state.activationId}`;
}

/**
 * Owns one pane's observation of an agent's background jobs and the panel's view state. A new
 * runtime or host activation resets selection, cursors and controls, and responses that belong to
 * an older binding or selection are discarded.
 */
export class BackgroundJobsController {
  private snapshot: BackgroundJobsSnapshot = INITIAL_BACKGROUND_JOBS_SNAPSHOT;
  private readonly listeners = new Set<() => void>();
  private observation: ReturnType<BackgroundJobsTransport["observeBackgroundJobs"]> | null = null;
  private lifetime = 0;
  /** Bumped when the runtime binding or selection changes; stale async results are dropped. */
  private epoch = 0;
  private bindingKey: string | null = null;
  private sequence = 0;
  private displayed = false;
  private foreground = true;
  private timer: IntervalHandle | null = null;
  private listInFlight = false;
  private listDirty = false;
  private detailInFlight = false;
  private detailDirty = false;
  private logsInFlight = false;
  private logsDirty = false;
  private readonly markedSeen = new Set<string>();
  /** The latest accepted publication of the current physical observation. */
  private publication: { subscriptionId: string; version: number } | null = null;
  /** One deliberate control from its first click through confirmation and response. */
  private intent: ActionKind | null = null;

  constructor(
    private readonly client: BackgroundJobsTransport,
    private readonly agentId: string,
    private readonly options: BackgroundJobsControllerOptions,
  ) {}

  getSnapshot = (): BackgroundJobsSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private update(patch: Partial<BackgroundJobsSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) listener();
    this.syncTimer();
  }

  // ---------------------------------------------------------------------------
  // Observation lifetime
  // ---------------------------------------------------------------------------

  start(): void {
    if (this.observation) return;
    const lifetime = ++this.lifetime;
    try {
      const observation = this.client.observeBackgroundJobs(this.agentId);
      this.observation = observation;
      observation.subscribe({
        snapshot: (payload) => {
          if (lifetime === this.lifetime)
            this.acceptPublication(payload.subscriptionId, payload.version, payload.state);
        },
        update: (message) => {
          if (
            lifetime !== this.lifetime ||
            message.type !== "agent.background_jobs.update" ||
            message.payload.agentId !== this.agentId
          )
            return;
          const { subscriptionId, version, state } = message.payload;
          this.acceptPublication(subscriptionId, version, state);
        },
        error: (error) => {
          if (lifetime === this.lifetime) this.update({ observationError: errorText(error) });
        },
      });
    } catch (error) {
      this.update({ observationError: errorText(error) });
    }
  }

  async stop(): Promise<void> {
    this.lifetime += 1;
    this.epoch += 1;
    this.bindingKey = null;
    this.publication = null;
    const observation = this.observation;
    this.observation = null;
    this.snapshot = INITIAL_BACKGROUND_JOBS_SNAPSHOT;
    this.stopTimer();
    for (const listener of this.listeners) listener();
    if (observation) await observation.release();
  }

  setDisplayed(displayed: boolean): void {
    if (this.displayed === displayed) return;
    this.displayed = displayed;
    if (displayed) {
      this.refreshList();
      if (this.snapshot.selectedTaskId) this.refreshDetail();
    }
    this.syncTimer();
  }

  setForeground(foreground: boolean): void {
    this.foreground = foreground;
    this.syncTimer();
  }

  /** Deliberate recovery: a fresh observation, which also lets the host retry a refused lease. */
  async restart(): Promise<void> {
    await this.stop();
    this.start();
  }

  /**
   * Ordering fence. Publications of one physical observation carry a monotonic version, so a
   * delayed or repeated snapshot/update never overrides a newer one, however many runtime
   * generations have passed. A restored observation has a new subscription ID and its own
   * version scope; anything still addressed to the replaced one is ignored.
   */
  private acceptPublication(
    subscriptionId: string,
    version: number,
    state: BackgroundJobsState,
  ): void {
    if (subscriptionId !== this.observation?.subscriptionId) return;
    const last = this.publication;
    if (last && last.subscriptionId === subscriptionId && version <= last.version) return;
    this.publication = { subscriptionId, version };
    this.acceptState(state);
  }

  /** The hub never lowers the revision of one activation; a lower one here is not applied. */
  private isRollback(state: BackgroundJobsState): boolean {
    const previous = this.snapshot.state;
    return (
      state.status === "ready" &&
      previous?.status === "ready" &&
      bindingKeyOf(previous) === bindingKeyOf(state) &&
      state.revision < previous.revision
    );
  }

  private acceptState(state: BackgroundJobsState): void {
    if (this.isRollback(state)) return;
    const key = state.status === "ready" ? bindingKeyOf(state) : null;
    const previous = this.snapshot.state;
    if (key !== this.bindingKey) {
      this.bindingKey = key;
      this.epoch += 1;
      this.markedSeen.clear();
      this.update({
        state,
        observationError: null,
        list: EMPTY_LIST,
        selectedTaskId: null,
        detail: EMPTY_DETAIL,
        logs: EMPTY_LOGS,
        result: EMPTY_RESULT,
        action: IDLE_ACTION,
      });
      if (key && this.displayed) this.refreshList();
      return;
    }
    this.update({ state, observationError: null });
    const changed =
      previous?.status === "ready" &&
      state.status === "ready" &&
      previous.revision !== state.revision;
    if (!changed || !this.displayed) return;
    this.refreshList();
    if (this.snapshot.selectedTaskId) this.refreshDetail();
  }

  private ready(): BackgroundJobsReadyState | null {
    const state = this.snapshot.state;
    return state?.status === "ready" ? state : null;
  }

  private address(ready: BackgroundJobsReadyState) {
    return { agentId: this.agentId, runtimeId: ready.runtimeId, activationId: ready.activationId };
  }

  /** The binding a deliberate action was started against; it is never retargeted. */
  private captureAuthority(): Authority | null {
    const ready = this.ready();
    const subscriptionId = this.observation?.subscriptionId;
    if (!ready || !subscriptionId || this.bindingKey === null) return null;
    return {
      lifetime: this.lifetime,
      bindingKey: this.bindingKey,
      subscriptionId,
      ready,
      epoch: this.epoch,
    };
  }

  private authorityCurrent(authority: Authority, selectionScoped: boolean): boolean {
    return (
      authority.lifetime === this.lifetime &&
      authority.bindingKey === this.bindingKey &&
      this.observation?.subscriptionId === authority.subscriptionId &&
      (!selectionScoped || authority.epoch === this.epoch)
    );
  }

  /** One fresh sequence per deliberate action, bound to the current source-owned subscription. */
  private controlAddress(): BackgroundJobsControlAddress | null {
    const authority = this.captureAuthority();
    return authority ? this.sequencedAddress(authority) : null;
  }

  private sequencedAddress(authority: Authority): BackgroundJobsControlAddress {
    this.sequence += 1;
    return {
      ...this.address(authority.ready),
      subscriptionId: authority.subscriptionId,
      sequence: this.sequence,
    };
  }

  // ---------------------------------------------------------------------------
  // List
  // ---------------------------------------------------------------------------

  refreshList(): void {
    const ready = this.ready();
    if (!ready) return;
    if (this.listInFlight) {
      this.listDirty = true;
      return;
    }
    this.listInFlight = true;
    this.listDirty = false;
    const epoch = this.epoch;
    if (this.snapshot.list.status !== "ready")
      this.update({ list: { ...this.snapshot.list, status: "loading", error: null } });
    void this.client
      .listBackgroundJobs(this.address(ready))
      .then(
        (payload) => {
          if (epoch !== this.epoch) return undefined;
          this.update({
            list: {
              status: "ready",
              jobs: payload.result.tasks,
              nextCursor: payload.result.nextCursor,
              error: null,
              loadingMore: false,
            },
          });
          return undefined;
        },
        (error: unknown) => {
          if (epoch !== this.epoch) return;
          this.update({
            list: {
              ...this.snapshot.list,
              status: "error",
              error: `Loading jobs failed: ${errorText(error)}`,
            },
          });
        },
      )
      .finally(() => {
        this.listInFlight = false;
        if (this.listDirty) this.refreshList();
      });
  }

  /** Every retained task is reachable by paging; nothing is capped at the first page. */
  loadMore(): void {
    const ready = this.ready();
    const cursor = this.snapshot.list.nextCursor;
    if (!ready || !cursor || this.snapshot.list.loadingMore) return;
    const epoch = this.epoch;
    this.update({ list: { ...this.snapshot.list, loadingMore: true } });
    void this.client.listBackgroundJobs({ ...this.address(ready), cursor }).then(
      (payload) => {
        if (epoch !== this.epoch) return undefined;
        const known = new Set(this.snapshot.list.jobs.map((job) => job.task.id));
        const added = payload.result.tasks.filter((job) => !known.has(job.task.id));
        this.update({
          list: {
            status: "ready",
            jobs: [...this.snapshot.list.jobs, ...added],
            nextCursor: payload.result.nextCursor,
            error: null,
            loadingMore: false,
          },
        });
        return undefined;
      },
      (error: unknown) => {
        if (epoch !== this.epoch) return;
        this.update({
          list: {
            ...this.snapshot.list,
            loadingMore: false,
            error: `Loading more jobs failed: ${errorText(error)}`,
          },
        });
      },
    );
  }

  // ---------------------------------------------------------------------------
  // Detail, logs and results
  // ---------------------------------------------------------------------------

  select(taskId: string): void {
    this.epoch += 1;
    this.update({
      selectedTaskId: taskId,
      detail: { status: "loading", view: null, error: null },
      logs: { ...EMPTY_LOGS, status: "loading" },
      result: EMPTY_RESULT,
      action: IDLE_ACTION,
    });
    this.refreshDetail();
    this.fetchLogs("explicit");
  }

  back(): void {
    this.epoch += 1;
    this.update({
      selectedTaskId: null,
      detail: EMPTY_DETAIL,
      logs: EMPTY_LOGS,
      result: EMPTY_RESULT,
      action: IDLE_ACTION,
    });
    this.refreshList();
  }

  retryDetail(): void {
    this.refreshDetail();
  }

  private refreshDetail(): void {
    const ready = this.ready();
    const taskId = this.snapshot.selectedTaskId;
    if (!ready || !taskId) return;
    if (this.detailInFlight) {
      this.detailDirty = true;
      return;
    }
    this.detailInFlight = true;
    this.detailDirty = false;
    const epoch = this.epoch;
    void this.client
      .getBackgroundJob({ ...this.address(ready), taskId })
      .then(
        (payload) => {
          if (epoch !== this.epoch) return undefined;
          this.acceptDetail(payload.result.task);
          return undefined;
        },
        (error: unknown) => {
          if (epoch !== this.epoch) return;
          this.update({
            detail: {
              ...this.snapshot.detail,
              status: "error",
              error: `Loading the job failed: ${errorText(error)}`,
            },
          });
        },
      )
      .finally(() => {
        this.detailInFlight = false;
        if (this.detailDirty) this.refreshDetail();
      });
  }

  private acceptDetail(view: BackgroundJobView): void {
    const previous = this.snapshot.detail.view;
    const running = view.task.status === "running";
    const settled = previous?.task.status === "running" && !running;
    const following = previous === null ? running : this.snapshot.logs.following && running;
    this.update({
      detail: { status: "ready", view, error: null },
      logs: { ...this.snapshot.logs, following },
    });
    // A terminal transition settles the log once; then the follow timer stops.
    if (settled && this.snapshot.logs.status !== "error") this.fetchLogs("settle");
    // Only a deliberately viewed terminal job is acknowledged; a running one never is.
    if (!running && !view.seen) this.markSeen(view.task.id);
  }

  private fetchLogs(mode: LogsFetch): void {
    const ready = this.ready();
    const taskId = this.snapshot.selectedTaskId;
    if (!ready || !taskId) return;
    if (this.logsInFlight) {
      if (mode !== "tick") this.logsDirty = true;
      return;
    }
    this.logsInFlight = true;
    this.logsDirty = false;
    const epoch = this.epoch;
    void this.client
      .readBackgroundJobLogs({ ...this.address(ready), taskId, maxBytes: LOG_WINDOW_BYTES })
      .then(
        (payload) => {
          if (epoch !== this.epoch) return undefined;
          // A paused view keeps its frozen buffer.
          if (mode === "tick" && !this.snapshot.logs.following) return undefined;
          this.update({
            logs: { ...this.snapshot.logs, status: "ready", result: payload.result, error: null },
          });
          return undefined;
        },
        (error: unknown) => {
          if (epoch !== this.epoch) return;
          // A failed read stops following until the user retries deliberately.
          this.update({
            logs: {
              ...this.snapshot.logs,
              status: "error",
              error: logsFailureMessage(error),
              following: false,
            },
          });
        },
      )
      .finally(() => {
        this.logsInFlight = false;
        if (this.logsDirty) this.fetchLogs("explicit");
      });
  }

  pause(): void {
    this.update({ logs: { ...this.snapshot.logs, following: false } });
  }

  follow(): void {
    if (this.snapshot.detail.view?.task.status !== "running") return;
    this.update({ logs: { ...this.snapshot.logs, following: true } });
    this.fetchLogs("explicit");
  }

  retryLogs(): void {
    const running = this.snapshot.detail.view?.task.status === "running";
    this.update({
      logs: { ...this.snapshot.logs, status: "loading", error: null, following: running },
    });
    this.fetchLogs("explicit");
  }

  openResult(): void {
    const ready = this.ready();
    const taskId = this.snapshot.selectedTaskId;
    if (!ready || !taskId || this.snapshot.result.status === "loading") return;
    const epoch = this.epoch;
    this.update({ result: { status: "loading", view: null, error: null } });
    void this.client.readBackgroundJobResult({ ...this.address(ready), taskId }).then(
      (payload) => {
        if (epoch !== this.epoch) return undefined;
        this.update({ result: { status: "ready", view: payload.result, error: null } });
        return undefined;
      },
      (error: unknown) => {
        if (epoch !== this.epoch) return;
        this.update({
          result: { status: "error", view: null, error: resultFailureMessage(error) },
        });
      },
    );
  }

  private markSeen(taskId: string): void {
    if (this.markedSeen.has(taskId)) return;
    const address = this.controlAddress();
    if (!address) return;
    this.markedSeen.add(taskId);
    void this.client
      .markBackgroundJobsSeen({ ...address, taskIds: [taskId] })
      .catch((error: unknown) => {
        this.markedSeen.delete(taskId);
        this.update({
          action: {
            status: "failed",
            kind: "mark_seen",
            message: `Marking the job as seen failed: ${errorText(error)}`,
          },
        });
      });
  }

  // ---------------------------------------------------------------------------
  // Controls: each confirmed action uses exactly one sequence and is never retried
  // ---------------------------------------------------------------------------

  /**
   * Reserves one control intent from the first click through confirmation and response. A second
   * click while it is outstanding is ignored, never queued as another execution.
   */
  private async withIntent(kind: ActionKind, run: () => Promise<void>): Promise<void> {
    if (this.intent !== null) return;
    this.intent = kind;
    try {
      await run();
    } finally {
      this.intent = null;
    }
  }

  async stopJob(): Promise<void> {
    const view = this.snapshot.detail.view;
    const authority = this.captureAuthority();
    if (!view || !authority) return;
    await this.withIntent("stop", async () => {
      const confirmed = await this.options.confirm({
        title: "Stop background job?",
        message: `Stop “${jobTitle(view.task)}”? Its process is terminated.`,
        confirmLabel: "Stop",
        destructive: true,
      });
      if (!confirmed) return;
      const outcome = await this.runControl("stop", authority, true, async (address) => {
        const payload = await this.client.stopBackgroundJob({ ...address, taskId: view.task.id });
        return {
          message: payload.result.alreadyTerminal ? "The job had already finished" : "Stopped",
        };
      });
      // Stopped, failed or unknown: the job's actual state is re-read, never assumed.
      if (outcome !== null || this.authorityCurrent(authority, true)) this.refreshDetail();
    });
  }

  async rerunJob(): Promise<void> {
    const view = this.snapshot.detail.view;
    const authority = this.captureAuthority();
    if (!view || !view.canRerun || !authority) return;
    await this.withIntent("rerun", async () => {
      const confirmed = await this.options.confirm({
        title: "Rerun background job?",
        message: `Run this exact command again as a new job? Shell commands are not sandboxed.\n\n${view.task.command}`,
        confirmLabel: "Rerun",
        destructive: false,
      });
      if (!confirmed) return;
      const outcome = await this.runControl("rerun", authority, true, async (address) => {
        const payload = await this.client.rerunBackgroundJob({ ...address, taskId: view.task.id });
        return {
          message: `Started a new job ${payload.result.task.id}`,
          startedTaskId: payload.result.task.id,
        };
      });
      if (!outcome?.startedTaskId) return;
      const action = this.snapshot.action;
      this.select(outcome.startedTaskId);
      this.update({ action });
    });
  }

  /**
   * Freezes the exact running IDs before asking for confirmation, so a job started while the
   * dialog is open is not stopped. A selection above the per-request bound is refused explicitly;
   * a prefix is never stopped as if it were everything.
   */
  async stopAllJobs(): Promise<void> {
    const authority = this.captureAuthority();
    if (!authority) return;
    await this.withIntent("stop_all", async () => {
      let frozen: string[];
      try {
        frozen = await this.runningTaskIds(authority.ready);
      } catch (error) {
        this.reportAction(
          authority,
          "stop_all",
          `Listing running jobs failed: ${errorText(error)}`,
        );
        return;
      }
      if (!this.authorityCurrent(authority, false)) {
        this.reportAction(authority, "stop_all", STALE_INTENT);
        return;
      }
      if (frozen.length === 0) {
        this.update({
          action: { status: "done", kind: "stop_all", message: "No jobs are running" },
        });
        return;
      }
      if (frozen.length > BACKGROUND_JOBS_MAX_TASK_IDS) {
        this.reportAction(
          authority,
          "stop_all",
          `${frozen.length} jobs are running, but one confirmed stop can cover at most ${BACKGROUND_JOBS_MAX_TASK_IDS}. Nothing was stopped; stop jobs individually.`,
        );
        return;
      }
      const confirmed = await this.options.confirm({
        title: "Stop running jobs?",
        message: `Stop the ${frozen.length} job${frozen.length === 1 ? "" : "s"} running now? Jobs started after this point are not affected.`,
        confirmLabel: "Stop all",
        destructive: true,
      });
      if (!confirmed) return;
      const outcome = await this.runControl("stop_all", authority, false, async (address) => {
        const payload = await this.client.stopAllBackgroundJobs({ ...address, taskIds: frozen });
        const result = payload.result;
        return {
          message: `Stopped ${result.stopped}, already finished ${result.alreadyTerminal}, not found ${result.notFound}, failed ${result.failed}`,
        };
      });
      if (outcome) this.refreshList();
    });
  }

  /** Every page of the retained list; the full running selection is never silently clipped. */
  private async runningTaskIds(ready: BackgroundJobsReadyState): Promise<string[]> {
    const running: string[] = [];
    let cursor: string | null = null;
    do {
      const payload = await this.client.listBackgroundJobs({
        ...this.address(ready),
        ...(cursor ? { cursor } : {}),
      });
      for (const view of payload.result.tasks)
        if (view.task.status === "running") running.push(view.task.id);
      cursor = payload.result.nextCursor;
    } while (cursor !== null);
    return running;
  }

  /** A visible failure, shown only while the controller still owns the same observation. */
  private reportAction(authority: Authority, kind: ActionKind, message: string): void {
    if (authority.lifetime !== this.lifetime) return;
    this.update({ action: { status: "failed", kind, message } });
  }

  /**
   * Sends one control against the authority it was started with. If the binding, observation or
   * (for job-scoped actions) the selection changed meanwhile, nothing is sent.
   */
  private async runControl(
    kind: ActionKind,
    authority: Authority,
    selectionScoped: boolean,
    execute: (address: BackgroundJobsControlAddress) => Promise<ControlOutcome>,
  ): Promise<ControlOutcome | null> {
    if (!this.authorityCurrent(authority, selectionScoped)) {
      this.reportAction(authority, kind, STALE_INTENT);
      return null;
    }
    const address = this.sequencedAddress(authority);
    this.update({ action: { status: "pending", kind } });
    try {
      const outcome = await execute(address);
      if (!this.authorityCurrent(authority, selectionScoped)) return null;
      this.update({ action: { status: "done", kind, message: outcome.message } });
      return outcome;
    } catch (error) {
      if (!this.authorityCurrent(authority, selectionScoped)) return null;
      this.update({
        action: isUncertainOutcome(error)
          ? { status: "unknown", kind, message: UNKNOWN_OUTCOME }
          : { status: "failed", kind, message: errorText(error) },
      });
      this.refreshList();
      return null;
    }
  }

  async copy(text: string, label: string): Promise<void> {
    try {
      await this.options.copy(text);
      this.update({ action: { status: "done", kind: "copy", message: `Copied ${label}` } });
    } catch (error) {
      this.update({
        action: { status: "failed", kind: "copy", message: `Copy failed: ${errorText(error)}` },
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Follow timer
  // ---------------------------------------------------------------------------

  private followWanted(): boolean {
    const snapshot = this.snapshot;
    return (
      this.displayed &&
      this.foreground &&
      this.observation !== null &&
      snapshot.selectedTaskId !== null &&
      snapshot.logs.following &&
      snapshot.logs.status !== "error" &&
      snapshot.detail.view?.task.status === "running"
    );
  }

  private syncTimer(): void {
    const wanted = this.followWanted();
    if (wanted && this.timer === null) {
      const tick = () => this.fetchLogs("tick");
      this.timer = this.options.setInterval
        ? this.options.setInterval(tick, FOLLOW_INTERVAL_MS)
        : setInterval(tick, FOLLOW_INTERVAL_MS);
    }
    if (!wanted) this.stopTimer();
  }

  private stopTimer(): void {
    const timer = this.timer;
    if (timer === null) return;
    this.timer = null;
    if (this.options.clearInterval) this.options.clearInterval(timer);
    else clearInterval(timer);
  }
}
