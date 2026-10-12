// Independent prerequisite: actual Paseo/Pi launches and verifies a deterministic delegate child.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, chmod, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
const repository = process.cwd();
const packageRoot = process.argv[2];
if (!packageRoot || !path.isAbsolute(packageRoot))
  throw new Error("Explicit package fixture root required");
const temporary = await mkdtemp(path.join(tmpdir(), "paseo-bg-delegate-"));
const projectDir = path.join(temporary, "project");
const agentDir = path.join(temporary, "pi-agent");
const daemonRoot = path.join(temporary, "daemon");
const bin = path.join(temporary, "bin");
for (const dir of [projectDir, agentDir, daemonRoot, bin]) await mkdir(dir);
const child = path.join(bin, "pi");
await writeFile(
  child,
  await readFile(path.join(repository, "qa/pi-background-jobs/delegate-child.cjs")),
);
await chmod(child, 0o700);
const originalPath = process.env.PATH;
if (!originalPath) throw new Error("Fixture PATH missing");
const childPath = `${bin}${path.delimiter}${originalPath}`;
const trace = path.join(temporary, "model.jsonl");
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
        "--tools",
        "bg_delegate,bg_result",
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
      PI_WORKSPACE_ORACLE_TRACE: trace,
      PATH: childPath,
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
    title: "Delegate prerequisite",
    model: "pi-background-oracle/scripted",
    thinkingOptionId: "off",
  });
  await client.sendMessage(
    agent.id,
    `oracle-call:${JSON.stringify({
      name: "bg_delegate",
      arguments: {
        name: "Delegate inspector",
        prompt: "UI result sentinel",
        route: { provider: "pi-background-oracle", model: "child-model" },
        notifyOnCompletion: false,
        triggerOnCompletion: false,
        autoDeliver: "never",
      },
    })}`,
  );
  const finished = await client.waitForFinish(agent.id, 30000);
  assert.equal(finished.status, "idle", JSON.stringify(finished));
  const earlyRoot = path.join(agentDir, "sessions");
  const earlyFiles = (await readdir(earlyRoot, { recursive: true })).filter((file) =>
    file.endsWith(".jsonl"),
  );
  assert.equal(earlyFiles.length, 1);
  const earlyEntries = (await readFile(path.join(earlyRoot, earlyFiles[0]), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const launchRecords = earlyEntries.filter(
    (entry) =>
      entry.type === "message" &&
      entry.message?.role === "toolResult" &&
      entry.message.toolName === "bg_delegate",
  );
  assert.equal(launchRecords.length, 1);
  assert.equal(launchRecords[0].message.isError, false, JSON.stringify(launchRecords[0].message));
  let task;
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const files = await readdir(path.join(projectDir, ".pi/tasks"), { recursive: true });
    const metadataFiles = files.filter((file) => file.endsWith(".json"));
    assert.equal(metadataFiles.length, 1, "Exactly one real delegate task must be created");
    task = JSON.parse(await readFile(path.join(projectDir, ".pi/tasks", metadataFiles[0]), "utf8"));
    if (task.status !== "running") break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.notEqual(task, undefined);
  assert.equal(task.status, "completed", JSON.stringify(task));
  assert.equal(task.delegate.route.model, "child-model");
  assert.equal(task.notifyOnCompletion, false);
  assert.equal(task.triggerOnCompletion, false);
  await client.sendMessage(
    agent.id,
    `oracle-call:${JSON.stringify({ name: "bg_result", arguments: { taskId: task.id, delivery: "inline" } })}`,
  );
  const resultFinish = await client.waitForFinish(agent.id, 30000);
  assert.equal(resultFinish.status, "idle", JSON.stringify(resultFinish));
  const sessionsRoot = path.join(agentDir, "sessions");
  const files = (await readdir(sessionsRoot, { recursive: true })).filter((file) =>
    file.endsWith(".jsonl"),
  );
  assert.equal(files.length, 1);
  const entries = (await readFile(path.join(sessionsRoot, files[0]), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const results = entries.filter(
    (entry) =>
      entry.type === "message" &&
      entry.message?.role === "toolResult" &&
      entry.message.toolName === "bg_result",
  );
  assert.equal(results.length, 1);
  assert.equal(results[0].message.isError, false);
  assert.equal(results[0].message.details.state, "committed");
  assert.equal(
    results[0].message.content.some(
      (part) =>
        part.type === "text" && part.text.endsWith("DELEGATE VERIFIED ANSWER: UI result sentinel"),
    ),
    true,
  );
  assert.equal((await readFile(trace, "utf8")).trim().split("\n").length, 4);
  console.log(
    "PASS real Paseo/Pi delegate launch, distinct child route, durable committed result and hash-verified bg_result; four scripted requests only",
  );
} catch (error) {
  failures.push(error);
} finally {
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
if (failures.length > 0) throw new AggregateError(failures, "Delegate prerequisite failed");
