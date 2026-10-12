import { z } from "zod";

/**
 * Native background-jobs RPCs (`agent.background_jobs.*`).
 *
 * The daemon narrows the generic pi-background-tasks host-v1 data to this exact view and validates
 * it at the bridge boundary. Requests are closed objects; responses are open so a newer daemon may
 * add fields without breaking an older app.
 */

export const BACKGROUND_JOBS_MAX_PAGE_SIZE = 50;
export const BACKGROUND_JOBS_MAX_LOG_BYTES = 65536;
export const BACKGROUND_JOBS_MAX_TASK_IDS = 1000;
export const BACKGROUND_JOBS_MAX_INLINE_RESULT_BYTES = 49152;

const IdentitySchema = z.string().min(1).max(128);
const AgentIdSchema = z.string().min(1).max(256);
const TaskIdSchema = z.string().min(1).max(128);
const SequenceSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const CountSchema = z.number().int().nonnegative();

export const BackgroundJobCountsSchema = z.object({
  running: CountSchema,
  completed: CountSchema,
  failed: CountSchema,
  killed: CountSchema,
  unseenCompleted: CountSchema,
  unseenFailed: CountSchema,
  unseenKilled: CountSchema,
  total: CountSchema,
});

export const BackgroundJobStatusSchema = z.enum(["running", "completed", "failed", "killed"]);
export const BackgroundJobKindSchema = z.enum([
  "shell",
  "agent-shell",
  "delegate",
  "fusion",
  "attested",
  "managed",
]);

/** Task-owned telemetry only. Absent telemetry stays absent; it is never zero or a parent value. */
const ContextUsageSchema = z.object({
  tokens: z.number().nullable(),
  contextWindow: z.number(),
  percent: z.number().nullable(),
});
const TokenUsageSchema = z.object({
  input: z.number(),
  output: z.number(),
  cacheRead: z.number(),
  cacheWrite: z.number(),
  totalTokens: z.number(),
  costTotal: z.number().optional(),
});
const ToolUsageSchema = z.object({
  total: z.number(),
  failed: z.number(),
});
const OutcomeStatusSchema = z.enum(["committed", "failed", "cancelled"]);
const DelegateFactsSchema = z.object({
  route: z.object({ provider: z.string(), model: z.string() }),
  autoDeliver: z.enum(["never", "when_small", "always"]),
  outcome: z
    .object({
      status: OutcomeStatusSchema,
      errorCode: z.string().optional(),
      answerBytes: z.number().optional(),
    })
    .optional(),
});
const FusionFactsSchema = z.object({
  workflow: z.string(),
  state: z.string(),
  outcome: z.object({ status: OutcomeStatusSchema, error: z.string().optional() }).optional(),
});

export const BackgroundJobSchema = z.object({
  id: TaskIdSchema,
  name: z.string().optional(),
  command: z.string(),
  description: z.string().optional(),
  status: BackgroundJobStatusSchema,
  outputPath: z.string(),
  cwd: z.string(),
  startTime: z.number(),
  endTime: z.number().optional(),
  exitCode: z.number().nullable().optional(),
  signal: z.string().nullable().optional(),
  pid: z.number().optional(),
  bytesWritten: z.number(),
  isAgent: z.boolean(),
  surviveReload: z.boolean(),
  error: z.string().optional(),
  notifyOnCompletion: z.boolean(),
  triggerOnCompletion: z.boolean(),
  timeoutSeconds: z.number().optional(),
  contextUsage: ContextUsageSchema.optional(),
  tokenUsage: TokenUsageSchema.optional(),
  toolUsage: ToolUsageSchema.optional(),
  model: z.string().optional(),
  telemetryUnavailableReason: z.string().optional(),
  delegate: DelegateFactsSchema.optional(),
  fusion: FusionFactsSchema.optional(),
});

export const BackgroundJobViewSchema = z.object({
  task: BackgroundJobSchema,
  kind: BackgroundJobKindSchema,
  seen: z.boolean(),
  canRerun: z.boolean(),
  canReadResult: z.boolean(),
  truncatedFields: z.array(z.enum(["command", "description", "error"])).max(3),
});

export const BackgroundJobsListResultSchema = z.object({
  activationId: IdentitySchema,
  sessionId: z.string(),
  revision: CountSchema,
  observedAt: z.number(),
  counts: BackgroundJobCountsSchema,
  tasks: z.array(BackgroundJobViewSchema).max(BACKGROUND_JOBS_MAX_PAGE_SIZE),
  nextCursor: z.string().nullable(),
});
export const BackgroundJobDetailResultSchema = z.object({ task: BackgroundJobViewSchema });
export const BackgroundJobLogsResultSchema = z.object({
  task: BackgroundJobSchema,
  path: z.string(),
  text: z.string(),
  tail: z.boolean(),
  maxBytes: z.number().int().positive(),
  bytesRead: CountSchema,
  totalBytes: CountSchema,
  windowStart: CountSchema,
  windowEnd: CountSchema,
  truncated: z.boolean(),
  bytesWritten: CountSchema,
});
export const BackgroundJobStopResultSchema = z.object({
  task: BackgroundJobSchema,
  alreadyTerminal: z.boolean(),
});
export const BackgroundJobsStopAllResultSchema = z.object({
  results: z
    .array(
      z.object({
        taskId: TaskIdSchema,
        outcome: z.enum(["stopped", "already_terminal", "not_found", "failed"]),
        status: BackgroundJobStatusSchema.optional(),
        error: z.string().optional(),
      }),
    )
    .max(BACKGROUND_JOBS_MAX_TASK_IDS),
  stopped: CountSchema,
  alreadyTerminal: CountSchema,
  notFound: CountSchema,
  failed: CountSchema,
});
export const BackgroundJobRerunResultSchema = z.object({
  sourceTaskId: TaskIdSchema,
  task: BackgroundJobSchema,
});
const ResultKindSchema = z.enum(["delegate", "fusion"]);
export const BackgroundJobResultViewSchema = z.discriminatedUnion("state", [
  z.object({
    taskId: TaskIdSchema,
    kind: ResultKindSchema,
    state: z.literal("running"),
    delivery: z.literal("none"),
  }),
  z.object({
    taskId: TaskIdSchema,
    kind: ResultKindSchema,
    state: z.literal("committed"),
    delivery: z.enum(["inline", "artifact"]),
    answerBytes: CountSchema,
    answerSha256: z.string(),
    artifactPath: z.string(),
    text: z.string().max(BACKGROUND_JOBS_MAX_INLINE_RESULT_BYTES).optional(),
  }),
  z.object({
    taskId: TaskIdSchema,
    kind: ResultKindSchema,
    state: z.literal("failed"),
    delivery: z.literal("none"),
    errorCode: z.string().optional(),
    message: z.string().optional(),
  }),
  z.object({
    taskId: TaskIdSchema,
    kind: ResultKindSchema,
    state: z.literal("cancelled"),
    delivery: z.literal("none"),
    errorCode: z.string().optional(),
    message: z.string().optional(),
  }),
]);
export const BackgroundJobsMarkSeenResultSchema = z.object({
  results: z
    .array(
      z.object({
        taskId: TaskIdSchema,
        outcome: z.enum(["marked", "already_seen", "not_terminal", "not_found"]),
      }),
    )
    .max(BACKGROUND_JOBS_MAX_TASK_IDS),
  revision: CountSchema,
  counts: BackgroundJobCountsSchema,
});

/**
 * Per-agent availability. Each state is distinct: an absent package, an old v1-only package, an
 * initializing host and an ended runtime are never reported as an empty successful list.
 */
export const BackgroundJobsStateSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("unavailable"),
    reason: z.enum(["unknown_agent", "not_running", "unsupported_provider"]),
    message: z.string(),
  }),
  z.object({ status: z.literal("unsupported"), message: z.string() }),
  z.object({ status: z.literal("initializing"), runtimeId: IdentitySchema }),
  z.object({ status: z.literal("missing"), runtimeId: IdentitySchema, message: z.string() }),
  z.object({ status: z.literal("outdated"), runtimeId: IdentitySchema, message: z.string() }),
  z.object({
    status: z.literal("ready"),
    runtimeId: IdentitySchema,
    activationId: IdentitySchema,
    sessionId: z.string(),
    revision: CountSchema,
    observedAt: z.number(),
    counts: BackgroundJobCountsSchema,
  }),
  z.object({ status: z.literal("ended"), runtimeId: IdentitySchema, message: z.string() }),
  z.object({
    status: z.literal("error"),
    runtimeId: IdentitySchema.nullable(),
    code: z.string(),
    message: z.string(),
  }),
]);

// ---------------------------------------------------------------------------
// Requests (closed)
// ---------------------------------------------------------------------------

const ReadAddress = {
  requestId: z.string(),
  agentId: AgentIdSchema,
  runtimeId: IdentitySchema,
  activationId: IdentitySchema,
};
const ControlAddress = {
  ...ReadAddress,
  subscriptionId: IdentitySchema,
  sequence: SequenceSchema,
};
const TaskIdsSchema = z.array(TaskIdSchema).min(1).max(BACKGROUND_JOBS_MAX_TASK_IDS);

export const BackgroundJobsObserveRequestSchema = z.strictObject({
  type: z.literal("agent.background_jobs.observe.request"),
  requestId: z.string(),
  agentId: AgentIdSchema,
});
export const BackgroundJobsListRequestSchema = z.strictObject({
  type: z.literal("agent.background_jobs.list.request"),
  ...ReadAddress,
  cursor: z.string().min(1).max(512).optional(),
  limit: z.number().int().min(1).max(BACKGROUND_JOBS_MAX_PAGE_SIZE).optional(),
});
export const BackgroundJobDetailRequestSchema = z.strictObject({
  type: z.literal("agent.background_jobs.detail.request"),
  ...ReadAddress,
  taskId: TaskIdSchema,
});
export const BackgroundJobLogsRequestSchema = z.strictObject({
  type: z.literal("agent.background_jobs.logs.request"),
  ...ReadAddress,
  taskId: TaskIdSchema,
  maxBytes: z.number().int().min(1).max(BACKGROUND_JOBS_MAX_LOG_BYTES).optional(),
  tail: z.boolean().optional(),
});
export const BackgroundJobResultRequestSchema = z.strictObject({
  type: z.literal("agent.background_jobs.result.request"),
  ...ReadAddress,
  taskId: TaskIdSchema,
});
export const BackgroundJobStopRequestSchema = z.strictObject({
  type: z.literal("agent.background_jobs.stop.request"),
  ...ControlAddress,
  taskId: TaskIdSchema,
});
export const BackgroundJobRerunRequestSchema = z.strictObject({
  type: z.literal("agent.background_jobs.rerun.request"),
  ...ControlAddress,
  taskId: TaskIdSchema,
});
export const BackgroundJobsStopAllRequestSchema = z.strictObject({
  type: z.literal("agent.background_jobs.stop_all.request"),
  ...ControlAddress,
  taskIds: TaskIdsSchema,
});
export const BackgroundJobsMarkSeenRequestSchema = z.strictObject({
  type: z.literal("agent.background_jobs.mark_seen.request"),
  ...ControlAddress,
  taskIds: TaskIdsSchema,
});

// ---------------------------------------------------------------------------
// Responses and updates (open)
// ---------------------------------------------------------------------------

const ResultAddress = {
  requestId: z.string(),
  agentId: z.string(),
  runtimeId: z.string(),
  activationId: z.string(),
};

/**
 * `version` orders publications within one source-owned observation: the observe response is 0
 * and each update is one higher. A restored observation has a new subscription ID and starts again.
 */
export const BackgroundJobsObserveResponseSchema = z.object({
  type: z.literal("agent.background_jobs.observe.response"),
  payload: z.object({
    requestId: z.string(),
    agentId: z.string(),
    subscriptionId: z.string(),
    version: CountSchema,
    state: BackgroundJobsStateSchema,
  }),
});
export const BackgroundJobsUpdateMessageSchema = z.object({
  type: z.literal("agent.background_jobs.update"),
  payload: z.object({
    subscriptionId: z.string(),
    agentId: z.string(),
    version: z.number().int().positive(),
    state: BackgroundJobsStateSchema,
  }),
});
export const BackgroundJobsListResponseSchema = z.object({
  type: z.literal("agent.background_jobs.list.response"),
  payload: z.object({ ...ResultAddress, result: BackgroundJobsListResultSchema }),
});
export const BackgroundJobDetailResponseSchema = z.object({
  type: z.literal("agent.background_jobs.detail.response"),
  payload: z.object({ ...ResultAddress, result: BackgroundJobDetailResultSchema }),
});
export const BackgroundJobLogsResponseSchema = z.object({
  type: z.literal("agent.background_jobs.logs.response"),
  payload: z.object({ ...ResultAddress, result: BackgroundJobLogsResultSchema }),
});
export const BackgroundJobResultResponseSchema = z.object({
  type: z.literal("agent.background_jobs.result.response"),
  payload: z.object({ ...ResultAddress, result: BackgroundJobResultViewSchema }),
});
export const BackgroundJobStopResponseSchema = z.object({
  type: z.literal("agent.background_jobs.stop.response"),
  payload: z.object({ ...ResultAddress, result: BackgroundJobStopResultSchema }),
});
export const BackgroundJobRerunResponseSchema = z.object({
  type: z.literal("agent.background_jobs.rerun.response"),
  payload: z.object({ ...ResultAddress, result: BackgroundJobRerunResultSchema }),
});
export const BackgroundJobsStopAllResponseSchema = z.object({
  type: z.literal("agent.background_jobs.stop_all.response"),
  payload: z.object({ ...ResultAddress, result: BackgroundJobsStopAllResultSchema }),
});
export const BackgroundJobsMarkSeenResponseSchema = z.object({
  type: z.literal("agent.background_jobs.mark_seen.response"),
  payload: z.object({ ...ResultAddress, result: BackgroundJobsMarkSeenResultSchema }),
});

export type BackgroundJobCounts = z.infer<typeof BackgroundJobCountsSchema>;
export type BackgroundJobStatus = z.infer<typeof BackgroundJobStatusSchema>;
export type BackgroundJobKind = z.infer<typeof BackgroundJobKindSchema>;
export type BackgroundJob = z.infer<typeof BackgroundJobSchema>;
export type BackgroundJobView = z.infer<typeof BackgroundJobViewSchema>;
export type BackgroundJobsListResult = z.infer<typeof BackgroundJobsListResultSchema>;
export type BackgroundJobDetailResult = z.infer<typeof BackgroundJobDetailResultSchema>;
export type BackgroundJobLogsResult = z.infer<typeof BackgroundJobLogsResultSchema>;
export type BackgroundJobStopResult = z.infer<typeof BackgroundJobStopResultSchema>;
export type BackgroundJobsStopAllResult = z.infer<typeof BackgroundJobsStopAllResultSchema>;
export type BackgroundJobRerunResult = z.infer<typeof BackgroundJobRerunResultSchema>;
export type BackgroundJobResultView = z.infer<typeof BackgroundJobResultViewSchema>;
export type BackgroundJobsMarkSeenResult = z.infer<typeof BackgroundJobsMarkSeenResultSchema>;
export type BackgroundJobsState = z.infer<typeof BackgroundJobsStateSchema>;
export type BackgroundJobsReadyState = Extract<BackgroundJobsState, { status: "ready" }>;

export type BackgroundJobsObserveRequest = z.infer<typeof BackgroundJobsObserveRequestSchema>;
export type BackgroundJobsListRequest = z.infer<typeof BackgroundJobsListRequestSchema>;
export type BackgroundJobDetailRequest = z.infer<typeof BackgroundJobDetailRequestSchema>;
export type BackgroundJobLogsRequest = z.infer<typeof BackgroundJobLogsRequestSchema>;
export type BackgroundJobResultRequest = z.infer<typeof BackgroundJobResultRequestSchema>;
export type BackgroundJobStopRequest = z.infer<typeof BackgroundJobStopRequestSchema>;
export type BackgroundJobRerunRequest = z.infer<typeof BackgroundJobRerunRequestSchema>;
export type BackgroundJobsStopAllRequest = z.infer<typeof BackgroundJobsStopAllRequestSchema>;
export type BackgroundJobsMarkSeenRequest = z.infer<typeof BackgroundJobsMarkSeenRequestSchema>;

export type BackgroundJobsReadRequest =
  | BackgroundJobsListRequest
  | BackgroundJobDetailRequest
  | BackgroundJobLogsRequest
  | BackgroundJobResultRequest;
export type BackgroundJobsControlRequest =
  | BackgroundJobStopRequest
  | BackgroundJobRerunRequest
  | BackgroundJobsStopAllRequest
  | BackgroundJobsMarkSeenRequest;
export type BackgroundJobsRequest =
  | BackgroundJobsObserveRequest
  | BackgroundJobsReadRequest
  | BackgroundJobsControlRequest;

export type BackgroundJobsObservePayload = z.infer<
  typeof BackgroundJobsObserveResponseSchema
>["payload"];
export type BackgroundJobsUpdatePayload = z.infer<
  typeof BackgroundJobsUpdateMessageSchema
>["payload"];
