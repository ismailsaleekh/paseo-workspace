import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
  FailedToolSchema,
  packageTools,
  unavailableCalls,
  withIsolatedHome,
  withSdk,
  readRequests,
  type IsolatedHome,
} from "../helpers/pi-harness.js";
import { MEDIA_PROMPT_GUIDELINE } from "../../src/tools.js";

const ExecutionResultSchema = z.object({
  isError: z.literal(true),
  details: z.unknown(),
  structuredContent: z.unknown(),
  content: z.array(z.object({ type: z.literal("text"), text: z.string() })),
});

async function verifyUnavailableTools(home: IsolatedHome): Promise<void> {
  await withSdk(home, async (session) => {
    assert.deepEqual(session.getActiveToolNames().sort(), packageTools);
    assert.equal(
      session.messages.some((message) => message.role === "assistant"),
      false,
    );
    await assert.rejects(readFile(home.trace), { code: "ENOENT" });
    for (const name of packageTools) {
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
    assert.equal(completed.length, unavailableCalls.length);
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
      unavailableCalls.length * 2,
      "Only each scripted tool selection and its ordinary follow-up may run",
    );
    for (const request of requests) assert.deepEqual(request.tools.slice().sort(), packageTools);
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
  "real SDK loads exactly the eight direct tools without a model request; each unavailable call completes with structured failure",
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
test(
  "the system prompt tells the agent how to show images and videos only while Paseo is attached",
  { timeout: 30_000 },
  async () => {
    await withIsolatedHome(async (home) => {
      await withSdk(home, async (session) => {
        assert.equal(session.systemPrompt.includes(MEDIA_PROMPT_GUIDELINE), false);
      });
      process.env["PI_WORKSPACE_SOCKET"] = join(home.root, "paseo.sock");
      process.env["PI_WORKSPACE_CAPABILITY"] = "test-capability";
      await withSdk(home, async (session) => {
        assert.equal(session.systemPrompt.includes(MEDIA_PROMPT_GUIDELINE), true);
      });
    });
  },
);
