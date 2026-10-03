#!/usr/bin/env node
// Judge-owned prerequisite guard: real isolated Paseo daemon and real Pi, scripted model only.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repository = process.cwd();
const temporary = await mkdtemp(path.join(tmpdir(), "paseo-pi-oracle-"));
const projectDir = path.join(temporary, "project");
const agentDir = path.join(temporary, "pi-agent");
const daemonRoot = path.join(temporary, "daemon");
await Promise.all([mkdir(projectDir), mkdir(agentDir), mkdir(daemonRoot)]);
const inheritedEnvironment = new Set(["PATH", "TMPDIR", "LANG", "LC_ALL", "SHELL"]);
for (const key of Object.keys(process.env)) {
  if (!inheritedEnvironment.has(key)) delete process.env[key];
}
Object.assign(process.env, {
  HOME: temporary,
  PASEO_HOME: path.join(daemonRoot, ".paseo"),
  PASEO_SUPERVISED: "0",
  PI_CODING_AGENT_DIR: agentDir,
  PI_OFFLINE: "1",
  PI_SKIP_VERSION_CHECK: "1",
  PI_TELEMETRY: "0",
  CI: "1",
  PI_WORKSPACE_ORACLE_TRACE: path.join(temporary, "requests.jsonl"),
});

function source(relative) {
  return pathToFileURL(path.join(repository, relative)).href;
}
const { default: pino } = await import("pino");
const { createTestPaseoDaemon } = await import(
  source("packages/server/src/server/test-utils/paseo-daemon.ts")
);
const { DaemonClient } = await import(
  source("packages/server/src/server/test-utils/daemon-client.ts")
);
const { PiRpcAgentClient } = await import(
  source("packages/server/src/server/agent/providers/pi/agent.ts")
);
const logger = pino({ level: "silent" });
const disabledLocal = { provider: "local", explicit: true, enabled: false };
const provider = new PiRpcAgentClient({
  logger,
  runtimeSettings: {
    command: {
      mode: "replace",
      argv: [
        "/usr/local/bin/pi",
        "--no-extensions",
        "--no-skills",
        "--no-prompt-templates",
        "--no-context-files",
        "--offline",
        "--tools",
        "hello",
        "-e",
        "/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/examples/extensions/hello.ts",
        "-e",
        fileURLToPath(new URL("./scripted-provider.mjs", import.meta.url)),
      ],
    },
    env: {
      HOME: temporary,
      PI_CODING_AGENT_DIR: agentDir,
      PI_OFFLINE: "1",
      PI_SKIP_VERSION_CHECK: "1",
      PI_TELEMETRY: "0",
      PI_WORKSPACE_ORACLE_TRACE: process.env.PI_WORKSPACE_ORACLE_TRACE,
    },
  },
});

let daemon;
let client;
const failures = [];
try {
  daemon = await createTestPaseoDaemon({
    logger,
    paseoHomeRoot: daemonRoot,
    agentClients: { pi: provider },
    mcpEnabled: false,
    relayEnabled: false,
    pluginsEnabled: false,
    voiceLlmProvider: null,
    speech: {
      providers: {
        dictationStt: disabledLocal,
        voiceTurnDetection: disabledLocal,
        voiceStt: disabledLocal,
        voiceTts: disabledLocal,
      },
    },
  });
  assert.notEqual(daemon.port, 6767, "Never connect tests to the production daemon");
  assert.equal(daemon.paseoHome.startsWith(temporary + path.sep), true);
  client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws`, appVersion: "0.10.3" });
  await client.connect();
  assert.equal(client.isConnected, true);
  const created = await client.createWorkspace({ source: { kind: "directory", path: projectDir } });
  assert.notEqual(created.workspace, undefined);
  const workspace = created.workspace;
  const agent = await client.createAgent({
    cwd: projectDir,
    workspaceId: workspace.id,
    title: "Isolated Pi workspace oracle",
    provider: "pi",
    model: "pi-workspace-oracle/scripted",
    thinkingOptionId: "off",
  });
  const commands = await client.listCommands({ agentId: agent.id });
  assert.equal(commands.error, null);
  await client.sendMessage(
    agent.id,
    'oracle-call:{"name":"hello","arguments":{"name":"daemon oracle"}}',
  );
  const finished = await client.waitForFinish(agent.id, 30000);
  assert.equal(finished.status, "idle");
  const timeline = await client.fetchAgentTimeline(agent.id, {
    direction: "tail",
    limit: 0,
    projection: "canonical",
  });
  const items = timeline.entries.map((entry) => entry.item);
  const calls = items.filter((item) => item.type === "tool_call" && item.name === "hello");
  assert.equal(calls.length, 1, "The actual Pi tool call must reach Paseo's canonical timeline");
  assert.equal(calls[0].status, "completed");
  assert.equal(JSON.stringify(calls[0]).includes("Hello, daemon oracle!"), true);
  assert.equal(
    items.some(
      (item) => item.type === "assistant_message" && item.text.includes("ORACLE_TOOL_COMPLETE"),
    ),
    true,
  );
  const requests = (await readFile(process.env.PI_WORKSPACE_ORACLE_TRACE, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(requests.length, 2);
  assert.equal(
    requests.every((request) => request.provider === "pi-workspace-oracle"),
    true,
  );
  const sessionFiles = (await readdir(path.join(agentDir, "sessions"), { recursive: true })).filter(
    (entry) => entry.endsWith(".jsonl"),
  );
  assert.equal(sessionFiles.length, 1, "Only the isolated actual Pi session should be persisted");
  await client.removeProject(workspace.projectId);
} catch (error) {
  failures.push(error);
} finally {
  if (client) {
    try {
      await client.close();
    } catch (error) {
      failures.push(error);
    }
  }
  if (daemon) {
    try {
      await daemon.daemon.stop();
      await daemon.daemon.agentManager.flush();
      await rm(daemon.staticDir, { recursive: true, force: true });
    } catch (error) {
      failures.push(error);
    }
  }
  try {
    await rm(temporary, { recursive: true, force: true });
  } catch (error) {
    failures.push(error);
  }
}
if (failures.length > 0) throw new AggregateError(failures, "Paseo/Pi oracle failed");
console.log("PASS real isolated Paseo-to-Pi tool loop and canonical timeline");
