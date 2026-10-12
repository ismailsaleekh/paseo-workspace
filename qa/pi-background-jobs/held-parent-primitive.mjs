// Independent prerequisite: the no-inference parent fixture truly stays running until released.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
const repository = process.cwd();
const packageRoot = process.argv[2];
if (!packageRoot || !path.isAbsolute(packageRoot))
  throw new Error("Explicit package fixture root required");
const temporary = await mkdtemp(path.join(tmpdir(), "paseo-bg-held-"));
const projectDir = path.join(temporary, "project");
const agentDir = path.join(temporary, "pi");
const daemonRoot = path.join(temporary, "daemon");
for (const directory of [projectDir, agentDir, daemonRoot]) await mkdir(directory);
const gate = path.join(temporary, "gate");
const trace = path.join(temporary, "model.jsonl");
await writeFile(gate, "closed");
const keep = new Set(["PATH", "TMPDIR", "LANG", "LC_ALL", "SHELL"]);
for (const key of Object.keys(process.env)) if (!keep.has(key)) delete process.env[key];
Object.assign(process.env, {
  HOME: temporary,
  PASEO_HOME: path.join(daemonRoot, ".paseo"),
  PASEO_SUPERVISED: "0",
  PI_CODING_AGENT_DIR: agentDir,
  PI_OFFLINE: "1",
  PI_TELEMETRY: "0",
  PI_SKIP_VERSION_CHECK: "1",
  CI: "1",
  PI_BG_ORACLE_GATE: gate,
  PI_WORKSPACE_ORACLE_TRACE: trace,
});
const source = (relative) => pathToFileURL(path.join(repository, relative)).href;
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
const disabled = { provider: "local", explicit: true, enabled: false };
const provider = new PiRpcAgentClient({
  logger,
  runtimeSettings: {
    command: {
      mode: "replace",
      argv: [
        "/usr/local/bin/pi",
        "--offline",
        "--no-extensions",
        "--no-skills",
        "--no-prompt-templates",
        "--no-context-files",
        "--no-tools",
        "-e",
        path.join(packageRoot, "dist/extensions/background-tasks.js"),
        "-e",
        path.join(repository, "qa/pi-background-jobs/scripted-provider.mjs"),
      ],
    },
    env: {
      HOME: temporary,
      PI_CODING_AGENT_DIR: agentDir,
      PI_OFFLINE: "1",
      PI_TELEMETRY: "0",
      PI_BG_ORACLE_GATE: gate,
      PI_WORKSPACE_ORACLE_TRACE: trace,
    },
  },
});
let daemon;
let client;
let projectId;
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
        dictationStt: disabled,
        voiceTurnDetection: disabled,
        voiceStt: disabled,
        voiceTts: disabled,
      },
    },
  });
  assert.notEqual(daemon.port, 6767);
  assert.notEqual(daemon.port, 6768);
  client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws`, appVersion: "0.10.3" });
  await client.connect();
  const workspace = (
    await client.createWorkspace({ source: { kind: "directory", path: projectDir } })
  ).workspace;
  assert.notEqual(workspace, null);
  assert.notEqual(workspace, undefined);
  projectId = workspace.projectId;
  const agent = await client.createAgent({
    provider: "pi",
    cwd: projectDir,
    workspaceId: workspace.id,
    title: "Held-parent prerequisite",
    model: "pi-background-oracle/scripted",
    thinkingOptionId: "off",
  });
  await client.sendMessage(agent.id, "oracle-hold:prerequisite");
  await client.waitForAgentUpsert(agent.id, (snapshot) => snapshot.status === "running", 15000);
  const deadline = Date.now() + 5000;
  let entered = false;
  while (!entered && Date.now() < deadline) {
    try {
      const frames = (await readFile(trace, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      assert.equal(frames.length, 1);
      assert.equal(frames[0].response.hold, true);
      entered = true;
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  assert.equal(
    entered,
    true,
    "Scripted provider must actually enter the held response before release",
  );
  assert.equal((await client.fetchAgent({ agentId: agent.id })).agent.status, "running");
  assert.equal(await readFile(gate, "utf8"), "closed");
  await writeFile(gate, "open");
  const finished = await client.waitForFinish(agent.id, 30000);
  assert.equal(finished.status, "idle", JSON.stringify(finished));
  const requests = (await readFile(trace, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(requests.length, 1);
  assert.equal(requests[0].provider, "pi-background-oracle");
  assert.equal(requests[0].response.hold, true);
  console.log(
    "PASS actual Pi parent remains running behind a test-owned gate, then settles with exactly one scripted request",
  );
} catch (error) {
  failures.push(error);
} finally {
  try {
    await writeFile(gate, "open");
  } catch (error) {
    failures.push(error);
  }
  if (client && projectId) {
    try {
      await client.removeProject(projectId);
    } catch (error) {
      failures.push(error);
    }
  }
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
if (failures.length > 0) throw new AggregateError(failures, "Held-parent prerequisite failed");
