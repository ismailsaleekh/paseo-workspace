// Supervisor-owned wire acceptance: actual daemon/Pi, no product client for the new RPCs.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import { connect as connectLocal } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { WireClient } from "./wire-client.mjs";

const repository = process.cwd();
const packageRoot = process.argv[2];
if (!packageRoot || !path.isAbsolute(packageRoot))
  throw new Error("Explicit pinned package fixture root required");
const root = await mkdtemp(path.join(tmpdir(), "paseo-bg-wire-"));
const cwd = path.join(root, "project");
const agentDir = path.join(root, "pi");
const daemonRoot = path.join(root, "daemon");
for (const dir of [cwd, agentDir, daemonRoot]) await mkdir(dir);
const trace = path.join(root, "model.jsonl");
const keep = new Set(["PATH", "TMPDIR", "LANG", "LC_ALL", "SHELL"]);
for (const name of Object.keys(process.env)) if (!keep.has(name)) delete process.env[name];
Object.assign(process.env, {
  HOME: root,
  PASEO_HOME: path.join(daemonRoot, ".paseo"),
  PASEO_SUPERVISED: "0",
  PI_CODING_AGENT_DIR: agentDir,
  PI_OFFLINE: "1",
  PI_TELEMETRY: "0",
  PI_SKIP_VERSION_CHECK: "1",
  PI_WORKSPACE_ORACLE_TRACE: trace,
  CI: "1",
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
const { PiCliRuntime } = await import(
  source("packages/server/src/server/agent/providers/pi/cli-runtime.ts")
);
const { SessionAuthorization } = await import(
  source("packages/server/src/server/authorization/index.ts")
);
const { SessionInboundMessageSchema } = await import(source("packages/protocol/src/messages.ts"));
const logger = pino({ level: "silent" });
const disabled = { provider: "local", explicit: true, enabled: false };
const runtime = new PiCliRuntime({
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
        "bg_run",
        "-e",
        path.join(packageRoot, "dist/extensions/background-tasks.js"),
        "-e",
        path.join(repository, "qa/pi-background-jobs/scripted-provider.mjs"),
      ],
    },
    env: {
      HOME: root,
      PI_CODING_AGENT_DIR: agentDir,
      PI_OFFLINE: "1",
      PI_TELEMETRY: "0",
      PI_WORKSPACE_ORACLE_TRACE: trace,
    },
  },
});
// Observe the actual launch boundary while forwarding every operation to the real runtime.
const launches = [];
const observedRuntime = {
  async startSession(input) {
    const session = await runtime.startSession(input);
    launches.push({ input, session });
    return session;
  },
};
const provider = new PiRpcAgentClient({ logger, runtime: observedRuntime });
let daemon;
let driver;
let projectId;
const peers = [];
const failures = [];
let groups = 0;
function pass(label) {
  groups += 1;
  console.log(`PASS ${label}`);
}
function success(message, operation) {
  assert.equal(
    message.type,
    `agent.background_jobs.${operation}.response`,
    JSON.stringify(message),
  );
  return message.payload;
}
function error(message) {
  assert.equal(message.type, "rpc_error", JSON.stringify(message));
  assert.equal(typeof message.payload.code, "string");
}
async function metadata() {
  const taskRoot = path.join(cwd, ".pi/tasks");
  const files = await readdir(taskRoot, { recursive: true });
  return Promise.all(
    files
      .filter((file) => file.endsWith(".json"))
      .map(async (file) => JSON.parse(await readFile(path.join(taskRoot, file), "utf8"))),
  );
}
async function launch(agentId, name) {
  await driver.sendMessage(
    agentId,
    `oracle-call:${JSON.stringify({ name: "bg_run", arguments: { name, command: "printf wire-output; sleep 90", isAgent: false, notifyOnCompletion: false, triggerOnCompletion: false } })}`,
  );
  const done = await driver.waitForFinish(agentId, 30000);
  assert.equal(done.status, "idle", JSON.stringify(done));
  const matches = (await metadata()).filter((task) => task.name === name);
  assert.equal(matches.length, 1);
  assert.equal(matches[0].status, "running");
  return matches[0];
}
async function observe(peer, agentId) {
  const response = success(
    await peer.request("agent.background_jobs.observe.request", { agentId }),
    "observe",
  );
  let state = response.state;
  if (state.status !== "ready") {
    const update = await peer.wait(
      (frame) =>
        frame.message?.type === "agent.background_jobs.update" &&
        frame.message.payload.subscriptionId === response.subscriptionId &&
        frame.message.payload.state.status === "ready",
    );
    state = update.message.payload.state;
  }
  return {
    agentId,
    subscriptionId: response.subscriptionId,
    runtimeId: state.runtimeId,
    activationId: state.activationId,
    sessionId: state.sessionId,
  };
}
function readAddress(binding) {
  return {
    agentId: binding.agentId,
    runtimeId: binding.runtimeId,
    activationId: binding.activationId,
  };
}
async function rejectPrivate(socketPath, frame) {
  const socket = connectLocal(socketPath);
  let received = "";
  let connected = false;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("Unauthorized private peer was not closed"));
    }, 7000);
    socket.on("data", (data) => {
      received += data.toString();
      if (received.length > 65536) {
        socket.destroy();
        clearTimeout(timer);
        reject(new Error("Unbounded private rejection"));
      }
    });
    socket.once("connect", () => {
      connected = true;
      socket.write(JSON.stringify(frame) + "\n");
    });
    socket.once("error", (issue) => {
      if (!connected) {
        clearTimeout(timer);
        reject(issue);
      }
    });
    socket.once("close", () => {
      clearTimeout(timer);
      resolve();
    });
  });
  assert.equal(connected, true, "Negative control must reach the real private listener");
  assert.doesNotMatch(received, /"kind"\s*:\s*"attached"/);
}
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
  const url = `ws://127.0.0.1:${daemon.port}/ws`;
  driver = new DaemonClient({ url, appVersion: "0.10.3" });
  await driver.connect();
  const workspace = (await driver.createWorkspace({ source: { kind: "directory", path: cwd } }))
    .workspace;
  assert.notEqual(workspace, undefined);
  assert.notEqual(workspace, null);
  projectId = workspace.projectId;
  const create = (title) =>
    driver.createAgent({
      provider: "pi",
      cwd,
      workspaceId: workspace.id,
      title,
      model: "pi-background-oracle/scripted",
      thinkingOptionId: "off",
    });
  const agentA = await create("Wire agent A");
  const agentB = await create("Wire agent B");
  const taskA = await launch(agentA.id, "Wire task A");
  const taskB = await launch(agentB.id, "Wire task B");
  pass("actual Pi processes and task metadata are healthy before feature assertions");
  const a = new WireClient(url, "same-logical-client");
  const b = new WireClient(url, "same-logical-client");
  const old = new WireClient(url, "legacy-client", false);
  peers.push(a, b, old);
  const serverInfo = await a.connect();
  await b.connect();
  await old.connect();
  assert.equal((await a.request("ping", { clientSentAt: Date.now() })).type, "pong");
  assert.equal((await b.request("ping", { clientSentAt: Date.now() })).type, "pong");
  pass("two physical sources with one logical client ID both remain independently connected");
  assert.equal(
    serverInfo.features.piBackgroundJobs,
    true,
    "Missing background-jobs daemon capability",
  );
  const bindA = await observe(a, agentA.id);
  const bindB = await observe(b, agentA.id);
  const other = await observe(b, agentB.id);
  assert.notEqual(bindA.subscriptionId, bindB.subscriptionId);
  const list = success(
    await a.request("agent.background_jobs.list.request", readAddress(bindA)),
    "list",
  ).result;
  assert.equal(list.tasks.length, 1);
  assert.equal(list.tasks[0].task.id, taskA.id);
  const logs = success(
    await a.request("agent.background_jobs.logs.request", {
      ...readAddress(bindA),
      taskId: taskA.id,
      maxBytes: 4,
      tail: true,
    }),
    "logs",
  ).result;
  assert.equal(logs.text, "tput");
  assert.equal(logs.truncated, true);
  pass("source-owned wire observation and bounded actual-task reads");

  const reads = ["observe", "list", "detail", "logs", "result"];
  const writes = ["stop", "stop_all", "rerun", "mark_seen"];
  const reader = new SessionAuthorization(["workspace.read"]);
  const writer = new SessionAuthorization(["workspace.write"]);
  const none = new SessionAuthorization([]);
  for (const operation of [...reads, ...writes]) {
    const address = operation === "observe" ? { agentId: agentA.id } : readAddress(bindA);
    const control = writes.includes(operation)
      ? { subscriptionId: bindA.subscriptionId, sequence: 1 }
      : {};
    let selection = {};
    if (operation === "stop_all" || operation === "mark_seen") selection = { taskIds: [taskA.id] };
    else if (operation !== "observe" && operation !== "list") selection = { taskId: taskA.id };
    const request = SessionInboundMessageSchema.parse({
      type: `agent.background_jobs.${operation}.request`,
      requestId: randomUUID(),
      ...address,
      ...control,
      ...selection,
    });
    assert.equal(reader.allowsInbound(request), reads.includes(operation), operation);
    assert.equal(writer.allowsInbound(request), writes.includes(operation), operation);
    assert.equal(none.allowsInbound(request), false, operation);
  }
  for (const change of [
    { taskId: taskB.id },
    { taskId: taskA.id.slice(0, 4) },
    { activationId: randomUUID() },
    { runtimeId: randomUUID() },
  ]) {
    error(
      await a.request("agent.background_jobs.detail.request", {
        ...readAddress(bindA),
        taskId: taskA.id,
        ...change,
      }),
    );
  }
  error(
    await a.request("agent.background_jobs.logs.request", {
      ...readAddress(bindA),
      taskId: taskA.id,
      path: "/etc/passwd",
    }),
  );
  pass("semantic permission classification and real cross-agent/exact-ID/runtime/path refusal");

  const rerunInput = {
    ...readAddress(bindA),
    subscriptionId: bindA.subscriptionId,
    sequence: 1,
    taskId: taskA.id,
  };
  const repeated = await Promise.all([
    a.request("agent.background_jobs.rerun.request", rerunInput),
    a.request("agent.background_jobs.rerun.request", rerunInput),
  ]);
  const first = success(repeated[0], "rerun").result;
  const again = success(repeated[1], "rerun").result;
  assert.equal(first.task.id, again.task.id);
  assert.notEqual(first.task.id, taskA.id);
  for (let sequence = 2; sequence <= 70; sequence += 1)
    success(
      await a.request("agent.background_jobs.stop.request", { ...rerunInput, sequence }),
      "stop",
    );
  const stale = await a.request("agent.background_jobs.rerun.request", rerunInput);
  error(stale);
  assert.equal(stale.payload.code, "STALE_REQUEST");
  assert.equal((await metadata()).filter((task) => task.name === taskA.name).length, 2);
  error(
    await b.request("agent.background_jobs.stop.request", {
      ...rerunInput,
      sequence: 71,
      taskId: first.task.id,
    }),
  );
  assert.equal((await metadata()).find((task) => task.id === first.task.id).status, "running");
  pass(
    "replayed rerun starts once, evicted sequences reject, same-clientId sibling cannot steal authority",
  );

  const released = await a.request("subscription.release.request", {
    subscriptionId: bindA.subscriptionId,
  });
  assert.equal(released.type, "subscription.release.response");
  const beforeRelease = a.frames.length;
  const beforeSiblingStop = b.frames.length;
  success(
    await b.request("agent.background_jobs.stop.request", {
      ...readAddress(bindB),
      subscriptionId: bindB.subscriptionId,
      sequence: 1,
      taskId: first.task.id,
    }),
    "stop",
  );
  await b.wait(
    (frame) =>
      frame.message?.type === "agent.background_jobs.update" &&
      frame.message.payload.subscriptionId === bindB.subscriptionId &&
      frame.message.payload.state.counts?.running === 0,
    15000,
    beforeSiblingStop,
  );
  assert.equal(
    a.frames
      .slice(beforeRelease)
      .filter(
        (frame) =>
          frame.message?.type === "agent.background_jobs.update" &&
          frame.message.payload.subscriptionId === bindA.subscriptionId,
      ).length,
    0,
  );
  assert.equal(
    old.frames.filter((frame) => frame.message?.type?.startsWith("agent.background_jobs.")).length,
    0,
  );
  pass("release affects only its source; a legacy client receives no unsolicited new frames");

  const owned = [];
  for (const entry of launches) {
    if (!entry.input.env?.PASEO_BG_CAPABILITY) continue;
    const state = await entry.session.getState();
    if (state.sessionId === bindA.sessionId) owned.push(entry);
  }
  assert.equal(owned.length, 1, "Observe exactly one real runtime launch capability for agent A");
  const environment = owned[0].input.env;
  const socketPath = environment.PASEO_BG_SOCKET;
  assert.equal(Buffer.byteLength(socketPath) < 104, true);
  assert.equal((await stat(socketPath)).mode & 0o777, 0o600);
  assert.equal((await stat(path.dirname(socketPath))).mode & 0o777, 0o700);
  await rejectPrivate(socketPath, {
    kind: "attach",
    protocol: "paseo.pi-bg.v1",
    capability: "0".repeat(64),
    sessionId: bindA.sessionId,
  });
  await rejectPrivate(socketPath, {
    kind: "attach",
    protocol: "paseo.pi-bg.v1",
    capability: environment.PASEO_BG_CAPABILITY,
    sessionId: randomUUID(),
  });
  await driver.refreshAgent(agentA.id);
  const renewed = await b.wait(
    (frame) =>
      frame.message?.type === "agent.background_jobs.update" &&
      frame.message.payload.subscriptionId === bindB.subscriptionId &&
      frame.message.payload.state.status === "ready" &&
      frame.message.payload.state.runtimeId !== bindB.runtimeId,
  );
  assert.notEqual(renewed.message.payload.state.activationId, bindB.activationId);
  error(
    await b.request("agent.background_jobs.stop.request", {
      ...readAddress(bindB),
      subscriptionId: bindB.subscriptionId,
      sequence: 2,
      taskId: first.task.id,
    }),
  );
  const freshLaunch = launches.findLast((entry) => entry.input.env?.PASEO_BG_CAPABILITY);
  assert.notEqual(freshLaunch, undefined);
  assert.notEqual(freshLaunch.input.env.PASEO_BG_CAPABILITY, environment.PASEO_BG_CAPABILITY);
  await rejectPrivate(freshLaunch.input.env.PASEO_BG_SOCKET, {
    kind: "attach",
    protocol: "paseo.pi-bg.v1",
    capability: environment.PASEO_BG_CAPABILITY,
    sessionId: renewed.message.payload.state.sessionId,
  });
  const aliveB = success(
    await b.request("agent.background_jobs.detail.request", {
      ...readAddress(other),
      taskId: taskB.id,
    }),
    "detail",
  ).result;
  assert.equal(aliveB.task.task.status, "running");
  assert.equal((await readFile(trace, "utf8")).trim().split("\n").length, 4);
  pass(
    "private capability/session checks and reload revocation preserve the other live agent without prompts",
  );
} catch (issue) {
  failures.push(issue);
} finally {
  for (const peer of peers) {
    try {
      await peer.close();
    } catch (issue) {
      failures.push(issue);
    }
  }
  if (driver && projectId) {
    try {
      await driver.removeProject(projectId);
    } catch (issue) {
      failures.push(issue);
    }
  }
  if (driver) {
    try {
      await driver.close();
    } catch (issue) {
      failures.push(issue);
    }
  }
  if (daemon) {
    try {
      await daemon.daemon.stop();
      await daemon.daemon.agentManager.flush();
      await rm(daemon.staticDir, { recursive: true, force: true });
    } catch (issue) {
      failures.push(issue);
    }
  }
  try {
    await rm(root, { recursive: true, force: true });
  } catch (issue) {
    failures.push(issue);
  }
}
if (failures.length > 0) throw new AggregateError(failures, "Background jobs wire oracle failed");
console.log(`Background jobs wire acceptance: ${groups} groups passed`);
