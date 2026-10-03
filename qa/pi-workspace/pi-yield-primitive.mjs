#!/usr/bin/env node
// Judge-owned Pi primitive test. The local "hello" fixture is not a product branch tool.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const sdkRoot = "/usr/local/lib/node_modules/@earendil-works/pi-coding-agent";
const temporary = await mkdtemp(path.join(tmpdir(), "pi-yield-oracle-"));
const agentDir = path.join(temporary, "agent");
const projectDir = path.join(temporary, "project");
await Promise.all([mkdir(agentDir), mkdir(projectDir)]);
const inheritedEnvironment = new Set(["PATH", "TMPDIR", "LANG", "LC_ALL", "SHELL"]);
for (const key of Object.keys(process.env)) {
  if (!inheritedEnvironment.has(key)) delete process.env[key];
}
const tracePath = path.join(temporary, "requests.jsonl");
Object.assign(process.env, {
  HOME: temporary,
  PI_CODING_AGENT_DIR: agentDir,
  PI_OFFLINE: "1",
  PI_SKIP_VERSION_CHECK: "1",
  PI_TELEMETRY: "0",
  PI_WORKSPACE_ORACLE_TRACE: tracePath,
  CI: "1",
});
const { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } = await import(
  pathToFileURL(path.join(sdkRoot, "dist/index.js")).href
);

let releaseHold;
let markHoldStarted;
const held = new Promise((resolve) => {
  releaseHold = resolve;
});
const holdStarted = new Promise((resolve) => {
  markHoldStarted = resolve;
});
let session;
let runningPrompt;
async function requestCount() {
  return (await readFile(tracePath, "utf8")).trim().split("\n").length;
}
try {
  const resourceLoader = new DefaultResourceLoader({
    cwd: projectDir,
    agentDir,
    additionalExtensionPaths: [fileURLToPath(new URL("./scripted-provider.mjs", import.meta.url))],
    extensionFactories: [
      (pi) => {
        pi.registerTool({
          name: "hello",
          label: "Judge-only yield fixture",
          description: "Exercise native tool-batch termination without any product implementation",
          parameters: {
            type: "object",
            properties: { mode: { type: "string", enum: ["yield", "hold"] } },
            required: ["mode"],
            additionalProperties: false,
          },
          async execute(_id, input) {
            if (input.mode === "hold") {
              markHoldStarted();
              await held;
            }
            return {
              content: [{ type: "text", text: `fixture:${input.mode}` }],
              details: { mode: input.mode },
              terminate: input.mode === "yield",
            };
          },
        });
      },
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
    resourceLoader,
    sessionManager: SessionManager.inMemory(projectDir),
    settingsManager: SettingsManager.inMemory(),
  });
  session = created.session;
  await session.bindExtensions({});
  const model = session.modelRuntime.getModel("pi-workspace-oracle", "scripted");
  assert.notEqual(model, undefined);
  await session.setModel(model);

  await session.prompt('oracle-call:{"name":"hello","arguments":{"mode":"yield"}}');
  assert.equal(
    await requestCount(),
    1,
    "A sole terminating result must not cause another model request",
  );
  assert.equal(session.isStreaming, false);
  assert.equal(session.messages.filter((message) => message.role === "toolResult").length, 1);

  runningPrompt = session.prompt(
    'oracle-batch:[{"name":"hello","arguments":{"mode":"yield"}},{"name":"hello","arguments":{"mode":"hold"}}]',
  );
  await holdStarted;
  assert.equal(session.isStreaming, true);
  assert.equal(await requestCount(), 2, "A pending sibling must finish before the next request");
  releaseHold();
  await runningPrompt;
  runningPrompt = undefined;
  assert.equal(
    await requestCount(),
    3,
    "A mixed batch with one non-terminating result DOES request a follow-up",
  );
  assert.equal(session.isStreaming, false);

  await session.prompt(
    'oracle-batch:[{"name":"hello","arguments":{"mode":"yield"}},{"name":"hello","arguments":{"mode":"yield"}}]',
  );
  assert.equal(await requestCount(), 4, "Every result must agree to terminate the batch");
  assert.equal(session.isStreaming, false);
  console.log("PASS real Pi solo/all-result yielding and mixed-batch continuation semantics");
} finally {
  releaseHold();
  if (runningPrompt) await runningPrompt;
  session?.dispose();
  await rm(temporary, { recursive: true, force: true });
}
