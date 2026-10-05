import assert from "node:assert/strict";
import { test } from "node:test";
import {
  FailedToolSchema,
  packageTools,
  unavailableCalls,
  withIsolatedHome,
  withRpc,
  readRequests,
  type IsolatedHome,
} from "../helpers/pi-harness.js";

async function verifyRpcTools(home: IsolatedHome): Promise<void> {
  await withRpc(home, async (client) => {
    const before = await client.getState();
    assert.equal(before.isStreaming, false);
    assert.equal(
      (await client.getMessages()).some((message) => message.role === "assistant"),
      false,
    );
    let count = 0;
    for (const call of unavailableCalls) {
      const events = await client.promptAndWait(`call:${JSON.stringify(call)}`, undefined, 15_000);
      assert.equal(events.at(-1)?.type, "agent_settled");
      assert.equal(events.filter((event) => event.type === "tool_execution_start").length, 1);
      assert.equal(events.filter((event) => event.type === "tool_execution_end").length, 1);
      const results = (await client.getMessages()).filter(
        (message) => message.role === "toolResult",
      );
      assert.equal(results.length, ++count);
      const result = FailedToolSchema.parse(results.at(-1));
      assert.equal(result.toolName, call.name);
      assert.equal(result.details.error.code, "HOST_UNAVAILABLE");
    }
    assert.equal((await client.getState()).isStreaming, false);
    assert.equal((await client.getState()).sessionId, before.sessionId);
    const requests = await readRequests(home);
    assert.equal(requests.length, unavailableCalls.length * 2);
    for (const request of requests) assert.deepEqual(request.tools.slice().sort(), packageTools);
    assert.equal(await client.getLastAssistantText(), "TEST_TOOL_COMPLETE");
  });
}

async function verifyRpcText(home: IsolatedHome): Promise<void> {
  await withRpc(home, async (client) => {
    const first = await client.getState();
    const text = "I think Tuesday—no, Wednesday.\u2028Keep 3.5%, not 35%.\u2029東京";
    await client.promptAndWait(text, undefined, 15_000);
    assert.equal(await client.getLastAssistantText(), text);
    const users = (await client.getMessages()).filter((message) => message.role === "user");
    assert.equal(users.length, 1);
    const user = users[0];
    if (!user) throw new Error("Missing original user message");
    const actual =
      typeof user.content === "string"
        ? user.content
        : user.content
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join("");
    assert.equal(actual, text);
    assert.deepEqual(await client.newSession(), { cancelled: false });
    assert.notEqual((await client.getState()).sessionId, first.sessionId);
    await client.promptAndWait('call:{"name":"visual_list","arguments":{}}', undefined, 15_000);
    const result = FailedToolSchema.parse(
      (await client.getMessages()).findLast((message) => message.role === "toolResult"),
    );
    assert.equal(result.details.error.code, "HOST_UNAVAILABLE");
  });
}

test(
  "real Pi RPC executes all eight tools through the scripted model and settles without host or credential access",
  { timeout: 90_000 },
  async () => {
    await withIsolatedHome(verifyRpcTools);
  },
);
test(
  "RPC preserves Unicode line separators and ordinary user text across a new session",
  { timeout: 60_000 },
  async () => {
    await withIsolatedHome(verifyRpcText);
  },
);
