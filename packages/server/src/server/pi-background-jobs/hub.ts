import { z } from "zod";
import type { Logger } from "pino";
import {
  BackgroundJobCountsSchema,
  type BackgroundJobCounts,
  type BackgroundJobsState,
} from "@getpaseo/protocol/pi-background-jobs/rpc-schemas";
import type {
  BridgeHostPresence,
  BridgeLeasedOperation,
} from "../agent/providers/pi/background-jobs-bridge/protocol.js";
import {
  BackgroundJobsAttachment,
  type BackgroundJobsAttachmentHost,
  type BridgeCallOutcome,
  type BridgePeer,
  type BridgePeerFrame,
  type PiBackgroundJobsLease,
} from "./attachment.js";
import { loadBackgroundJobsBridgeArtifact, materializeBackgroundJobsBridge } from "./artifact.js";

/** Per runtime, matching the generic host's own admission bound. */
const MAX_IN_FLIGHT = 16;

const HostActivationFactsSchema = z.object({
  activationId: z.string().min(1).max(128),
  sessionId: z.string().min(1),
  revision: z.number().int().nonnegative(),
  observedAt: z.number(),
  counts: BackgroundJobCountsSchema,
});
const HostChangedSchema = HostActivationFactsSchema.extend({
  schema_version: z.literal("pi-background-tasks.host-changed.v1"),
  kind: z.enum(["ready", "changed", "closed"]),
});
const HostSubscribeResultSchema = HostActivationFactsSchema.extend({
  leaseId: z.string().min(1).max(128),
});
const ResultFactsSchema = z.object({
  revision: z.number().int().nonnegative(),
  counts: BackgroundJobCountsSchema,
  activationId: z.string().optional(),
});

export type BackgroundJobsOperation = BridgeLeasedOperation;

export class BackgroundJobsFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "BackgroundJobsFailure";
  }
}

export type BackgroundJobsAgentAvailability =
  | { kind: "pi" }
  | { kind: "unknown" }
  | { kind: "not_running" }
  | { kind: "unsupported_provider" };

export interface BackgroundJobsBinding {
  agentId: string;
  runtimeId: string;
  activationId: string;
}

export interface BackgroundJobsObservation {
  readonly state: BackgroundJobsState;
  release(): void;
}

interface ActivationFacts {
  activationId: string;
  sessionId: string;
  revision: number;
  observedAt: number;
  counts: BackgroundJobCounts;
}

interface Runtime {
  readonly agentId: string;
  readonly runtimeId: string;
  peer: BridgePeer | null;
  everConnected: boolean;
  presence: BridgeHostPresence | null;
  activation: ActivationFacts | null;
  lease: "none" | "pending" | "ready" | "refused";
  /** Why the host last refused a lease; cleared only by a new host signal or deliberate demand. */
  leaseFailure: { code: string; message: string } | null;
  leaseRequest: Promise<void> | null;
  inFlight: number;
  ended: boolean;
}

interface Observer {
  listener(state: BackgroundJobsState): void;
  last: string;
}

interface AgentRecord {
  readonly agentId: string;
  readonly observers: Set<Observer>;
  runtime: Runtime | null;
}

export interface PiBackgroundJobsHubOptions {
  paseoHome: string;
  describeAgent(agentId: string): BackgroundJobsAgentAvailability;
  logger: Pick<Logger, "warn" | "error">;
  /** Overrides where the bundled bridge is looked up; tests point it at a production layout. */
  moduleUrl?: string;
}

/**
 * Daemon-level, runtime-stable per-agent jobs hub. It owns transport, observations and view state,
 * never processes or scheduling: every read and control is one call to the runtime's own registry
 * through the private bridge. Observations survive runtime replacement, so an observer sees
 * ended -> fresh ready. Opening a panel never starts or resumes an agent.
 */
export class PiBackgroundJobsHub implements BackgroundJobsAttachmentHost {
  private readonly attachment = new BackgroundJobsAttachment(this);
  private readonly records = new Map<string, AgentRecord>();
  private readonly runtimes = new Map<string, Runtime>();
  private extensionPath: string | null = null;
  private unsupported: string | null = null;

  constructor(private readonly options: PiBackgroundJobsHubOptions) {}

  async start(): Promise<void> {
    if (process.platform === "win32") {
      this.unsupported = "Native background jobs are not available on Windows hosts yet";
      return;
    }
    const artifact = await loadBackgroundJobsBridgeArtifact(this.options.moduleUrl);
    this.extensionPath = await materializeBackgroundJobsBridge(this.options.paseoHome, artifact);
    await this.attachment.start();
  }

  async stop(): Promise<void> {
    this.extensionPath = null;
    await this.attachment.stop();
  }

  /** A fresh capability for one interactive Pi launch, or none on an unsupported host. */
  issue(agentId: string): PiBackgroundJobsLease | undefined {
    const extensionPath = this.extensionPath;
    if (!extensionPath || !this.attachment.listening) return undefined;
    return this.attachment.issue(agentId, extensionPath);
  }

  observe(
    agentId: string,
    listener: (state: BackgroundJobsState) => void,
  ): BackgroundJobsObservation {
    const record = this.record(agentId);
    const observer: Observer = { listener, last: "" };
    const state = this.stateOf(record);
    observer.last = JSON.stringify(state);
    record.observers.add(observer);
    // A new observation is deliberate demand: it may retry a refused lease once.
    if (record.runtime) this.allowLeaseRetry(record.runtime);
    // Lease work starts after the caller has delivered the initial state.
    queueMicrotask(() => this.reconcile(record));
    return {
      state,
      release: () => {
        if (!record.observers.delete(observer)) return;
        this.reconcile(record);
        this.forget(record);
      },
    };
  }

  /** Fails before any host call when the address is not the agent's current runtime/activation. */
  assertBinding(binding: BackgroundJobsBinding): void {
    this.requireRuntime(binding);
  }

  /**
   * One host operation on the current runtime. The generic result is validated and narrowed to the
   * exact native view by `schema`; an invalid result is a typed failure, never passed through.
   */
  async invoke<S extends z.ZodType>(
    binding: BackgroundJobsBinding,
    operation: BackgroundJobsOperation,
    payload: Record<string, unknown>,
    schema: S,
  ): Promise<z.output<S>> {
    const runtime = this.requireRuntime(binding);
    await this.awaitLease(runtime);
    this.requireRuntime(binding);
    const peer = runtime.peer;
    if (!peer || runtime.lease !== "ready")
      throw new BackgroundJobsFailure(
        "UNAVAILABLE",
        "The background task host has no live lease for this runtime",
      );
    if (runtime.inFlight >= MAX_IN_FLIGHT)
      throw new BackgroundJobsFailure("BUSY", "Too many background job operations are in flight");
    runtime.inFlight += 1;
    let outcome: BridgeCallOutcome;
    try {
      outcome = await peer.call(operation, binding.activationId, payload);
    } finally {
      runtime.inFlight -= 1;
    }
    if (!outcome.ok) {
      if (outcome.error.code === "LEASE_INVALID" || outcome.error.code === "LEASE_UNAVAILABLE")
        this.dropLease(runtime);
      throw new BackgroundJobsFailure(outcome.error.code, outcome.error.message);
    }
    const parsed = schema.safeParse(outcome.result);
    if (!parsed.success)
      throw new BackgroundJobsFailure(
        "INVALID_HOST_RESULT",
        `The background task host returned an invalid ${operation} result`,
      );
    this.absorbResult(runtime, outcome.result);
    return parsed.data;
  }

  // -------------------------------------------------------------------------
  // Attachment events
  // -------------------------------------------------------------------------

  activated(input: { agentId: string; runtimeId: string }): void {
    const record = this.record(input.agentId);
    const previous = record.runtime;
    if (previous && !previous.ended) this.endRuntime(previous);
    const runtime: Runtime = {
      agentId: input.agentId,
      runtimeId: input.runtimeId,
      peer: null,
      everConnected: false,
      presence: null,
      activation: null,
      lease: "none",
      leaseFailure: null,
      leaseRequest: null,
      inFlight: 0,
      ended: false,
    };
    this.runtimes.set(runtime.runtimeId, runtime);
    record.runtime = runtime;
    this.publish(record);
  }

  connected(peer: BridgePeer): void {
    const runtime = this.runtimes.get(peer.runtimeId);
    if (!runtime || runtime.ended) return;
    runtime.peer = peer;
    runtime.everConnected = true;
    runtime.presence = null;
    runtime.activation = null;
    runtime.lease = "none";
    runtime.leaseFailure = null;
    runtime.leaseRequest = null;
    this.publishRuntime(runtime);
  }

  received(peer: BridgePeer, frame: BridgePeerFrame): void {
    const runtime = this.runtimes.get(peer.runtimeId);
    if (!runtime || runtime.ended || runtime.peer !== peer) return;
    if (frame.kind === "host") {
      runtime.presence = frame.presence;
      this.publishRuntime(runtime);
      return;
    }
    const parsed = HostChangedSchema.safeParse(frame.change);
    if (!parsed.success || parsed.data.sessionId !== peer.sessionId) {
      this.options.logger.warn(
        { runtimeId: runtime.runtimeId },
        "Ignored an invalid background task host change frame",
      );
      return;
    }
    this.applyChange(runtime, parsed.data);
  }

  disconnected(peer: BridgePeer): void {
    const runtime = this.runtimes.get(peer.runtimeId);
    if (!runtime || runtime.peer !== peer) return;
    runtime.peer = null;
    runtime.lease = "none";
    runtime.leaseRequest = null;
    this.publishRuntime(runtime);
  }

  revoked(runtimeId: string): void {
    const runtime = this.runtimes.get(runtimeId);
    if (runtime) this.endRuntime(runtime);
  }

  reportFailure(error: unknown): void {
    this.options.logger.error({ err: error }, "Pi background jobs attachment failed");
  }

  // -------------------------------------------------------------------------
  // State
  // -------------------------------------------------------------------------

  private record(agentId: string): AgentRecord {
    let record = this.records.get(agentId);
    if (!record) {
      record = { agentId, observers: new Set(), runtime: null };
      this.records.set(agentId, record);
    }
    return record;
  }

  private forget(record: AgentRecord): void {
    const runtime = record.runtime;
    if (record.observers.size === 0 && (!runtime || runtime.ended))
      this.records.delete(record.agentId);
  }

  private endRuntime(runtime: Runtime): void {
    if (runtime.ended) return;
    runtime.ended = true;
    runtime.peer = null;
    runtime.lease = "none";
    runtime.leaseRequest = null;
    runtime.activation = null;
    this.runtimes.delete(runtime.runtimeId);
    const record = this.records.get(runtime.agentId);
    if (!record) return;
    this.publish(record);
    this.forget(record);
  }

  private stateOf(record: AgentRecord): BackgroundJobsState {
    if (this.unsupported) return { status: "unsupported", message: this.unsupported };
    const runtime = record.runtime;
    if (runtime?.ended)
      return {
        status: "ended",
        runtimeId: runtime.runtimeId,
        message: "The Pi runtime ended; its jobs are not adopted by a new runtime",
      };
    if (!runtime) return this.unavailableState(record.agentId);
    return runtimeState(runtime);
  }

  private unavailableState(agentId: string): BackgroundJobsState {
    const availability = this.options.describeAgent(agentId);
    switch (availability.kind) {
      case "unknown":
        return { status: "unavailable", reason: "unknown_agent", message: "Unknown agent" };
      case "unsupported_provider":
        return {
          status: "unavailable",
          reason: "unsupported_provider",
          message: "Background jobs belong to Pi agents",
        };
      case "not_running":
      case "pi":
        return {
          status: "unavailable",
          reason: "not_running",
          message: "The Pi runtime is not running; send a message to start it",
        };
    }
  }

  private publishRuntime(runtime: Runtime): void {
    const record = this.records.get(runtime.agentId);
    if (record?.runtime === runtime) this.publish(record);
  }

  private publish(record: AgentRecord): void {
    const state = this.stateOf(record);
    const serialized = JSON.stringify(state);
    for (const observer of record.observers) {
      if (observer.last === serialized) continue;
      observer.last = serialized;
      observer.listener(state);
    }
    this.reconcile(record);
  }

  private applyChange(runtime: Runtime, change: z.infer<typeof HostChangedSchema>): void {
    const current = runtime.activation;
    const sameActivation = current !== null && current.activationId === change.activationId;
    if (change.kind === "closed") {
      if (!sameActivation) return;
      runtime.activation = null;
      runtime.lease = "none";
      runtime.leaseRequest = null;
      this.publishRuntime(runtime);
      return;
    }
    if (current && sameActivation && change.revision < current.revision) return;
    if (!sameActivation || change.kind === "ready") {
      // A fresh activation, or a fresh ready announcement, is the host signal that may grant a
      // lease the host refused before. The bridge dropped any lease of an older activation.
      if (!sameActivation || runtime.lease === "refused") {
        runtime.lease = "none";
        runtime.leaseRequest = null;
      }
      runtime.leaseFailure = null;
    }
    runtime.presence = "available";
    runtime.activation = factsOf(change);
    this.publishRuntime(runtime);
  }

  private absorbResult(runtime: Runtime, result: unknown): void {
    const activation = runtime.activation;
    if (!activation) return;
    const facts = ResultFactsSchema.safeParse(result);
    if (!facts.success || facts.data.revision < activation.revision) return;
    const reported = facts.data.activationId;
    if (reported !== undefined && reported !== activation.activationId) return;
    runtime.activation = {
      ...activation,
      revision: facts.data.revision,
      counts: facts.data.counts,
    };
    this.publishRuntime(runtime);
  }

  // -------------------------------------------------------------------------
  // Host lease: held only while the agent has observers
  // -------------------------------------------------------------------------

  private reconcile(record: AgentRecord): void {
    const runtime = record.runtime;
    if (!runtime || runtime.ended || !runtime.peer) return;
    const wanted = record.observers.size > 0 && runtime.activation !== null;
    if (wanted && runtime.lease === "none") this.acquireLease(runtime, runtime.peer);
    if (!wanted && runtime.lease === "ready") this.releaseLease(runtime, runtime.peer);
  }

  private acquireLease(runtime: Runtime, peer: BridgePeer): void {
    runtime.lease = "pending";
    const request = peer.call("subscribe", null, {}).then((outcome) => {
      if (runtime.peer !== peer || runtime.ended || runtime.leaseRequest !== request)
        return undefined;
      runtime.leaseRequest = null;
      const parsed = outcome.ok ? HostSubscribeResultSchema.safeParse(outcome.result) : null;
      if (!parsed?.success) {
        // Refusal is a visible state, not a hot retry: only a new host signal or deliberate
        // demand (a new observation or user operation) asks again.
        runtime.lease = "refused";
        runtime.leaseFailure = outcome.ok
          ? { code: "INVALID_HOST_RESULT", message: "The host returned an invalid lease" }
          : outcome.error;
        this.options.logger.warn(
          { runtimeId: runtime.runtimeId, code: runtime.leaseFailure.code },
          "Background task host lease was refused",
        );
        this.publishRuntime(runtime);
        return undefined;
      }
      runtime.lease = "ready";
      runtime.leaseFailure = null;
      const current = runtime.activation;
      if (
        !current ||
        current.activationId !== parsed.data.activationId ||
        parsed.data.revision >= current.revision
      )
        runtime.activation = factsOf(parsed.data);
      this.publishRuntime(runtime);
      return undefined;
    });
    runtime.leaseRequest = request;
  }

  private releaseLease(runtime: Runtime, peer: BridgePeer): void {
    runtime.lease = "none";
    void peer.call("unsubscribe", null, {}).then((outcome) => {
      if (!outcome.ok)
        this.options.logger.warn(
          { runtimeId: runtime.runtimeId, code: outcome.error.code },
          "Background task host lease release failed",
        );
      return undefined;
    });
  }

  private dropLease(runtime: Runtime): void {
    if (runtime.lease !== "ready") return;
    runtime.lease = "none";
    this.publishRuntime(runtime);
  }

  private allowLeaseRetry(runtime: Runtime): void {
    if (runtime.lease !== "refused") return;
    runtime.lease = "none";
    runtime.leaseFailure = null;
  }

  private async awaitLease(runtime: Runtime): Promise<void> {
    // A user operation is deliberate demand: one fresh attempt after a refusal.
    this.allowLeaseRetry(runtime);
    if (runtime.lease === "none") {
      const record = this.records.get(runtime.agentId);
      if (record) this.reconcile(record);
    }
    if (runtime.leaseRequest) await runtime.leaseRequest;
  }

  private requireRuntime(binding: BackgroundJobsBinding): Runtime {
    const runtime = this.records.get(binding.agentId)?.runtime;
    if (!runtime || runtime.ended || runtime.runtimeId !== binding.runtimeId)
      throw new BackgroundJobsFailure(
        "STALE_RUNTIME",
        "The request names a runtime that is no longer current for this agent",
      );
    if (!runtime.peer)
      throw new BackgroundJobsFailure("UNAVAILABLE", "The runtime bridge is not connected");
    if (runtime.activation?.activationId !== binding.activationId)
      throw new BackgroundJobsFailure(
        "STALE_ACTIVATION",
        "The request names a host activation that is no longer current",
      );
    return runtime;
  }
}

function factsOf(value: ActivationFacts): ActivationFacts {
  return {
    activationId: value.activationId,
    sessionId: value.sessionId,
    revision: value.revision,
    observedAt: value.observedAt,
    counts: value.counts,
  };
}

function runtimeState(runtime: Runtime): BackgroundJobsState {
  if (!runtime.peer)
    return runtime.everConnected
      ? {
          status: "error",
          runtimeId: runtime.runtimeId,
          code: "BRIDGE_DISCONNECTED",
          message: "The Pi runtime's jobs bridge disconnected",
        }
      : { status: "initializing", runtimeId: runtime.runtimeId };
  const activation = runtime.activation;
  if (runtime.lease === "refused" && runtime.leaseFailure)
    return {
      status: "error",
      runtimeId: runtime.runtimeId,
      code: runtime.leaseFailure.code,
      message: `The background task host refused this view: ${runtime.leaseFailure.message}`,
    };
  if (activation) return { status: "ready", runtimeId: runtime.runtimeId, ...factsOf(activation) };
  if (runtime.presence === "missing")
    return {
      status: "missing",
      runtimeId: runtime.runtimeId,
      message: "pi-background-tasks is not installed in this Pi runtime",
    };
  if (runtime.presence === "outdated")
    return {
      status: "outdated",
      runtimeId: runtime.runtimeId,
      message: "Update pi-background-tasks to a version with the host interface",
    };
  return { status: "initializing", runtimeId: runtime.runtimeId };
}
