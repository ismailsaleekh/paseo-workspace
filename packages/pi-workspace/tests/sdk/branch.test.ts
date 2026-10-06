import assert from "node:assert/strict";
import { test } from "node:test";
import { randomBytes, randomUUID } from "node:crypto";
import { createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import { z } from "zod";
import type { AgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import {
  BRANCH_CHECKPOINT_TYPE,
  BRANCH_COMMIT_COMMAND,
  BRANCH_NOTES_TYPE,
  BRANCH_OPENED_TYPE,
  BRANCH_RETURNED_TYPE,
  BRANCH_STATUS_TYPE,
  encodeBranchCommitPayload,
} from "../../src/branch.js";
import {
  extensionPath,
  providerPath,
  readRequests,
  withIsolatedHome,
  type IsolatedHome,
} from "../helpers/pi-harness.js";

const FrameSchema = z.object({
  kind: z.string(),
  sessionId: z.string().optional(),
  requestId: z.string().optional(),
});
const QueuedSchema = z.object({
  role: z.literal("toolResult"),
  isError: z.literal(false),
  details: z.object({ status: z.literal("queued"), operation: z.string().min(1) }),
});

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

interface Harness {
  home: IsolatedHome;
  session: AgentSession;
  manager: SessionManager;
  cancel: { value: boolean };
}

/** Bounds one awaited step so a stall names the step instead of hanging the suite. */
async function stalledError(harness: Harness, label: string): Promise<Error> {
  let count = 0;
  try {
    count = (await readRequests(harness.home)).length;
  } catch {
    count = 0;
  }
  await harness.session.abort();
  return new Error(`stalled at ${label} after ${count} model requests`);
}
async function step<T>(harness: Harness, label: string, work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stalled = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      void stalledError(harness, label).then(reject);
    }, 15_000);
  });
  try {
    return await Promise.race([work, stalled]);
  } finally {
    clearTimeout(timer);
  }
}

async function unsupportedCommandAction(): Promise<never> {
  throw new Error("Not used by the detour tests");
}

async function withAttachedSdk(
  home: IsolatedHome,
  run: (harness: Harness) => Promise<void>,
): Promise<void> {
  const host = await startHost(home.root);
  process.env["PI_WORKSPACE_SOCKET"] = host.socketPath;
  process.env["PI_WORKSPACE_CAPABILITY"] = randomBytes(32).toString("hex");
  const cancel = { value: false };
  const sdk = await import("@earendil-works/pi-coding-agent");
  const settingsManager = sdk.SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: false },
  });
  const resourceLoader = new sdk.DefaultResourceLoader({
    cwd: home.cwd,
    agentDir: home.agentDir,
    settingsManager,
    additionalExtensionPaths: [extensionPath, providerPath],
    extensionFactories: [
      (pi) => {
        pi.on("session_before_tree", () => (cancel.value ? { cancel: true } : undefined));
      },
    ],
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noContextFiles: true,
  });
  await resourceLoader.reload();
  assert.deepEqual(resourceLoader.getExtensions().errors, []);
  const manager = sdk.SessionManager.inMemory(home.cwd);
  const { session } = await sdk.createAgentSession({
    cwd: home.cwd,
    agentDir: home.agentDir,
    noTools: "builtin",
    resourceLoader,
    settingsManager,
    sessionManager: manager,
  });
  try {
    // Like Pi's RPC/interactive modes, a command-capable host binds native tree navigation.
    await session.bindExtensions({
      commandContextActions: {
        waitForIdle: async () => undefined,
        newSession: unsupportedCommandAction,
        fork: unsupportedCommandAction,
        switchSession: unsupportedCommandAction,
        reload: unsupportedCommandAction,
        navigateTree: (targetId, options) => session.navigateTree(targetId, options),
      },
    });
    const model = session.modelRuntime.getModel("pi-workspace-tests", "scripted");
    if (!model) throw new Error("Isolated scripted test provider did not load");
    await session.setModel(model);
    await run({ home, session, manager, cancel });
  } finally {
    session.dispose();
    await stopHost(host);
  }
}

type SessionEntry = ReturnType<SessionManager["getEntries"]>[number];

function call(name: string, args: Record<string, unknown>): string {
  return `call:${JSON.stringify({ name, arguments: args })}`;
}
function isToolResult(message: { role: string }): boolean {
  return message.role === "toolResult";
}
function lastQueuedOperation(session: AgentSession): string {
  return QueuedSchema.parse(session.messages.findLast(isToolResult)).details.operation;
}
function ofType(manager: SessionManager, customType: string): SessionEntry[] {
  const matches: SessionEntry[] = [];
  for (const entry of manager.getEntries())
    if ("customType" in entry && entry.customType === customType) matches.push(entry);
  return matches;
}
function entryById(manager: SessionManager, id: string | null): SessionEntry | undefined {
  for (const entry of manager.getEntries()) if (entry.id === id) return entry;
  return undefined;
}
function onBranch(manager: SessionManager, id: string): boolean {
  for (const entry of manager.getBranch()) if (entry.id === id) return true;
  return false;
}
async function prompt(harness: Harness, text: string): Promise<void> {
  await step(harness, text.slice(0, 60), harness.session.prompt(text));
}
async function commit(harness: Harness, operation: string): Promise<void> {
  const payload = encodeBranchCommitPayload({ requestId: randomUUID(), operation });
  await prompt(harness, `/${BRANCH_COMMIT_COMMAND} ${payload}`);
}

async function detourScenario(harness: Harness): Promise<void> {
  const { home, session, manager, cancel } = harness;
  const sessionId = manager.getSessionId();
  await prompt(harness, "MAIN_CONTEXT");
  await prompt(harness, call("branch_open", { title: "Side question" }));
  assert.equal((await readRequests(home)).length, 2, "open yields without a follow-up");
  const [checkpoint] = ofType(manager, BRANCH_CHECKPOINT_TYPE);
  const [opened] = ofType(manager, BRANCH_OPENED_TYPE);
  if (!checkpoint || !opened) throw new Error("open was not committed");
  assert.equal(checkpoint.type, "custom");
  assert.equal(opened.parentId, checkpoint.id);
  const resultEntry = entryById(manager, checkpoint.parentId);
  assert.equal(
    resultEntry?.type === "message" && resultEntry.message.role === "toolResult",
    true,
    "the checkpoint is appended at the leaf after the branch_open result",
  );

  await prompt(harness, "DETOUR_ONLY_TEXT");
  const detourRequest = JSON.stringify((await readRequests(home)).at(-1)?.messages);
  assert.equal(detourRequest.includes("MAIN_CONTEXT"), true);
  assert.equal(detourRequest.includes("Side question"), true);

  await prompt(harness, call("branch_return", { notes: "CANCELLED_NOTE" }));
  const cancelledOperation = lastQueuedOperation(session);
  const leafBefore = manager.getLeafId();
  cancel.value = true;
  await commit(harness, cancelledOperation);
  const [status] = ofType(manager, BRANCH_STATUS_TYPE);
  assert.equal(status?.parentId, leafBefore, "cancellation leaves the position unchanged");
  assert.deepEqual(ofType(manager, BRANCH_NOTES_TYPE), []);
  assert.equal(onBranch(manager, opened.id), true);

  cancel.value = false;
  await prompt(harness, call("branch_return", { notes: "KEPT_NOTE" }));
  const operation = lastQueuedOperation(session);
  const requestsBefore = (await readRequests(home)).length;
  await commit(harness, operation);
  await commit(harness, operation);
  assert.equal((await readRequests(home)).length, requestsBefore, "no summary model ran");
  const notes = ofType(manager, BRANCH_NOTES_TYPE);
  assert.equal(notes.length, 1, "a retried commit never duplicates the notes");
  assert.equal(notes[0]?.parentId, checkpoint.id);
  assert.equal(ofType(manager, BRANCH_RETURNED_TYPE).length, 1);
  assert.equal(onBranch(manager, opened.id), false);
  assert.equal(JSON.stringify(manager.getEntries()).includes("DETOUR_ONLY_TEXT"), true);

  await prompt(harness, "AFTER_RETURN");
  const resumed = JSON.stringify((await readRequests(home)).at(-1)?.messages);
  assert.equal(resumed.includes("MAIN_CONTEXT"), true);
  assert.equal(resumed.includes("KEPT_NOTE"), true);
  assert.equal(resumed.includes("DETOUR_ONLY_TEXT"), false);
  assert.equal(resumed.includes("CANCELLED_NOTE"), false);
  assert.equal(manager.getSessionId(), sessionId);

  await prompt(harness, call("branch_return", { notes: "NOWHERE" }));
  const refused = session.messages.findLast(isToolResult);
  assert.equal(JSON.stringify(refused).includes("NO_ACTIVE_DETOUR"), true);
}

async function continuationScenario(harness: Harness): Promise<void> {
  const { home, manager } = harness;
  await prompt(harness, call("branch_open", { title: "Later", purpose: "Context only" }));
  assert.equal((await readRequests(home)).length, 1, "a purpose alone yields");
  await prompt(
    harness,
    call("branch_open", {
      title: "Why",
      purpose: "Explain the failing cache now",
      answer_now: true,
    }),
  );
  const requests = await readRequests(home);
  assert.equal(requests.length, 3, "the tool call plus one continuation");
  assert.equal(
    JSON.stringify(requests[2]?.messages).includes("Explain the failing cache now"),
    true,
  );
  const opened = ofType(manager, BRANCH_OPENED_TYPE).at(-1);
  if (!opened) throw new Error("open was not committed");
  assert.equal(onBranch(manager, opened.id), true);
  const leaf = manager.getBranch().at(-1);
  assert.equal(leaf?.type === "message" && leaf.message.role === "assistant", true);
}

test(
  "real Pi detour: same session, checkpoint, marker, cancellation, selective return, no summary",
  { timeout: 120_000 },
  async () => {
    await withIsolatedHome((home) => withAttachedSdk(home, detourScenario));
  },
);

test(
  "answer_now runs exactly one ordinary continuation inside the committed detour; a purpose alone none",
  { timeout: 120_000 },
  async () => {
    await withIsolatedHome((home) => withAttachedSdk(home, continuationScenario));
  },
);
