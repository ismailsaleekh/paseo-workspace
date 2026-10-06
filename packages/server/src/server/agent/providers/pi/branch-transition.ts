import { z } from "zod";

/**
 * Host side of the `@getpaseo/pi-workspace` detour tools. A valid `branch_open`/`branch_return`
 * call only queues its transition (`terminate:true`); opens commit at Pi's final settle boundary
 * inside the extension, while returns need Pi's command-only tree navigation, so this provider runs
 * the package's internal commit command once the agent has settled.
 */
export const PI_WORKSPACE_BRANCH_COMMAND = "pi-workspace-branch";
const BRANCH_TOOL_NAMES = new Set(["branch_open", "branch_return"]);

const QueuedBranchResultSchema = z.object({
  details: z.object({
    kind: z.literal("branch"),
    status: z.literal("queued"),
    operation: z.string().min(1).max(256),
    request: z.object({ action: z.enum(["open", "return"]) }),
  }),
});

export interface QueuedBranchOperation {
  action: "open" | "return";
  operation: string;
}

export class InvalidBranchResultError extends Error {
  constructor(readonly toolName: string) {
    super(`${toolName} reported success without a queued branch operation`);
    this.name = "InvalidBranchResultError";
  }
}

/** The queued operation of a successful branch tool result; null for every other tool result. */
export function parseQueuedBranchOperation(input: {
  toolName: string;
  isError: boolean;
  result: unknown;
}): QueuedBranchOperation | null {
  if (!BRANCH_TOOL_NAMES.has(input.toolName) || input.isError) return null;
  const parsed = QueuedBranchResultSchema.safeParse(input.result);
  if (!parsed.success) throw new InvalidBranchResultError(input.toolName);
  return { action: parsed.data.details.request.action, operation: parsed.data.details.operation };
}

export function buildBranchCommitPrompt(input: { requestId: string; operation: string }): string {
  const payload = Buffer.from(
    JSON.stringify({ requestId: input.requestId, operation: input.operation }),
    "utf8",
  ).toString("base64url");
  return `/${PI_WORKSPACE_BRANCH_COMMAND} ${payload}`;
}

const BranchCommitOutcomeSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("returned"), operation: z.string(), checkpoint: z.string() }),
  z.object({ status: z.literal("duplicate"), operation: z.string() }),
  z.object({
    status: z.literal("failed"),
    operation: z.string(),
    code: z.enum(["BRANCH_CANCELLED", "BRANCH_STALE"]),
    checkpoint: z.string(),
  }),
]);
export type BranchCommitOutcome = z.infer<typeof BranchCommitOutcomeSchema>;

/** Commit-time failures are reported in the conversation by the extension, not thrown here. */
export function parseBranchCommitOutcome(value: unknown, operation: string): BranchCommitOutcome {
  const outcome = BranchCommitOutcomeSchema.parse(value);
  if (outcome.operation !== operation)
    throw new Error(`Branch commit answered operation ${outcome.operation}, not ${operation}`);
  return outcome;
}

export interface BranchSettlementPorts {
  /** Runs the commit command for one queued return; resolves with the command's result. */
  commit(operation: string): Promise<unknown>;
  /** Republishes the visible conversation from the provider's active branch. */
  replaceHistory: (() => Promise<void>) | null;
}

/**
 * Commits queued returns in call order, then replaces the visible timeline once so it equals the
 * active Pi branch (opens were already committed by the extension before settlement).
 */
export async function settleBranchOperations(
  operations: readonly QueuedBranchOperation[],
  ports: BranchSettlementPorts,
): Promise<BranchCommitOutcome[]> {
  const outcomes: BranchCommitOutcome[] = [];
  for (const queued of operations) {
    if (queued.action !== "return") continue;
    outcomes.push(parseBranchCommitOutcome(await ports.commit(queued.operation), queued.operation));
  }
  if (ports.replaceHistory) await ports.replaceHistory();
  return outcomes;
}
