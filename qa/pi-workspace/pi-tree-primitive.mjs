#!/usr/bin/env node
// Judge-owned prerequisite guard: native Pi tree navigation, not the unimplemented product tools.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const sdkRoot = "/usr/local/lib/node_modules/@earendil-works/pi-coding-agent";
const sdkManifest = JSON.parse(await readFile(path.join(sdkRoot, "package.json"), "utf8"));
assert.equal(sdkManifest.version, "1.0.0");
const temporary = await mkdtemp(path.join(tmpdir(), "pi-workspace-tree-oracle-"));
const agentDir = path.join(temporary, "agent");
const projectDir = path.join(temporary, "project");
const sessionDir = path.join(temporary, "sessions");
await Promise.all([mkdir(agentDir), mkdir(projectDir), mkdir(sessionDir)]);
const inheritedEnvironment = new Set(["PATH", "TMPDIR", "LANG", "LC_ALL", "SHELL"]);
for (const key of Object.keys(process.env)) {
  if (!inheritedEnvironment.has(key)) delete process.env[key];
}
Object.assign(process.env, {
  HOME: temporary,
  PI_CODING_AGENT_DIR: agentDir,
  PI_OFFLINE: "1",
  PI_SKIP_VERSION_CHECK: "1",
  PI_TELEMETRY: "0",
  CI: "1",
  PI_WORKSPACE_ORACLE_TRACE: path.join(temporary, "requests.jsonl"),
});

const { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } = await import(
  pathToFileURL(path.join(sdkRoot, "dist/index.js")).href
);
let cancellationRequested = false;
let session;

async function load(manager) {
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false } });
  const resourceLoader = new DefaultResourceLoader({
    cwd: projectDir,
    agentDir,
    settingsManager,
    additionalExtensionPaths: [
      path.join(sdkRoot, "examples/extensions/hello.ts"),
      fileURLToPath(new URL("./scripted-provider.mjs", import.meta.url)),
    ],
    extensionFactories: [
      (pi) =>
        pi.on("session_before_tree", () => (cancellationRequested ? { cancel: true } : undefined)),
    ],
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noContextFiles: true,
  });
  await resourceLoader.reload();
  assert.deepEqual(resourceLoader.getExtensions().errors, []);
  const created = await createAgentSession({
    cwd: projectDir,
    agentDir,
    noTools: "builtin",
    sessionManager: manager,
    settingsManager,
    resourceLoader,
  });
  await created.session.bindExtensions({});
  const model = created.session.modelRuntime.getModel("pi-workspace-oracle", "scripted");
  assert.notEqual(model, undefined);
  await created.session.setModel(model);
  return created.session;
}

async function requests() {
  const text = await readFile(process.env.PI_WORKSPACE_ORACLE_TRACE, "utf8");
  return text
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}

try {
  const manager = SessionManager.create(projectDir, sessionDir);
  session = await load(manager);
  await session.prompt("oracle-text:MAIN_BEFORE_DETOUR");
  const checkpoint = manager.appendCustomEntry("oracle.return-checkpoint", {
    reason: "native-prerequisite",
  });
  const sessionId = manager.getSessionId();
  const sessionFile = manager.getSessionFile();
  assert.equal(typeof sessionFile, "string");
  const before = structuredClone(manager.getEntries());
  const originalTools = session.getActiveToolNames().slice().sort();
  assert.deepEqual(originalTools, ["hello"]);

  await session.prompt("oracle-text:UNSELECTED_DETOUR_SECRET");
  const detourLeaf = manager.getLeafId();
  assert.equal(JSON.stringify(session.messages).includes("UNSELECTED_DETOUR_SECRET"), true);
  assert.equal((await requests()).length, 2);

  cancellationRequested = true;
  const cancelled = await session.navigateTree(checkpoint, { summarize: false });
  assert.equal(cancelled.cancelled, true);
  assert.equal(manager.getLeafId(), detourLeaf, "Cancelled navigation must not move the branch");
  assert.equal((await requests()).length, 2, "Cancellation must not call a summarizer");

  cancellationRequested = false;
  const returned = await session.navigateTree(checkpoint, { summarize: false });
  assert.equal(returned.cancelled, false);
  assert.equal(manager.getSessionId(), sessionId);
  assert.equal(manager.getSessionFile(), sessionFile);
  assert.deepEqual(session.getActiveToolNames().slice().sort(), originalTools);
  assert.equal(JSON.stringify(session.messages).includes("MAIN_BEFORE_DETOUR"), true);
  assert.equal(JSON.stringify(session.messages).includes("UNSELECTED_DETOUR_SECRET"), false);
  assert.equal((await requests()).length, 2, "Native return must not call a hidden model");

  await session.sendCustomMessage(
    {
      customType: "oracle.selected-return",
      content: "SELECTED_RETURN_NOTE artifact:fixture-visual",
      display: true,
      details: { artifact: "fixture-visual" },
    },
    { triggerTurn: false },
  );
  manager.appendCustomEntry("oracle.return-complete", { checkpoint });
  assert.equal((await requests()).length, 2, "Supplied notes must not start a model turn");
  await session.prompt("oracle-text:MAIN_AFTER_RETURN");
  const traced = await requests();
  assert.equal(traced.length, 3);
  const resumedContext = JSON.stringify(traced[2].messages);
  assert.equal(resumedContext.includes("MAIN_BEFORE_DETOUR"), true);
  assert.equal(resumedContext.includes("SELECTED_RETURN_NOTE"), true);
  assert.equal(resumedContext.includes("artifact:fixture-visual"), true);
  assert.equal(resumedContext.includes("UNSELECTED_DETOUR_SECRET"), false);

  const allEntries = manager.getEntries();
  for (const entry of before) {
    assert.deepEqual(
      allEntries.find((candidate) => candidate.id === entry.id),
      entry,
      "Existing Pi entries must retain identity, ancestry and content",
    );
  }
  assert.equal(
    JSON.stringify(allEntries).includes("UNSELECTED_DETOUR_SECRET"),
    true,
    "The abandoned detour must remain recoverable",
  );
  assert.notEqual(manager.getLeafId(), detourLeaf);
  const returnedLeaf = manager.getLeafId();
  session.dispose();
  session = undefined;

  const reopenedManager = SessionManager.open(sessionFile, sessionDir);
  assert.equal(reopenedManager.getSessionId(), sessionId);
  assert.equal(reopenedManager.getLeafId(), returnedLeaf);
  session = await load(reopenedManager);
  const reopenedContext = JSON.stringify(session.messages);
  assert.equal(reopenedContext.includes("MAIN_AFTER_RETURN"), true);
  assert.equal(reopenedContext.includes("SELECTED_RETURN_NOTE"), true);
  assert.equal(reopenedContext.includes("UNSELECTED_DETOUR_SECRET"), false);
  assert.equal((await requests()).length, 3, "Reopening must not run a model");
  console.log("PASS native Pi same-file tree, cancellation, selective context and durable reopen");
} finally {
  session?.dispose();
  await rm(temporary, { recursive: true, force: true });
}
