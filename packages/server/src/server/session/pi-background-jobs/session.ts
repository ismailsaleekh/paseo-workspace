import {
  BackgroundJobDetailResultSchema,
  BackgroundJobLogsResultSchema,
  BackgroundJobRerunResultSchema,
  BackgroundJobResultViewSchema,
  BackgroundJobStopResultSchema,
  BackgroundJobsListResultSchema,
  BackgroundJobsMarkSeenResultSchema,
  BackgroundJobsStopAllResultSchema,
  type BackgroundJobRerunResult,
  type BackgroundJobStopResult,
  type BackgroundJobsControlRequest,
  type BackgroundJobsMarkSeenResult,
  type BackgroundJobsObserveRequest,
  type BackgroundJobsReadRequest,
  type BackgroundJobsRequest,
  type BackgroundJobsStopAllResult,
} from "@getpaseo/protocol/pi-background-jobs/rpc-schemas";
import type { SessionInboundMessage, SessionOutboundMessage } from "../../messages.js";
import type { SessionDelivery } from "../owned-subscriptions/index.js";
import {
  BackgroundJobsFailure,
  type BackgroundJobsBinding,
  type BackgroundJobsObservation,
  type PiBackgroundJobsHub,
} from "../../pi-background-jobs/hub.js";
import { MutationReplay, ReplayRefusal, canonicalJson, type ReplayOutcome } from "./replay.js";

export const BACKGROUND_JOBS_FAMILY = "pi-background-jobs";

/** The hub surface a session uses; the daemon passes the real per-agent hub. */
export type BackgroundJobsHubPort = Pick<
  PiBackgroundJobsHub,
  "observe" | "assertBinding" | "invoke"
>;

export interface BackgroundJobsSessionHost {
  hub: BackgroundJobsHubPort | undefined;
  delivery: SessionDelivery;
  reply(message: SessionOutboundMessage): void;
}

type ControlSuccess =
  | { operation: "stop"; result: BackgroundJobStopResult }
  | { operation: "rerun"; result: BackgroundJobRerunResult }
  | { operation: "stop_all"; result: BackgroundJobsStopAllResult }
  | { operation: "mark_seen"; result: BackgroundJobsMarkSeenResult };

interface Subscription {
  agentId: string;
  source: object;
  observation: BackgroundJobsObservation;
}

class JobsRequestError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "JobsRequestError";
  }
}

function asBackgroundJobsRequest(message: SessionInboundMessage): BackgroundJobsRequest | null {
  switch (message.type) {
    case "agent.background_jobs.observe.request":
    case "agent.background_jobs.list.request":
    case "agent.background_jobs.detail.request":
    case "agent.background_jobs.logs.request":
    case "agent.background_jobs.result.request":
    case "agent.background_jobs.stop.request":
    case "agent.background_jobs.rerun.request":
    case "agent.background_jobs.stop_all.request":
    case "agent.background_jobs.mark_seen.request":
      return message;
    default:
      return null;
  }
}

function bindingOf(message: BackgroundJobsReadRequest | BackgroundJobsControlRequest) {
  const binding: BackgroundJobsBinding = {
    agentId: message.agentId,
    runtimeId: message.runtimeId,
    activationId: message.activationId,
  };
  return binding;
}

function addressOf(message: BackgroundJobsReadRequest | BackgroundJobsControlRequest) {
  return {
    requestId: message.requestId,
    agentId: message.agentId,
    runtimeId: message.runtimeId,
    activationId: message.activationId,
  };
}

/**
 * Session adapter for native background jobs. Observations are source-owned subscriptions; reads
 * require an observation of the agent from the same physical source, and controls must name a
 * subscription that source owns. Every operation goes through the ordinary authorized dispatch.
 */
export class BackgroundJobsSession {
  private readonly subscriptions = new Map<string, Subscription>();
  private readonly replay = new MutationReplay<ControlSuccess>();

  constructor(private readonly host: BackgroundJobsSessionHost) {}

  handle(message: SessionInboundMessage): Promise<void> | undefined {
    const request = asBackgroundJobsRequest(message);
    if (!request) return undefined;
    return this.dispatch(request);
  }

  get subscriptionCount(): number {
    return this.subscriptions.size;
  }

  private async dispatch(message: BackgroundJobsRequest): Promise<void> {
    try {
      if (message.type === "agent.background_jobs.observe.request") {
        await this.observe(message);
        return;
      }
      if (isControl(message)) {
        await this.control(message);
        return;
      }
      await this.read(message);
    } catch (error) {
      if (
        !(
          error instanceof BackgroundJobsFailure ||
          error instanceof ReplayRefusal ||
          error instanceof JobsRequestError
        )
      )
        throw error;
      this.fail(message, error.code, error.message);
    }
  }

  private fail(message: BackgroundJobsRequest, code: string, error: string): void {
    this.host.reply({
      type: "rpc_error",
      payload: { requestId: message.requestId, requestType: message.type, code, error },
    });
  }

  private requireHub(): BackgroundJobsHubPort {
    const hub = this.host.hub;
    if (!hub) throw new JobsRequestError("UNSUPPORTED_HOST", "This daemon has no background jobs");
    return hub;
  }

  private requireModernSource(): object {
    const source = this.host.delivery.currentSource;
    if (!source || !this.host.delivery.isModern(source))
      throw new JobsRequestError(
        "UNSUPPORTED_CLIENT",
        "Background jobs require source-owned subscriptions",
      );
    return source;
  }

  private async observe(message: BackgroundJobsObserveRequest): Promise<void> {
    const hub = this.requireHub();
    this.requireModernSource();
    let observation: BackgroundJobsObservation | null = null;
    const owner = this.host.delivery.begin(BACKGROUND_JOBS_FAMILY, undefined, (id) => {
      observation?.release();
      this.subscriptions.delete(id);
      this.replay.forgetPrefix(`${id}\u0000`);
    });
    const agentId = message.agentId;
    let version = 0;
    const prefix = `${owner.id}\u0000`;
    observation = hub.observe(agentId, (state) => {
      // A new generation retires the previous generation's replay ledger. Its controls are
      // already refused by the binding check before any replay lookup.
      if (state.status === "ready")
        this.replay.retainOnly(prefix, `${prefix}${state.runtimeId}\u0000${state.activationId}`);
      version += 1;
      owner.emit({
        type: "agent.background_jobs.update",
        payload: { subscriptionId: owner.id, agentId, version, state },
      });
    });
    const initial = observation.state;
    if (initial.status === "ready")
      this.replay.retainOnly(prefix, `${prefix}${initial.runtimeId}\u0000${initial.activationId}`);
    this.subscriptions.set(owner.id, { agentId, source: owner.source, observation });
    this.host.reply({
      type: "agent.background_jobs.observe.response",
      payload: {
        requestId: message.requestId,
        agentId,
        subscriptionId: owner.id,
        version: 0,
        state: initial,
      },
    });
  }

  /** Live replay ledgers; at most one generation per retained observation. */
  get replayScopeCount(): number {
    return this.replay.scopeCount;
  }

  private requireObservation(agentId: string): void {
    const source = this.requireModernSource();
    for (const subscription of this.subscriptions.values())
      if (subscription.source === source && subscription.agentId === agentId) return;
    throw new JobsRequestError(
      "NOT_OBSERVED",
      "Observe this agent's background jobs from this connection before reading them",
    );
  }

  private async read(message: BackgroundJobsReadRequest): Promise<void> {
    const hub = this.requireHub();
    this.requireObservation(message.agentId);
    const binding = bindingOf(message);
    const address = addressOf(message);
    switch (message.type) {
      case "agent.background_jobs.list.request": {
        const payload: Record<string, unknown> = {};
        if (message.cursor !== undefined) payload["cursor"] = message.cursor;
        if (message.limit !== undefined) payload["limit"] = message.limit;
        const result = await hub.invoke(binding, "list", payload, BackgroundJobsListResultSchema);
        this.host.reply({
          type: "agent.background_jobs.list.response",
          payload: { ...address, result },
        });
        return;
      }
      case "agent.background_jobs.detail.request": {
        const result = await hub.invoke(
          binding,
          "detail",
          { taskId: message.taskId },
          BackgroundJobDetailResultSchema,
        );
        this.host.reply({
          type: "agent.background_jobs.detail.response",
          payload: { ...address, result },
        });
        return;
      }
      case "agent.background_jobs.logs.request": {
        const payload: Record<string, unknown> = { taskId: message.taskId };
        if (message.maxBytes !== undefined) payload["maxBytes"] = message.maxBytes;
        if (message.tail !== undefined) payload["tail"] = message.tail;
        const result = await hub.invoke(binding, "logs", payload, BackgroundJobLogsResultSchema);
        this.host.reply({
          type: "agent.background_jobs.logs.response",
          payload: { ...address, result },
        });
        return;
      }
      case "agent.background_jobs.result.request": {
        const result = await hub.invoke(
          binding,
          "result",
          { taskId: message.taskId },
          BackgroundJobResultViewSchema,
        );
        this.host.reply({
          type: "agent.background_jobs.result.response",
          payload: { ...address, result },
        });
        return;
      }
    }
  }

  private requireOwnedSubscription(message: BackgroundJobsControlRequest): void {
    const source = this.requireModernSource();
    const subscription = this.subscriptions.get(message.subscriptionId);
    if (!subscription || subscription.source !== source || subscription.agentId !== message.agentId)
      throw new JobsRequestError(
        "FOREIGN_SUBSCRIPTION",
        "Controls must name a live background jobs subscription owned by this connection",
      );
  }

  private async control(message: BackgroundJobsControlRequest): Promise<void> {
    const hub = this.requireHub();
    this.requireOwnedSubscription(message);
    const binding = bindingOf(message);
    hub.assertBinding(binding);
    const selection = selectionOf(message);
    if ("taskIds" in selection && new Set(selection.taskIds).size !== selection.taskIds.length)
      throw new JobsRequestError("INVALID_REQUEST", "Task IDs must be unique");
    const scope = `${message.subscriptionId}\u0000${message.runtimeId}\u0000${message.activationId}`;
    const fingerprint = canonicalJson({ type: message.type, ...binding, ...selection });
    const outcome = await this.replay.run(scope, message.sequence, fingerprint, () =>
      this.execute(hub, binding, message, selection),
    );
    if (!outcome.ok) {
      this.fail(message, outcome.code, outcome.message);
      return;
    }
    this.replyControl(message, outcome.value);
  }

  private async execute(
    hub: BackgroundJobsHubPort,
    binding: BackgroundJobsBinding,
    message: BackgroundJobsControlRequest,
    selection: Record<string, unknown>,
  ): Promise<ReplayOutcome<ControlSuccess>> {
    try {
      return { ok: true, value: await this.executeControl(hub, binding, message, selection) };
    } catch (error) {
      if (!(error instanceof BackgroundJobsFailure)) throw error;
      return { ok: false, code: error.code, message: error.message };
    }
  }

  private async executeControl(
    hub: BackgroundJobsHubPort,
    binding: BackgroundJobsBinding,
    message: BackgroundJobsControlRequest,
    selection: Record<string, unknown>,
  ): Promise<ControlSuccess> {
    switch (message.type) {
      case "agent.background_jobs.stop.request":
        return {
          operation: "stop",
          result: await hub.invoke(binding, "stop", selection, BackgroundJobStopResultSchema),
        };
      case "agent.background_jobs.rerun.request":
        return {
          operation: "rerun",
          result: await hub.invoke(binding, "rerun", selection, BackgroundJobRerunResultSchema),
        };
      case "agent.background_jobs.stop_all.request":
        return {
          operation: "stop_all",
          result: await hub.invoke(
            binding,
            "stop_all",
            selection,
            BackgroundJobsStopAllResultSchema,
          ),
        };
      case "agent.background_jobs.mark_seen.request":
        return {
          operation: "mark_seen",
          result: await hub.invoke(
            binding,
            "mark_seen",
            selection,
            BackgroundJobsMarkSeenResultSchema,
          ),
        };
    }
  }

  private replyControl(message: BackgroundJobsControlRequest, success: ControlSuccess): void {
    const address = addressOf(message);
    switch (success.operation) {
      case "stop":
        this.host.reply({
          type: "agent.background_jobs.stop.response",
          payload: { ...address, result: success.result },
        });
        return;
      case "rerun":
        this.host.reply({
          type: "agent.background_jobs.rerun.response",
          payload: { ...address, result: success.result },
        });
        return;
      case "stop_all":
        this.host.reply({
          type: "agent.background_jobs.stop_all.response",
          payload: { ...address, result: success.result },
        });
        return;
      case "mark_seen":
        this.host.reply({
          type: "agent.background_jobs.mark_seen.response",
          payload: { ...address, result: success.result },
        });
        return;
    }
  }
}

function selectionOf(
  message: BackgroundJobsControlRequest,
): { taskIds: string[] } | { taskId: string } {
  switch (message.type) {
    case "agent.background_jobs.stop_all.request":
    case "agent.background_jobs.mark_seen.request":
      return { taskIds: message.taskIds };
    case "agent.background_jobs.stop.request":
    case "agent.background_jobs.rerun.request":
      return { taskId: message.taskId };
  }
}

function isControl(message: BackgroundJobsRequest): message is BackgroundJobsControlRequest {
  return (
    message.type === "agent.background_jobs.stop.request" ||
    message.type === "agent.background_jobs.rerun.request" ||
    message.type === "agent.background_jobs.stop_all.request" ||
    message.type === "agent.background_jobs.mark_seen.request"
  );
}
