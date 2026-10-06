import assert from "node:assert/strict";
import { test } from "node:test";
import { randomBytes, randomUUID } from "node:crypto";
import { createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import { z } from "zod";
import type { RpcClient } from "@earendil-works/pi-coding-agent";
import {
  BRANCH_CHECKPOINT_TYPE,
  BRANCH_COMMIT_COMMAND,
  BRANCH_NOTES_TYPE,
  BRANCH_OPENED_TYPE,
  BRANCH_RETURNED_TYPE,
  HOST_COMMAND_RESULT_MARKER,
  encodeBranchCommitPayload,
} from "../../src/branch.js";
import { withIsolatedHome, withRpc, type IsolatedHome } from "../helpers/pi-harness.js";

const FrameSchema = z.object({
  kind: z.string(),
  sessionId: z.string().optional(),
  requestId: z.string().optional(),
});
const NotifySchema = z.object({
  type: z.literal("extension_ui_request"),
  method: z.literal("notify"),
  message: z.string(),
});
const ResultSchema = z.object({
  requestId: z.string(),
  ok: z.literal(true),
  result: z.object({ status: z.string(), operation: z.string() }),
});
type CommitResult = z.infer<typeof ResultSchema>;
const QueuedSchema = z.object({
  role: z.literal("toolResult"),
  details: z.object({ status: z.literal("queued"), operation: z.string().min(1) }),
});
type Entries = Awaited<ReturnType<RpcClient["getEntries"]>>["entries"];

interface TestHost {
  socketPath: string;
  server: Server;
  sockets: Set<Socket>;
}

function answerFrame(socket: Socket, line: string): void {
  const frame = FrameSchema.parse(JSON.parse(line));
  if (frame.kind === "attach") {
    const attached = { kind: "attached", protocol: 1, sessionId: frame.sessionId };
    socket.write(`${JSON.stringify({ ...attached, generation: randomUUID() })}\n`);
  } else if (frame.kind === "request") {
    const error = { code: "UNSUPPORTED", message: "Test host has no visuals" };
    socket.write(
      `${JSON.stringify({ kind: "error", requestId: frame.requestId, error, artifactId: null })}\n`,
    );
  }
}

/** Minimal attached host: verifies the attachment and declines every visual request. */
async function startHost(root: string): Promise<TestHost> {
  const socketPath = join(root, "host.sock");
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    let buffered = "";
    socket.on("data", (chunk: Buffer) => {
      buffered += chunk.toString("utf8");
      let end = buffered.indexOf("\n");
      while (end !== -1) {
        answerFrame(socket, buffered.slice(0, end));
        buffered = buffered.slice(end + 1);
        end = buffered.indexOf("\n");
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  return { socketPath, server, sockets };
}

async function stopHost(host: TestHost): Promise<void> {
  for (const socket of host.sockets) socket.destroy();
  await new Promise<void>((resolve) => host.server.close(() => resolve()));
}

function readResult(event: unknown, requestId: string): CommitResult | null {
  const notify = NotifySchema.safeParse(event);
  if (!notify.success || !notify.data.message.startsWith(`${HOST_COMMAND_RESULT_MARKER} `))
    return null;
  const raw: unknown = JSON.parse(notify.data.message.slice(HOST_COMMAND_RESULT_MARKER.length + 1));
  const parsed = ResultSchema.parse(raw);
  return parsed.requestId === requestId ? parsed : null;
}

/** Runs the host's commit command over RPC and waits for its correlated result marker. */
async function commitOverRpc(client: RpcClient, operation: string): Promise<CommitResult> {
  const requestId = randomUUID();
  let unsubscribe: () => void = () => undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const result = new Promise<CommitResult>((resolve, reject) => {
    timer = setTimeout(() => reject(new Error("No commit result marker")), 15_000);
    unsubscribe = client.onEvent((event: unknown) => {
      const parsed = readResult(event, requestId);
      if (parsed) resolve(parsed);
    });
  });
  try {
    await client.prompt(
      `/${BRANCH_COMMIT_COMMAND} ${encodeBranchCommitPayload({ requestId, operation })}`,
    );
    return await result;
  } finally {
    clearTimeout(timer);
    unsubscribe();
  }
}

function findCustom(entries: Entries, type: string, customType: string): Entries {
  const matches: Entries = [];
  for (const entry of entries)
    if (entry.type === type && "customType" in entry && entry.customType === customType)
      matches.push(entry);
  return matches;
}
function isToolResult(message: { role: string }): boolean {
  return message.role === "toolResult";
}
async function send(client: RpcClient, text: string): Promise<void> {
  await client.promptAndWait(text, undefined, 15_000);
}

async function rpcScenario(client: RpcClient): Promise<void> {
  const sessionId = (await client.getState()).sessionId;
  await send(client, "RPC_MAIN");
  await send(
    client,
    `call:${JSON.stringify({ name: "branch_open", arguments: { title: "RPC detour" } })}`,
  );
  const opened = await client.getEntries();
  const [checkpoint] = findCustom(opened.entries, "custom", BRANCH_CHECKPOINT_TYPE);
  const [marker] = findCustom(opened.entries, "custom_message", BRANCH_OPENED_TYPE);
  if (!checkpoint || !marker) throw new Error("open was not committed over RPC");
  assert.equal(marker.parentId, checkpoint.id);
  assert.equal(opened.leafId, marker.id);

  await send(client, "RPC_DETOUR_SECRET");
  await send(
    client,
    `call:${JSON.stringify({ name: "branch_return", arguments: { notes: "RPC_NOTE" } })}`,
  );
  const queued = QueuedSchema.parse((await client.getMessages()).findLast(isToolResult));
  const outcome = await commitOverRpc(client, queued.details.operation);
  assert.equal(outcome.result.status, "returned");
  const again = await commitOverRpc(client, queued.details.operation);
  assert.equal(again.result.status, "duplicate");

  const after = await client.getEntries();
  const notes = findCustom(after.entries, "custom_message", BRANCH_NOTES_TYPE);
  assert.equal(notes.length, 1);
  assert.equal(notes[0]?.parentId, checkpoint.id);
  const [returned] = findCustom(after.entries, "custom", BRANCH_RETURNED_TYPE);
  assert.equal(after.leafId, returned?.id);
  const messages = JSON.stringify(await client.getMessages());
  assert.equal(messages.includes("RPC_MAIN"), true);
  assert.equal(messages.includes("RPC_NOTE"), true);
  assert.equal(messages.includes("RPC_DETOUR_SECRET"), false);
  assert.equal((await client.getState()).sessionId, sessionId);
}

async function withAttachedRpc(home: IsolatedHome): Promise<void> {
  const host = await startHost(home.root);
  home.env["PI_WORKSPACE_SOCKET"] = host.socketPath;
  home.env["PI_WORKSPACE_CAPABILITY"] = randomBytes(32).toString("hex");
  try {
    await withRpc(home, rpcScenario);
  } finally {
    await stopHost(host);
  }
}

test(
  "the RPC host bridge commits a queued return and reports it with a correlated marker",
  { timeout: 120_000 },
  async () => {
    await withIsolatedHome(withAttachedRpc);
  },
);
