import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import {
  FailedToolSchema,
  unavailableCalls,
  visualTools,
  withIsolatedHome,
  withSdk,
  readRequests,
  type IsolatedHome,
} from "../helpers/pi-harness.js";

const ExecutionResultSchema = z.object({
  isError: z.literal(true),
  details: z.unknown(),
  structuredContent: z.unknown(),
  content: z.array(z.object({ type: z.literal("text"), text: z.string() })),
});

async function verifyUnavailableTools(home: IsolatedHome): Promise<void> {
  await withSdk(home, async (session) => {
    assert.deepEqual(session.getActiveToolNames().sort(), visualTools);
    assert.equal(
      session.messages.some((message) => message.role === "assistant"),
      false,
    );
    await assert.rejects(readFile(home.trace), { code: "ENOENT" });
    for (const name of visualTools) {
      const definition = session.getToolDefinition(name);
      if (!definition) throw new Error(`Missing direct tool ${name}`);
      assert.equal(typeof definition.execute, "function");
      assert.notEqual(definition.description.trim(), "");
      assert.equal(typeof definition.parameters, "object");
    }
    const completed: unknown[] = [];
    const unsubscribe = session.subscribe((event) => {
      if (event.type === "tool_execution_end") {
        const result: unknown = event.result;
        completed.push(result);
      }
    });
    try {
      for (const call of unavailableCalls) {
        await session.prompt(`call:${JSON.stringify(call)}`);
        const latest = session.messages.findLast((message) => message.role === "toolResult");
        const result = FailedToolSchema.parse(latest);
        assert.equal(result.toolName, call.name);
        assert.equal(result.details.error.code, "HOST_UNAVAILABLE");
      }
    } finally {
      unsubscribe();
    }
    assert.equal(completed.length, 5);
    for (const raw of completed) {
      const result = ExecutionResultSchema.parse(raw);
      assert.deepEqual(result.structuredContent, result.details);
      const first = result.content[0];
      if (!first) throw new Error("Missing model-facing failure text");
      const text: unknown = JSON.parse(first.text);
      assert.deepEqual(text, result.details);
    }
    const requests = await readRequests(home);
    assert.equal(
      requests.length,
      10,
      "Only each scripted tool selection and its ordinary follow-up may run",
    );
    for (const request of requests) assert.deepEqual(request.tools.slice().sort(), visualTools);
    assert.equal(session.getLastAssistantText(), "TEST_TOOL_COMPLETE");
  });
}

async function verifyInvalidSource(home: IsolatedHome): Promise<void> {
  await withSdk(home, async (session) => {
    await session.prompt(
      'call:{"name":"visual_present","arguments":{"mode":"new","title":"invalid","html":"<p>x</p>","file":"must-not-be-read"}}',
    );
    const result = session.messages.findLast((message) => message.role === "toolResult");
    assert.equal(result?.isError, true);
    await session.prompt('call:{"name":"visual_list","arguments":{}}');
    const last = FailedToolSchema.parse(
      session.messages.findLast((message) => message.role === "toolResult"),
    );
    assert.equal(last.details.error.code, "HOST_UNAVAILABLE");
    assert.equal(session.isStreaming, false);
  });
}

test(
  "real SDK loads exactly five direct tools without a model request; each unavailable call completes with structured failure",
  { timeout: 60_000 },
  async () => {
    await withIsolatedHome(verifyUnavailableTools);
  },
);
test(
  "SDK rejects mutually exclusive sources without file access, then remains usable",
  { timeout: 30_000 },
  async () => {
    await withIsolatedHome(verifyInvalidSource);
  },
);
