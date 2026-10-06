import { randomUUID } from "node:crypto";
import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { z } from "zod";
import { VisualFailure, VisualIdSchema } from "@getpaseo/protocol/pi-workspace/contracts";

/** Durable entry names. Detour state is reconstructed from these entries, never from memory. */
export const BRANCH_CHECKPOINT_TYPE = "pi-workspace/branch-checkpoint";
export const BRANCH_OPENED_TYPE = "pi-workspace/branch-opened";
export const BRANCH_NOTES_TYPE = "pi-workspace/branch-notes";
export const BRANCH_RETURNED_TYPE = "pi-workspace/branch-returned";
export const BRANCH_STATUS_TYPE = "pi-workspace/branch-status";
/** Internal command the attached host runs after the agent settles to commit a queued return. */
export const BRANCH_COMMIT_COMMAND = "pi-workspace-branch";
/** Result marker read by the attached Paseo host's extension-command bridge. */
export const HOST_COMMAND_RESULT_MARKER = "PASEO_COMMAND_RESULT";

export const BRANCH_TITLE_CHARS = 120;
export const BRANCH_PURPOSE_CHARS = 2000;
export const BRANCH_NOTES_CHARS = 20_000;
export const BRANCH_ARTIFACT_LIMIT = 20;
const BATCH_MEMORY = 1024;

const objectOptions = { additionalProperties: false };
export const branchOpenParameters = Type.Object(
  {
    title: Type.String({ minLength: 1, maxLength: BRANCH_TITLE_CHARS }),
    purpose: Type.Optional(Type.String({ minLength: 1, maxLength: BRANCH_PURPOSE_CHARS })),
    answer_now: Type.Optional(Type.Boolean()),
  },
  objectOptions,
);
export const branchReturnParameters = Type.Object(
  {
    notes: Type.String({ minLength: 1, maxLength: BRANCH_NOTES_CHARS }),
    artifacts: Type.Optional(
      Type.Array(Type.String({ minLength: 1, maxLength: 256 }), {
        maxItems: BRANCH_ARTIFACT_LIMIT,
      }),
    ),
  },
  objectOptions,
);
const BranchRequestOutput = Type.Union([
  Type.Object(
    {
      action: Type.Literal("open"),
      title: Type.String(),
      purpose: Type.Union([Type.String(), Type.Null()]),
      answerNow: Type.Boolean(),
    },
    objectOptions,
  ),
  Type.Object(
    {
      action: Type.Literal("return"),
      notes: Type.String(),
      artifacts: Type.Array(Type.String()),
    },
    objectOptions,
  ),
]);
const branchOutputSchema = Type.Union([
  Type.Object(
    {
      kind: Type.Literal("branch"),
      status: Type.Literal("queued"),
      operation: Type.String(),
      checkpoint: Type.Union([Type.String(), Type.Null()]),
      request: BranchRequestOutput,
    },
    objectOptions,
  ),
  Type.Object(
    {
      kind: Type.Literal("error"),
      id: Type.Union([Type.String(), Type.Null()]),
      status: Type.Literal("failed"),
      error: Type.Object({ code: Type.String(), message: Type.String() }, objectOptions),
    },
    objectOptions,
  ),
]);

function nonBlank(limit: number, label: string) {
  return z
    .string()
    .min(1)
    .max(limit)
    .refine((text) => text.trim().length > 0, `${label} must contain text`);
}
const OpenInputSchema = z
  .object({
    title: nonBlank(BRANCH_TITLE_CHARS, "title"),
    purpose: nonBlank(BRANCH_PURPOSE_CHARS, "purpose").optional(),
    answer_now: z.boolean().optional(),
  })
  .strict()
  .refine((input) => input.answer_now !== true || input.purpose !== undefined, {
    message: "answer_now needs the purpose to answer",
  });
const ReturnInputSchema = z
  .object({
    notes: nonBlank(BRANCH_NOTES_CHARS, "notes"),
    artifacts: z.array(VisualIdSchema).max(BRANCH_ARTIFACT_LIMIT).optional(),
  })
  .strict();

const OpenRequestSchema = z
  .object({
    action: z.literal("open"),
    title: z.string(),
    purpose: z.string().nullable(),
    answerNow: z.boolean(),
  })
  .strict();
const ReturnRequestSchema = z
  .object({ action: z.literal("return"), notes: z.string(), artifacts: z.array(z.string()) })
  .strict();
export type BranchOpenRequest = z.infer<typeof OpenRequestSchema>;
export type BranchReturnRequest = z.infer<typeof ReturnRequestSchema>;
export type BranchRequest = BranchOpenRequest | BranchReturnRequest;

/** A valid call: accepted and queued, not yet committed. */
export interface BranchQueued {
  kind: "branch";
  status: "queued";
  operation: string;
  /** For a return, the checkpoint it goes back to; null for an open (created at commit). */
  checkpoint: string | null;
  request: BranchRequest;
}
export interface BranchFailure {
  kind: "error";
  /** Operation identity when one was assigned; same placement as the other package tools. */
  id: string | null;
  status: "failed";
  error: { code: string; message: string };
}
export type BranchDetails = BranchQueued | BranchFailure;

const QueuedReturnSchema = z.object({
  kind: z.literal("branch"),
  status: z.literal("queued"),
  operation: z.string().min(1),
  checkpoint: z.string().min(1),
  request: ReturnRequestSchema,
});

/** The fields of a Pi session entry this module reads. Pi's own entries satisfy it. */
export interface BranchEntryView {
  readonly id: string;
  readonly parentId: string | null;
  readonly type: string;
  readonly customType?: string;
  readonly data?: unknown;
  readonly details?: unknown;
  readonly message?: unknown;
}

const CheckpointDataSchema = z
  .object({
    version: z.literal(1),
    operation: z.string().min(1),
    title: z.string().min(1),
    purpose: z.string().nullable(),
  })
  .strict();
const ReturnedDataSchema = z
  .object({ version: z.literal(1), operation: z.string().min(1), checkpoint: z.string().min(1) })
  .strict();
const OperationRecordSchema = z.object({ operation: z.string().min(1) });
const ToolResultMessageSchema = z.object({
  role: z.literal("toolResult"),
  toolCallId: z.string(),
  toolName: z.string(),
  details: z.unknown(),
});
const AssistantMessageSchema = z.object({
  role: z.literal("assistant"),
  content: z.array(z.unknown()),
});
const ToolCallPartSchema = z.object({ type: z.literal("toolCall"), id: z.string().min(1) });

export type CheckpointData = z.infer<typeof CheckpointDataSchema>;
export type ReturnedData = z.infer<typeof ReturnedDataSchema>;

export interface OpenDetour {
  checkpoint: string;
  operation: string;
  title: string;
}

function isCustom(entry: BranchEntryView, customType: string): boolean {
  return entry.type === "custom" && entry.customType === customType;
}
function isCustomMessage(entry: BranchEntryView, customType: string): boolean {
  return entry.type === "custom_message" && entry.customType === customType;
}
function checkpointData(entry: BranchEntryView): CheckpointData {
  const parsed = CheckpointDataSchema.safeParse(entry.data);
  if (!parsed.success)
    throw new VisualFailure("INVALID_STATE", `Detour checkpoint ${entry.id} has invalid data`);
  return parsed.data;
}
function returnedData(entry: BranchEntryView): ReturnedData {
  const parsed = ReturnedDataSchema.safeParse(entry.data);
  if (!parsed.success)
    throw new VisualFailure("INVALID_STATE", `Detour completion ${entry.id} has invalid data`);
  return parsed.data;
}

/**
 * Detours open on the given branch, outermost first. A checkpoint is open while its visible
 * marker is on the branch and no completion for it is: a return navigates back to the checkpoint,
 * so the marker leaves the active branch and the completion is appended after the notes.
 */
export function openDetours(branch: readonly BranchEntryView[]): OpenDetour[] {
  const opened = new Set<string>();
  const returned = new Set<string>();
  for (const entry of branch) {
    if (isCustomMessage(entry, BRANCH_OPENED_TYPE) && entry.parentId !== null)
      opened.add(entry.parentId);
    if (isCustom(entry, BRANCH_RETURNED_TYPE)) returned.add(returnedData(entry).checkpoint);
  }
  const detours: OpenDetour[] = [];
  for (const entry of branch) {
    if (!isCustom(entry, BRANCH_CHECKPOINT_TYPE)) continue;
    if (!opened.has(entry.id) || returned.has(entry.id)) continue;
    const data = checkpointData(entry);
    detours.push({ checkpoint: entry.id, operation: data.operation, title: data.title });
  }
  return detours;
}

/**
 * Remembers which tool calls share one assistant message. Pi finalizes the assistant message
 * (message_end) before it executes any of its tool calls.
 */
export class ToolBatchRegistry {
  private readonly sizes = new Map<string, number>();

  record(message: unknown): void {
    const assistant = AssistantMessageSchema.safeParse(message);
    if (!assistant.success) return;
    const ids: string[] = [];
    for (const part of assistant.data.content) {
      const call = ToolCallPartSchema.safeParse(part);
      if (call.success) ids.push(call.data.id);
    }
    for (const id of ids) this.sizes.set(id, ids.length);
    for (const id of this.sizes.keys()) {
      if (this.sizes.size <= BATCH_MEMORY) break;
      this.sizes.delete(id);
    }
  }

  /** Only a call recorded as the single call of its assistant message is a sole direct call. */
  isSoleDirectCall(toolCallId: string): boolean {
    return this.sizes.get(toolCallId) === 1;
  }
}

export interface BranchHost {
  /** Resolves when an attached Paseo host verified this session; rejects with VisualFailure. */
  ensureAttached(signal?: AbortSignal): Promise<void>;
}
export interface PendingOpen {
  toolCallId: string;
  operation: string;
  title: string;
  purpose: string | null;
  /** The agent asked for one ordinary continuation that answers the purpose right away. */
  answerNow: boolean;
}
export interface BranchCallInput {
  toolCallId: string;
  input: unknown;
  host: BranchHost;
  batches: ToolBatchRegistry;
  signal: AbortSignal | undefined;
  createOperation?: () => string;
}

function failure(code: string, message: string, id: string | null = null): BranchFailure {
  return { kind: "error", id, status: "failed", error: { code, message } };
}

async function precheck(input: BranchCallInput, tool: string): Promise<BranchFailure | null> {
  try {
    await input.host.ensureAttached(input.signal);
  } catch (error) {
    if (error instanceof VisualFailure) return failure(error.code, error.message);
    throw error;
  }
  if (!input.batches.isSoleDirectCall(input.toolCallId)) {
    return failure(
      "BRANCH_REQUIRES_SOLE_CALL",
      `${tool} must be the only tool call in its message; call it again on its own`,
    );
  }
  return null;
}

export async function executeBranchOpen(
  input: BranchCallInput & { pending: Map<string, PendingOpen> },
): Promise<BranchDetails> {
  const refused = await precheck(input, "branch_open");
  if (refused) return refused;
  const parsed = OpenInputSchema.safeParse(input.input);
  if (!parsed.success)
    return failure(
      "INVALID_ARGUMENT",
      `branch_open needs a title of 1-${BRANCH_TITLE_CHARS} characters, an optional purpose of at most ${BRANCH_PURPOSE_CHARS}, and answer_now only together with a purpose`,
    );
  const operation = (input.createOperation ?? randomUUID)();
  const purpose = parsed.data.purpose ?? null;
  const answerNow = parsed.data.answer_now === true;
  input.pending.set(input.toolCallId, {
    toolCallId: input.toolCallId,
    operation,
    title: parsed.data.title,
    purpose,
    answerNow,
  });
  return {
    kind: "branch",
    status: "queued",
    operation,
    checkpoint: null,
    request: { action: "open", title: parsed.data.title, purpose, answerNow },
  };
}

export async function executeBranchReturn(
  input: BranchCallInput & { branch: readonly BranchEntryView[] },
): Promise<BranchDetails> {
  const refused = await precheck(input, "branch_return");
  if (refused) return refused;
  const parsed = ReturnInputSchema.safeParse(input.input);
  if (!parsed.success)
    return failure(
      "INVALID_ARGUMENT",
      `branch_return needs notes of 1-${BRANCH_NOTES_CHARS} characters and at most ${BRANCH_ARTIFACT_LIMIT} visual artifact IDs`,
    );
  let innermost: OpenDetour | undefined;
  try {
    innermost = openDetours(input.branch).at(-1);
  } catch (error) {
    if (error instanceof VisualFailure) return failure(error.code, error.message);
    throw error;
  }
  if (!innermost)
    return failure(
      "NO_ACTIVE_DETOUR",
      "There is no open detour on the current branch to return from",
    );
  const operation = (input.createOperation ?? randomUUID)();
  return {
    kind: "branch",
    status: "queued",
    operation,
    checkpoint: innermost.checkpoint,
    request: { action: "return", notes: parsed.data.notes, artifacts: parsed.data.artifacts ?? [] },
  };
}

export interface BranchStatusDetails {
  operation: string;
  action: "open" | "return";
  code: string;
  checkpoint: string | null;
}
export type BranchBoundaryDraft =
  | { type: "custom"; customType: string; data: CheckpointData }
  | {
      type: "custom_message";
      customType: string;
      content: string;
      display: true;
      details:
        | BranchStatusDetails
        | { operation: string; title: string; purpose: string | null; answerNow: boolean };
    };
export interface OpenCommitPlan {
  entries: BranchBoundaryDraft[];
  /** True when a committed detour has answer_now: one ordinary continuation answers its purpose. */
  continueRun: boolean;
}

function statusText(action: "open" | "return", code: string, message: string): string {
  return `Detour ${action} not applied (${code}): ${message}`;
}
function statusDraft(details: BranchStatusDetails, message: string): BranchBoundaryDraft {
  return {
    type: "custom_message",
    customType: BRANCH_STATUS_TYPE,
    content: statusText(details.action, details.code, message),
    display: true,
    details,
  };
}
export function openedMarkerText(title: string, purpose: string | null): string {
  const lines = [`Detour opened: ${title}`];
  if (purpose !== null) lines.push(`Purpose: ${purpose}`);
  lines.push("Work here; call branch_return with only the notes to keep when done.");
  return lines.join("\n");
}
function isToolResultOf(entry: BranchEntryView, toolCallId: string): boolean {
  if (entry.type !== "message") return false;
  const message = ToolResultMessageSchema.safeParse(entry.message);
  return message.success && message.data.toolCallId === toolCallId;
}
function recordsOperation(entry: BranchEntryView, operation: string): boolean {
  let record: unknown;
  if (isCustom(entry, BRANCH_CHECKPOINT_TYPE) || isCustom(entry, BRANCH_RETURNED_TYPE))
    record = entry.data;
  else if (isCustomMessage(entry, BRANCH_STATUS_TYPE)) record = entry.details;
  else return false;
  const parsed = OperationRecordSchema.safeParse(record);
  return parsed.success && parsed.data.operation === operation;
}

/**
 * Entries that commit queued opens at Pi's final settle boundary, after every sibling result is
 * persisted: a non-message checkpoint at the leaf, then the visible marker as its child.
 */
export function planOpenCommits(input: {
  pending: readonly PendingOpen[];
  branch: readonly BranchEntryView[];
  entries: readonly BranchEntryView[];
  outcome: "completed" | "aborted" | "error";
}): OpenCommitPlan {
  const plan: OpenCommitPlan = { entries: [], continueRun: false };
  for (const open of input.pending) {
    if (input.entries.some((entry) => recordsOperation(entry, open.operation))) continue;
    const base = { operation: open.operation, action: "open" as const, checkpoint: null };
    if (!input.branch.some((entry) => isToolResultOf(entry, open.toolCallId))) {
      plan.entries.push(
        statusDraft(
          { ...base, code: "BRANCH_STALE" },
          "the branch_open call is no longer on the current branch",
        ),
      );
      continue;
    }
    if (input.outcome !== "completed") {
      plan.entries.push(
        statusDraft(
          { ...base, code: "BRANCH_CANCELLED" },
          `the run ended (${input.outcome}) before the detour was opened`,
        ),
      );
      continue;
    }
    plan.entries.push(
      {
        type: "custom",
        customType: BRANCH_CHECKPOINT_TYPE,
        data: { version: 1, operation: open.operation, title: open.title, purpose: open.purpose },
      },
      {
        type: "custom_message",
        customType: BRANCH_OPENED_TYPE,
        content: openedMarkerText(open.title, open.purpose),
        display: true,
        details: {
          operation: open.operation,
          title: open.title,
          purpose: open.purpose,
          answerNow: open.answerNow,
        },
      },
    );
    if (open.answerNow) plan.continueRun = true;
  }
  return plan;
}

export interface BranchMessage {
  customType: string;
  content: string;
  display: true;
  details: BranchStatusDetails | { operation: string; checkpoint: string; artifacts: string[] };
}
/** Session operations available to an extension command (Pi's command context). */
export interface ReturnCommitSession {
  branch(): readonly BranchEntryView[];
  entries(): readonly BranchEntryView[];
  navigate(targetId: string): Promise<{ cancelled: boolean }>;
  appendMessage(message: BranchMessage): void;
  appendEntry(customType: string, data: ReturnedData): void;
}
export type BranchCommitOutcome =
  | { status: "returned"; operation: string; checkpoint: string }
  | { status: "duplicate"; operation: string }
  | {
      status: "failed";
      operation: string;
      code: "BRANCH_CANCELLED" | "BRANCH_STALE";
      checkpoint: string;
    };

export function notesText(notes: string, artifacts: readonly string[]): string {
  return artifacts.length === 0 ? notes : `${notes}\n\nArtifacts: ${artifacts.join(", ")}`;
}

function findQueuedReturn(
  entries: readonly BranchEntryView[],
  operation: string,
): { entryId: string; queued: z.infer<typeof QueuedReturnSchema> } | null {
  for (const entry of entries) {
    if (entry.type !== "message") continue;
    const message = ToolResultMessageSchema.safeParse(entry.message);
    if (!message.success || message.data.toolName !== "branch_return") continue;
    const queued = QueuedReturnSchema.safeParse(message.data.details);
    if (queued.success && queued.data.operation === operation)
      return { entryId: entry.id, queued: queued.data };
  }
  return null;
}

/**
 * Commits one queued return through native tree navigation (summarize:false). Cancellation or a
 * stale checkpoint leaves the position unchanged and appends one visible status message; a retry
 * of a finished operation appends nothing.
 */
export async function commitReturn(
  session: ReturnCommitSession,
  operation: string,
): Promise<BranchCommitOutcome> {
  const entries = session.entries();
  if (entries.some((entry) => recordsOperation(entry, operation)))
    return { status: "duplicate", operation };
  const found = findQueuedReturn(entries, operation);
  if (!found) throw new Error(`No queued branch_return operation ${operation} in this session`);
  const { checkpoint, request } = found.queued;
  const fail = (code: "BRANCH_CANCELLED" | "BRANCH_STALE", message: string) => {
    session.appendMessage({
      customType: BRANCH_STATUS_TYPE,
      content: statusText("return", code, message),
      display: true,
      details: { operation, action: "return", code, checkpoint },
    });
    return { status: "failed" as const, operation, code, checkpoint };
  };
  const branch = session.branch();
  const requestOnBranch = branch.some((entry) => entry.id === found.entryId);
  const innermost = openDetours(branch).at(-1);
  if (!requestOnBranch || innermost?.checkpoint !== checkpoint)
    return fail(
      "BRANCH_STALE",
      "the detour checkpoint is no longer the open detour of this branch",
    );
  const navigation = await session.navigate(checkpoint);
  if (navigation.cancelled)
    return fail("BRANCH_CANCELLED", "returning to the detour checkpoint was cancelled");
  session.appendMessage({
    customType: BRANCH_NOTES_TYPE,
    content: notesText(request.notes, request.artifacts),
    display: true,
    details: { operation, checkpoint, artifacts: request.artifacts },
  });
  session.appendEntry(BRANCH_RETURNED_TYPE, { version: 1, operation, checkpoint });
  return { status: "returned", operation, checkpoint };
}

const CommitPayloadSchema = z
  .object({ requestId: z.string().min(1).max(256), operation: z.string().min(1).max(256) })
  .strict();
export type BranchCommitPayload = z.infer<typeof CommitPayloadSchema>;

export function encodeBranchCommitPayload(payload: BranchCommitPayload): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}
export function parseBranchCommitPayload(args: string): BranchCommitPayload {
  const raw: unknown = JSON.parse(Buffer.from(args.trim(), "base64url").toString("utf8"));
  return CommitPayloadSchema.parse(raw);
}
export function formatHostCommandResult(requestId: string, result: BranchCommitOutcome): string {
  return `${HOST_COMMAND_RESULT_MARKER} ${JSON.stringify({ requestId, ok: true, result })}`;
}
export function formatHostCommandFailure(requestId: string, error: string): string {
  return `${HOST_COMMAND_RESULT_MARKER} ${JSON.stringify({ requestId, ok: false, error })}`;
}

type BranchOpenToolResult = Awaited<
  ReturnType<ToolDefinition<typeof branchOpenParameters, BranchDetails>["execute"]>
>;

export function branchToolResult(details: BranchDetails): BranchOpenToolResult {
  const queued = details.kind === "branch";
  const text = queued
    ? JSON.stringify({
        kind: details.kind,
        status: details.status,
        action: details.request.action,
        operation: details.operation,
        note: "Queued: the detour transition is committed when this turn ends.",
      })
    : JSON.stringify(details);
  return {
    content: [{ type: "text", text }],
    details,
    structuredContent: z.json().parse(details),
    isError: !queued,
    // A queued transition yields the turn; call-time errors let the agent continue normally.
    ...(queued ? { terminate: true } : {}),
  };
}

export interface BranchToolDependencies {
  host: BranchHost;
  batches: ToolBatchRegistry;
  bind(sessionId: string): void;
}

export function createBranchOpenTool(
  input: BranchToolDependencies & { pending: Map<string, PendingOpen> },
): ToolDefinition<typeof branchOpenParameters, BranchDetails, unknown> {
  return {
    name: "branch_open",
    label: "branch_open",
    description:
      "Open a conversation detour in this same session: when this turn ends, a return checkpoint and a visible detour marker are recorded and the conversation continues inside the detour with the full context. Give a short title and optionally a purpose; set answer_now: true only when the detour should start answering that purpose right away (exactly one ordinary continuation runs after the detour opens); otherwise no model request follows. Must be the only tool call in its message. Close it with branch_return. Requires attached Paseo.",
    parameters: branchOpenParameters,
    outputSchema: branchOutputSchema,
    exposure: "direct",
    executionMode: "sequential",
    async execute(toolCallId, args, signal, _onUpdate, ctx) {
      input.bind(ctx.sessionManager.getSessionId());
      const details = await executeBranchOpen({
        toolCallId,
        input: args,
        host: input.host,
        batches: input.batches,
        signal,
        pending: input.pending,
      });
      return branchToolResult(details);
    },
  };
}

export function createBranchReturnTool(
  input: BranchToolDependencies,
): ToolDefinition<typeof branchReturnParameters, BranchDetails, unknown> {
  return {
    name: "branch_return",
    label: "branch_return",
    description:
      "Return from the innermost open detour: when this turn ends, the conversation goes back to where the detour was opened and only your notes (plus any listed visual artifact IDs) are added there. The detour itself stays recoverable in the session tree; no summary is generated. Must be the only tool call in its message. Fails with NO_ACTIVE_DETOUR outside a detour. Requires attached Paseo.",
    parameters: branchReturnParameters,
    outputSchema: branchOutputSchema,
    exposure: "direct",
    executionMode: "sequential",
    async execute(toolCallId, args, signal, _onUpdate, ctx) {
      input.bind(ctx.sessionManager.getSessionId());
      const details = await executeBranchReturn({
        toolCallId,
        input: args,
        host: input.host,
        batches: input.batches,
        signal,
        branch: ctx.sessionManager.getBranch(),
      });
      return branchToolResult(details);
    },
  };
}
