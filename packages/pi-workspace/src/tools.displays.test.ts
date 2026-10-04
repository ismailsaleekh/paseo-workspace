import assert from "node:assert/strict";
import { test } from "node:test";
import {
  VisualFailure,
  type VisualCapture,
  type VisualOperation,
  type VisualRecord,
  type VisualResult,
} from "@getpaseo/protocol/pi-workspace/contracts";
import type { VisualToolConnection } from "./connection.js";
import { executeVisualTool, visualToolResult } from "./tools.js";

const id = "9f2b547d-66f4-4ab2-8e16-e08d04d55773";
const client = "display:opaque-A";
const displayed: VisualRecord = {
  kind: "visual",
  id,
  title: "Addressed display",
  revision: 1,
  stateRevision: 2,
  status: "rendered",
  client,
  displays: [{ client, platform: "web", active: true }],
  state: { value: 3 },
  selection: null,
  actions: {},
  error: null,
};
class DisplayConnection implements VisualToolConnection {
  readonly requests: VisualOperation[] = [];
  constructor(private readonly result: VisualResult = displayed) {}
  async request(operation: VisualOperation): Promise<VisualResult> {
    this.requests.push(operation);
    return this.result;
  }
}

test("inspect forwards an opaque addressed display and returns its display records", async () => {
  const connection = new DisplayConnection();
  const result = await executeVisualTool({
    name: "visual_inspect",
    input: { id, client },
    cwd: "/",
    connection,
    signal: undefined,
  });
  assert.deepEqual(connection.requests, [{ kind: "inspect", id, screenshot: false, client }]);
  assert.deepEqual(result, displayed);
});

test("omitting client retains the exact existing inspect operation shape", async () => {
  const connection = new DisplayConnection();
  await executeVisualTool({
    name: "visual_inspect",
    input: { id },
    cwd: "/",
    connection,
    signal: undefined,
  });
  assert.deepEqual(connection.requests, [{ kind: "inspect", id, screenshot: false }]);
});

test("invalid or oversized client identifiers fail before any transport request", async () => {
  for (const invalid of ["", null, 17, {}, "x".repeat(257)]) {
    const connection = new DisplayConnection();
    const result = await executeVisualTool({
      name: "visual_inspect",
      input: { client: invalid },
      cwd: "/",
      connection,
      signal: undefined,
    });
    assert.equal(result.kind, "error");
    if (result.kind !== "error") throw new Error("Invalid client was accepted");
    assert.equal(result.error.code, "INVALID_ARGUMENT");
    assert.deepEqual(connection.requests, []);
  }
});

test("an addressed inspect cannot return a different client's success", async () => {
  const connection = new DisplayConnection({ ...displayed, client: "display:opaque-B" });
  const result = await executeVisualTool({
    name: "visual_inspect",
    input: { id, client },
    cwd: "/",
    connection,
    signal: undefined,
  });
  assert.equal(result.kind, "error");
  if (result.kind !== "error") throw new Error("Different client was substituted");
  assert.equal(result.error.code, "INVALID_REPLY");
});

test("an unavailable addressed display remains an explicit error with its artifact identity", async () => {
  const connection: VisualToolConnection = {
    async request() {
      throw new VisualFailure("DISPLAY_UNAVAILABLE", "Display closed", id);
    },
  };
  const result = await executeVisualTool({
    name: "visual_inspect",
    input: { id, client, screenshot: true },
    cwd: "/",
    connection,
    signal: undefined,
  });
  assert.deepEqual(result, {
    kind: "error",
    error: { code: "DISPLAY_UNAVAILABLE", message: "Display closed" },
    id,
  });
});

test("client selection is not added to the other visual tools", async () => {
  const connection = new DisplayConnection();
  for (const call of [
    { name: "visual_present", input: { mode: "open", id, client } },
    { name: "visual_update", input: { id, revision: 1, html: "<p>content</p>", client } },
    { name: "visual_act", input: { id, action: "set", client } },
    { name: "visual_list", input: { client } },
  ] as const) {
    const result = await executeVisualTool({ ...call, cwd: "/", connection, signal: undefined });
    assert.equal(result.kind, "error");
  }
  assert.deepEqual(connection.requests, []);
});

const capture: VisualCapture = {
  operationId: "b5bed943-2cd8-48bd-ab77-8808b6284674",
  binding: {
    id,
    revision: 1,
    nonce: "7c6c0224-4617-4c5b-bbfe-03c3c330c608",
    clientGeneration: "b5bed943-2cd8-48bd-ab77-8808b6284674",
  },
  screenshot: {
    client,
    mimeType: "image/png",
    width: 1,
    height: 1,
    viewport: { width: 1, height: 1 },
    pixelRatio: 1,
    revision: 1,
    stateRevision: 2,
  },
  data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lZsAAAAASUVORK5CYII=",
};

test("the Pi result carries one image part and matching metadata without duplicating image bytes in text or structured details", async () => {
  const connection = new DisplayConnection({ ...displayed, capture });
  const outcome = await executeVisualTool({
    name: "visual_inspect",
    input: { id, client, screenshot: true },
    cwd: "/",
    connection,
    signal: undefined,
  });
  const result = visualToolResult(outcome);
  const details = { ...displayed, screenshot: capture.screenshot };
  assert.equal(result.isError, false);
  assert.deepEqual(result.details, details);
  assert.deepEqual(result.structuredContent, details);
  assert.deepEqual(result.content, [
    { type: "text", text: JSON.stringify(details) },
    { type: "image", mimeType: "image/png", data: capture.data },
  ]);
});

test("mismatched screenshot revisions or dimensions never become Pi image content", async () => {
  for (const screenshot of [
    { ...capture.screenshot, revision: 2 },
    { ...capture.screenshot, stateRevision: 3 },
    { ...capture.screenshot, width: 5000 },
    { ...capture.screenshot, client: "another-display" },
  ]) {
    const connection = new DisplayConnection({ ...displayed, capture: { ...capture, screenshot } });
    const outcome = await executeVisualTool({
      name: "visual_inspect",
      input: { id, client, screenshot: true },
      cwd: "/",
      connection,
      signal: undefined,
    });
    const result = visualToolResult(outcome);
    assert.equal(result.isError, true);
    assert.deepEqual(
      result.content.filter((part) => part.type === "image"),
      [],
    );
  }
});
