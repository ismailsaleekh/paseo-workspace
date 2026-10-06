import assert from "node:assert/strict";
import { test } from "node:test";
import { VisualFailure } from "@getpaseo/protocol/pi-workspace/contracts";
import {
  BRANCH_CHECKPOINT_TYPE,
  BRANCH_NOTES_TYPE,
  BRANCH_OPENED_TYPE,
  BRANCH_RETURNED_TYPE,
  BRANCH_STATUS_TYPE,
  HOST_COMMAND_RESULT_MARKER,
  ToolBatchRegistry,
  branchToolResult,
  commitReturn,
  encodeBranchCommitPayload,
  executeBranchOpen,
  executeBranchReturn,
  formatHostCommandResult,
  openDetours,
  parseBranchCommitPayload,
  planOpenCommits,
  type BranchEntryView,
  type BranchHost,
  type BranchMessage,
  type PendingOpen,
  type ReturnCommitSession,
  type ReturnedData,
} from "./branch.js";

const attached: BranchHost = { ensureAttached: async () => undefined };
const unavailable: BranchHost = {
  ensureAttached: async () => {
    throw new VisualFailure("HOST_UNAVAILABLE", "No Paseo host");
  },
};
const ARTIFACT = "7e8e07d1-c3af-4b75-b61e-3ce2c2c8603a";

function batches(...messages: string[][]): ToolBatchRegistry {
  const registry = new ToolBatchRegistry();
  for (const ids of messages)
    registry.record({
      role: "assistant",
      content: ids.map((id) => ({ type: "toolCall", id, name: "x", arguments: {} })),
    });
  return registry;
}

/** A tiny append-only tree with a movable leaf, mirroring Pi's session semantics. */
class Tree {
  readonly all: BranchEntryView[] = [];
  leaf: string | null = null;
  private next = 0;
  add(entry: Omit<BranchEntryView, "id" | "parentId">): string {
    this.next += 1;
    const id = `e${this.next}`;
    this.all.push({ ...entry, id, parentId: this.leaf });
    this.leaf = id;
    return id;
  }
  message(role: string, extra: Record<string, unknown> = {}): string {
    return this.add({ type: "message", message: { role, ...extra } });
  }
  toolResult(toolCallId: string, toolName: string, details: unknown): string {
    return this.message("toolResult", { toolCallId, toolName, details });
  }
  branch(): BranchEntryView[] {
    const byId = new Map(this.all.map((entry) => [entry.id, entry]));
    const chain: BranchEntryView[] = [];
    let cursor = this.leaf === null ? undefined : byId.get(this.leaf);
    while (cursor) {
      chain.unshift(cursor);
      cursor = cursor.parentId === null ? undefined : byId.get(cursor.parentId);
    }
    return chain;
  }
  /** Applies committed open drafts the way Pi's boundary does: appended in order at the leaf. */
  commitOpen(open: PendingOpen): string {
    this.toolResult(open.toolCallId, "branch_open", {});
    const plan = planOpenCommits({
      pending: [open],
      branch: this.branch(),
      entries: this.all,
      outcome: "completed",
    });
    let checkpoint = "";
    for (const draft of plan.entries) {
      const id =
        draft.type === "custom"
          ? this.add({ type: "custom", customType: draft.customType, data: draft.data })
          : this.add({
              type: "custom_message",
              customType: draft.customType,
              details: draft.details,
            });
      if (draft.customType === BRANCH_CHECKPOINT_TYPE) checkpoint = id;
    }
    return checkpoint;
  }
  session(cancel = false): ReturnCommitSession & { messages: BranchMessage[] } {
    const messages: BranchMessage[] = [];
    return {
      messages,
      branch: () => this.branch(),
      entries: () => this.all,
      navigate: async (targetId: string) => {
        if (cancel) return { cancelled: true };
        this.leaf = targetId;
        return { cancelled: false };
      },
      appendMessage: (message: BranchMessage) => {
        messages.push(message);
        this.add({
          type: "custom_message",
          customType: message.customType,
          details: message.details,
        });
      },
      appendEntry: (customType: string, data: ReturnedData) => {
        this.add({ type: "custom", customType, data });
      },
    };
  }
}

function pendingOpen(
  tree: Tree,
  title: string,
  purpose: string | null = null,
  answerNow = false,
): PendingOpen {
  const toolCallId = `call-${title}`;
  tree.message("assistant", { content: [{ type: "toolCall", id: toolCallId }] });
  return { toolCallId, operation: `op-${title}`, title, purpose, answerNow };
}

function queuedReturn(tree: Tree, operation: string, checkpoint: string, notes: string): void {
  tree.toolResult(`call-${operation}`, "branch_return", {
    kind: "branch",
    status: "queued",
    operation,
    checkpoint,
    request: { action: "return", notes, artifacts: [ARTIFACT] },
  });
}

test("only a call that is alone in its assistant message is a sole direct call", () => {
  const registry = batches(["solo"], ["a", "b"]);
  assert.equal(registry.isSoleDirectCall("solo"), true);
  assert.equal(registry.isSoleDirectCall("a"), false);
  assert.equal(registry.isSoleDirectCall("unknown/1"), false, "nested calls are never sole calls");
  registry.record({ role: "user", content: "not a batch" });
  assert.equal(registry.isSoleDirectCall("solo"), true);
});

test("host unavailability is reported before any other check, without side effects", async () => {
  const pending = new Map<string, PendingOpen>();
  const details = await executeBranchOpen({
    toolCallId: "a",
    input: { title: "" },
    host: unavailable,
    batches: batches(["a", "b"]),
    signal: undefined,
    pending,
  });
  assert.equal(details.kind, "error");
  assert.equal(details.kind === "error" && details.error.code, "HOST_UNAVAILABLE");
  assert.equal(pending.size, 0);
  const result = branchToolResult(details);
  assert.equal(result.isError, true);
  assert.equal(result.terminate, undefined, "call-time errors let the agent continue");
});

test("a branch call in a mixed batch is refused before queuing anything", async () => {
  const pending = new Map<string, PendingOpen>();
  const details = await executeBranchOpen({
    toolCallId: "a",
    input: { title: "Mixed" },
    host: attached,
    batches: batches(["a", "b"]),
    signal: undefined,
    pending,
  });
  assert.equal(details.kind === "error" && details.error.code, "BRANCH_REQUIRES_SOLE_CALL");
  assert.equal(pending.size, 0);
  const tree = new Tree();
  const refusedReturn = await executeBranchReturn({
    toolCallId: "a",
    input: { notes: "n" },
    host: attached,
    batches: batches(["a", "b"]),
    signal: undefined,
    branch: tree.branch(),
  });
  assert.equal(
    refusedReturn.kind === "error" && refusedReturn.error.code,
    "BRANCH_REQUIRES_SOLE_CALL",
  );
});

test("a valid open is queued with terminate:true and invalid input is an ordinary error", async () => {
  const pending = new Map<string, PendingOpen>();
  const details = await executeBranchOpen({
    toolCallId: "a",
    input: { title: "Side question", purpose: "Explain the cache" },
    host: attached,
    batches: batches(["a"]),
    signal: undefined,
    pending,
    createOperation: () => "op-1",
  });
  assert.deepEqual(details, {
    kind: "branch",
    status: "queued",
    operation: "op-1",
    checkpoint: null,
    request: {
      action: "open",
      title: "Side question",
      purpose: "Explain the cache",
      answerNow: false,
    },
  });
  assert.deepEqual(pending.get("a"), {
    toolCallId: "a",
    operation: "op-1",
    title: "Side question",
    purpose: "Explain the cache",
    answerNow: false,
  });
  const result = branchToolResult(details);
  assert.equal(result.terminate, true);
  assert.equal(result.isError, false);
  const invalid = await executeBranchOpen({
    toolCallId: "b",
    input: { title: "   " },
    host: attached,
    batches: batches(["b"]),
    signal: undefined,
    pending,
  });
  assert.equal(invalid.kind === "error" && invalid.error.code, "INVALID_ARGUMENT");
  assert.equal(pending.has("b"), false);
  const answerWithoutPurpose = await executeBranchOpen({
    toolCallId: "c",
    input: { title: "Now", answer_now: true },
    host: attached,
    batches: batches(["c"]),
    signal: undefined,
    pending,
  });
  assert.equal(
    answerWithoutPurpose.kind === "error" && answerWithoutPurpose.error.code,
    "INVALID_ARGUMENT",
  );
  const answerNow = await executeBranchOpen({
    toolCallId: "d",
    input: { title: "Now", purpose: "Answer it", answer_now: true },
    host: attached,
    batches: batches(["d"]),
    signal: undefined,
    pending,
  });
  assert.equal(answerNow.kind === "branch" && pending.get("d")?.answerNow, true);
});

test("open commits a checkpoint at the leaf and the visible marker as its child", () => {
  const tree = new Tree();
  tree.message("user", { content: "main" });
  const open = pendingOpen(tree, "Side question");
  const resultId = tree.toolResult(open.toolCallId, "branch_open", {});
  const plan = planOpenCommits({
    pending: [open],
    branch: tree.branch(),
    entries: tree.all,
    outcome: "completed",
  });
  assert.equal(plan.continueRun, false, "without a purpose no model request follows");
  assert.deepEqual(
    plan.entries.map((entry) => [entry.type, entry.customType]),
    [
      ["custom", BRANCH_CHECKPOINT_TYPE],
      ["custom_message", BRANCH_OPENED_TYPE],
    ],
  );
  const marker = plan.entries[1];
  assert.equal(marker?.type === "custom_message" && marker.content.includes("Side question"), true);
  assert.equal(tree.leaf, resultId);
});

test("only answer_now schedules exactly one continuation; a purpose alone does not", () => {
  const quiet = new Tree();
  const notesOnly = pendingOpen(quiet, "Notes only", "Context for later");
  quiet.toolResult(notesOnly.toolCallId, "branch_open", {});
  const quietPlan = planOpenCommits({
    pending: [notesOnly],
    branch: quiet.branch(),
    entries: quiet.all,
    outcome: "completed",
  });
  assert.equal(quietPlan.continueRun, false, "a purpose without answer_now runs no model request");
  assert.equal(quietPlan.entries.length, 2);
  const tree = new Tree();
  const open = pendingOpen(tree, "Why", "Answer why right away", true);
  tree.toolResult(open.toolCallId, "branch_open", {});
  const plan = planOpenCommits({
    pending: [open],
    branch: tree.branch(),
    entries: tree.all,
    outcome: "completed",
  });
  assert.equal(plan.continueRun, true);
  const marker = plan.entries[1];
  assert.equal(
    marker?.type === "custom_message" && marker.content.includes("Answer why right away"),
    true,
  );
  const first = plan.entries[0];
  if (first?.type !== "custom") throw new Error("checkpoint draft missing");
  tree.add({ type: "custom", customType: first.customType, data: first.data });
  const retry = planOpenCommits({
    pending: [open],
    branch: tree.branch(),
    entries: tree.all,
    outcome: "completed",
  });
  assert.deepEqual(retry.entries, []);
  const aborted = new Tree();
  const abortedOpen = pendingOpen(aborted, "Aborted");
  aborted.toolResult(abortedOpen.toolCallId, "branch_open", {});
  const abortedPlan = planOpenCommits({
    pending: [abortedOpen],
    branch: aborted.branch(),
    entries: aborted.all,
    outcome: "aborted",
  });
  assert.deepEqual(
    abortedPlan.entries.map((entry) => entry.customType),
    [BRANCH_STATUS_TYPE],
  );
});

test("nested detours return one level at a time and a second return finds no detour", async () => {
  const tree = new Tree();
  tree.message("user", { content: "main" });
  const outer = tree.commitOpen(pendingOpen(tree, "Level one"));
  tree.message("user", { content: "L1" });
  const inner = tree.commitOpen(pendingOpen(tree, "Level two"));
  assert.deepEqual(
    openDetours(tree.branch()).map((detour) => detour.checkpoint),
    [outer, inner],
  );
  const queued = await executeBranchReturn({
    toolCallId: "r",
    input: { notes: "from L2", artifacts: [ARTIFACT] },
    host: attached,
    batches: batches(["r"]),
    signal: undefined,
    branch: tree.branch(),
    createOperation: () => "ret-1",
  });
  assert.equal(queued.kind === "branch" && queued.checkpoint, inner);
  queuedReturn(tree, "ret-1", inner, "from L2");
  const session = tree.session();
  assert.deepEqual(await commitReturn(session, "ret-1"), {
    status: "returned",
    operation: "ret-1",
    checkpoint: inner,
  });
  const branch = tree.branch();
  const notes = branch.filter((entry) => entry.customType === BRANCH_NOTES_TYPE);
  assert.equal(notes.length, 1);
  assert.equal(notes[0]?.parentId, inner, "notes are the first entry after the checkpoint");
  assert.equal(branch.at(-1)?.customType, BRANCH_RETURNED_TYPE);
  assert.equal(session.messages[0]?.content, `from L2\n\nArtifacts: ${ARTIFACT}`);
  assert.deepEqual(
    openDetours(branch).map((detour) => detour.checkpoint),
    [outer],
  );
  assert.deepEqual(await commitReturn(tree.session(), "ret-1"), {
    status: "duplicate",
    operation: "ret-1",
  });
  assert.equal(
    tree.all.filter((entry) => entry.customType === BRANCH_NOTES_TYPE).length,
    1,
    "a retried operation never duplicates notes",
  );
  queuedReturn(tree, "ret-2", outer, "from L1");
  await commitReturn(tree.session(), "ret-2");
  assert.deepEqual(openDetours(tree.branch()), []);
  const none = await executeBranchReturn({
    toolCallId: "z",
    input: { notes: "again" },
    host: attached,
    batches: batches(["z"]),
    signal: undefined,
    branch: tree.branch(),
  });
  assert.equal(none.kind === "error" && none.error.code, "NO_ACTIVE_DETOUR");
});

test("cancelled navigation keeps the position and appends only a status message", async () => {
  const tree = new Tree();
  const checkpoint = tree.commitOpen(pendingOpen(tree, "Cancellable"));
  queuedReturn(tree, "ret-c", checkpoint, "NOT_KEPT");
  const before = tree.leaf;
  const session = tree.session(true);
  const outcome = await commitReturn(session, "ret-c");
  assert.deepEqual(outcome, {
    status: "failed",
    operation: "ret-c",
    code: "BRANCH_CANCELLED",
    checkpoint,
  });
  assert.equal(tree.all.at(-1)?.parentId, before);
  assert.deepEqual(
    session.messages.map((message) => message.customType),
    [BRANCH_STATUS_TYPE],
  );
  assert.equal(session.messages[0]?.content.includes("BRANCH_CANCELLED"), true);
  assert.equal(
    tree.all.some((entry) => entry.customType === BRANCH_NOTES_TYPE),
    false,
  );
  assert.equal(openDetours(tree.branch()).length, 1, "the detour stays open and returnable");
});

test("a checkpoint that is no longer the open detour of the branch is stale", async () => {
  const tree = new Tree();
  tree.message("user", { content: "main" });
  const mainLeaf = tree.leaf;
  const checkpoint = tree.commitOpen(pendingOpen(tree, "Rewound"));
  queuedReturn(tree, "ret-s", checkpoint, "n");
  const request = tree.leaf;
  tree.leaf = mainLeaf;
  const session = tree.session();
  const outcome = await commitReturn(session, "ret-s");
  assert.equal(outcome.status === "failed" && outcome.code, "BRANCH_STALE");
  assert.equal(tree.all.at(-1)?.parentId, mainLeaf);
  assert.notEqual(tree.leaf, request);
  await assert.rejects(commitReturn(tree.session(), "missing"), /No queued branch_return/);
});

test("host commit payloads and results use the bridge's correlated marker", () => {
  const encoded = encodeBranchCommitPayload({ requestId: "r1", operation: "op" });
  assert.deepEqual(parseBranchCommitPayload(` ${encoded} `), { requestId: "r1", operation: "op" });
  assert.throws(() => parseBranchCommitPayload(Buffer.from("{}").toString("base64url")));
  const line = formatHostCommandResult("r1", { status: "duplicate", operation: "op" });
  assert.equal(line.startsWith(`${HOST_COMMAND_RESULT_MARKER} `), true);
  assert.deepEqual(JSON.parse(line.slice(HOST_COMMAND_RESULT_MARKER.length + 1)), {
    requestId: "r1",
    ok: true,
    result: { status: "duplicate", operation: "op" },
  });
});
