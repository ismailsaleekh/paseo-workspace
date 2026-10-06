import { describe, expect, test } from "vitest";

import {
  InvalidBranchResultError,
  PI_WORKSPACE_BRANCH_COMMAND,
  buildBranchCommitPrompt,
  parseBranchCommitOutcome,
  parseQueuedBranchOperation,
  settleBranchOperations,
  type QueuedBranchOperation,
} from "./branch-transition.js";

function queuedResult(action: "open" | "return", operation: string) {
  return {
    content: [{ type: "text", text: "queued" }],
    details: {
      kind: "branch",
      status: "queued",
      operation,
      checkpoint: action === "return" ? "checkpoint-1" : null,
      request:
        action === "return"
          ? { action, notes: "kept", artifacts: [] }
          : { action, title: "Side", purpose: null },
    },
    terminate: true,
  };
}

describe("queued branch tool results", () => {
  test("only successful branch tool results queue a transition", () => {
    expect(
      parseQueuedBranchOperation({
        toolName: "branch_return",
        isError: false,
        result: queuedResult("return", "op-1"),
      }),
    ).toEqual({ action: "return", operation: "op-1" });
    expect(
      parseQueuedBranchOperation({
        toolName: "branch_open",
        isError: false,
        result: queuedResult("open", "op-2"),
      }),
    ).toEqual({ action: "open", operation: "op-2" });
    expect(
      parseQueuedBranchOperation({
        toolName: "branch_open",
        isError: true,
        result: { details: { kind: "error", error: { code: "BRANCH_REQUIRES_SOLE_CALL" } } },
      }),
    ).toBeNull();
    expect(
      parseQueuedBranchOperation({
        toolName: "visual_list",
        isError: false,
        result: queuedResult("open", "op-3"),
      }),
    ).toBeNull();
  });

  test("a successful branch result without a queued operation is an explicit error", () => {
    expect(() =>
      parseQueuedBranchOperation({ toolName: "branch_return", isError: false, result: {} }),
    ).toThrow(InvalidBranchResultError);
  });
});

describe("branch settlement", () => {
  test("the commit prompt targets the extension command with a correlated payload", () => {
    const prompt = buildBranchCommitPrompt({ requestId: "request-1", operation: "op-1" });
    const [command, payload] = prompt.split(" ");
    expect(command).toBe(`/${PI_WORKSPACE_BRANCH_COMMAND}`);
    expect(JSON.parse(Buffer.from(payload ?? "", "base64url").toString("utf8"))).toEqual({
      requestId: "request-1",
      operation: "op-1",
    });
  });

  test("returns commit in order before one timeline replacement; opens need no command", async () => {
    const calls: string[] = [];
    const operations: QueuedBranchOperation[] = [
      { action: "open", operation: "open-1" },
      { action: "return", operation: "return-1" },
      { action: "return", operation: "return-2" },
    ];
    const outcomes = await settleBranchOperations(operations, {
      commit: async (operation) => {
        calls.push(`commit:${operation}`);
        return operation === "return-1"
          ? { status: "returned", operation, checkpoint: "c1" }
          : { status: "failed", operation, code: "BRANCH_CANCELLED", checkpoint: "c2" };
      },
      replaceHistory: async () => {
        calls.push("replace");
      },
    });
    expect(calls).toEqual(["commit:return-1", "commit:return-2", "replace"]);
    expect(outcomes.map((outcome) => outcome.status)).toEqual(["returned", "failed"]);
  });

  test("an open alone still replaces the timeline with the active branch", async () => {
    const calls: string[] = [];
    await settleBranchOperations([{ action: "open", operation: "open-1" }], {
      commit: async () => {
        throw new Error("opens never run the command");
      },
      replaceHistory: async () => {
        calls.push("replace");
      },
    });
    expect(calls).toEqual(["replace"]);
  });

  test("a mismatched or malformed commit answer fails loudly", async () => {
    expect(() =>
      parseBranchCommitOutcome({ status: "duplicate", operation: "other" }, "op-1"),
    ).toThrow("not op-1");
    await expect(
      settleBranchOperations([{ action: "return", operation: "op-1" }], {
        commit: async () => ({ ok: true }),
        replaceHistory: null,
      }),
    ).rejects.toThrow();
  });
});
