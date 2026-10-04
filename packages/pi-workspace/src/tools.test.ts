import assert from "node:assert/strict";
import { test } from "node:test";
import {
  VisualFailure,
  type VisualOperation,
  type VisualRecord,
  type VisualResult,
} from "@getpaseo/protocol/pi-workspace/contracts";
import { executeVisualTool, type VisualToolName } from "./tools.js";
import { VisualConnection, type VisualToolConnection } from "./connection.js";

const id = "9f2b547d-66f4-4ab2-8e16-e08d04d55773";
const record: VisualRecord = {
  kind: "visual",
  id,
  title: "Example",
  revision: 1,
  stateRevision: 1,
  status: "stored",
  client: null,
  state: null,
  selection: null,
  actions: {},
  error: null,
};
class ToolHost implements VisualToolConnection {
  readonly requests: VisualOperation[] = [];
  constructor(private readonly result: VisualResult = record) {}
  async request(operation: VisualOperation): Promise<VisualResult> {
    this.requests.push(operation);
    return this.result;
  }
}

const calls: Array<{ name: VisualToolName; input: unknown; expected: VisualOperation }> = [
  {
    name: "visual_present",
    input: { mode: "new", title: "Example", html: "<p>prepared</p>" },
    expected: { kind: "present", title: "Example", html: "<p>prepared</p>" },
  },
  { name: "visual_present", input: { mode: "open", id }, expected: { kind: "open", id } },
  {
    name: "visual_update",
    input: { id, revision: 1, html: "<p>changed</p>" },
    expected: { kind: "update", id, revision: 1, html: "<p>changed</p>" },
  },
  {
    name: "visual_act",
    input: { id, action: "pause" },
    expected: { kind: "act", id, action: "pause", value: null },
  },
  {
    name: "visual_act",
    input: { id, action: "set", value: { angle: 17 } },
    expected: { kind: "act", id, action: "set", value: { angle: 17 } },
  },
  { name: "visual_inspect", input: {}, expected: { kind: "inspect", id: null, screenshot: false } },
  {
    name: "visual_inspect",
    input: { id, screenshot: true },
    expected: { kind: "inspect", id, screenshot: true },
  },
  { name: "visual_list", input: {}, expected: { kind: "list", cursor: null } },
  { name: "visual_list", input: { cursor: id }, expected: { kind: "list", cursor: id } },
];

for (const call of calls) {
  test(`${call.name} maps only declared arguments: ${JSON.stringify(call.input)}`, async () => {
    const result: VisualResult =
      call.name === "visual_list" ? { kind: "list", items: [], nextCursor: null } : record;
    const host = new ToolHost(result);
    const received = await executeVisualTool({
      ...call,
      cwd: "/",
      connection: host,
      signal: undefined,
    });
    assert.deepEqual(received, result);
    assert.deepEqual(host.requests, [call.expected]);
  });
}

test("all five tools return structured errors outside an attached host", async () => {
  const connection = new VisualConnection(null);
  connection.bind("unattached-session");
  for (const call of calls) {
    const result = await executeVisualTool({ ...call, cwd: "/", connection, signal: undefined });
    assert.deepEqual(result, {
      kind: "error",
      error: {
        code: "HOST_UNAVAILABLE",
        message: "This Pi session is not attached to a compatible Paseo host",
      },
      id: null,
    });
  }
  connection.close();
});

test("both/no sources, credentials, stale-shaped revisions and non-JSON actions are refused before transport", async () => {
  const invalid: Array<{ name: VisualToolName; input: unknown }> = [
    {
      name: "visual_present",
      input: { mode: "new", title: "Bad", html: "<p>x</p>", file: "x.html" },
    },
    { name: "visual_present", input: { mode: "new", title: "Bad" } },
    { name: "visual_present", input: { mode: "open", id, sessionId: "foreign" } },
    { name: "visual_update", input: { id, revision: 0, html: "<p>x</p>" } },
    { name: "visual_update", input: { id, revision: 1.5, html: "<p>x</p>" } },
    { name: "visual_update", input: { id, revision: 1, html: "<p>x</p>", capability: "secret" } },
    { name: "visual_act", input: { id, action: "set", value: Number.NaN } },
    { name: "visual_act", input: { id, action: "set", value: () => 1 } },
    { name: "visual_inspect", input: { id, screenshot: "yes" } },
    { name: "visual_list", input: { cursor: "../../other" } },
  ];
  for (const call of invalid) {
    const host = new ToolHost();
    const result = await executeVisualTool({
      ...call,
      cwd: "/",
      connection: host,
      signal: undefined,
    });
    assert.equal(result.kind, "error");
    assert.deepEqual(host.requests, []);
  }
});

test("host failures retain recoverable artifact identity and never become empty success", async () => {
  const connection: VisualToolConnection = {
    async request() {
      throw new VisualFailure("RENDER_FAILED", "Restore rejected", id);
    },
  };
  const result = await executeVisualTool({
    name: "visual_inspect",
    input: { id },
    cwd: "/",
    connection,
    signal: undefined,
  });
  assert.deepEqual(result, {
    kind: "error",
    error: { code: "RENDER_FAILED", message: "Restore rejected" },
    id,
  });
});

test("cancellation has no request side effect and unexpected implementation errors remain failures", async () => {
  const host = new ToolHost();
  const result = await executeVisualTool({
    name: "visual_list",
    input: {},
    cwd: "/",
    connection: host,
    signal: AbortSignal.abort(),
  });
  assert.equal(result.kind, "error");
  assert.deepEqual(host.requests, []);
  const connection: VisualToolConnection = {
    async request() {
      throw new Error("Unexpected implementation defect");
    },
  };
  await assert.rejects(
    executeVisualTool({ name: "visual_list", input: {}, cwd: "/", connection, signal: undefined }),
    /Unexpected implementation defect/,
  );
});

test("wrong result kind is not forwarded as a successful tool response", async () => {
  const host = new ToolHost({ kind: "context", visual: record });
  const result = await executeVisualTool({
    name: "visual_inspect",
    input: { id },
    cwd: "/",
    connection: host,
    signal: undefined,
  });
  assert.deepEqual(result, {
    kind: "error",
    error: { code: "INVALID_REPLY", message: "Visual host returned an invalid tool result" },
    id: null,
  });
});
