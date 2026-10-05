#!/usr/bin/env node
// Judge-owned B1 flow: real Pi (Paseo's Pi provider, RPC process) -> isolated daemon -> real
// browser app, deterministic offline provider. Checks native same-file detours through the
// product tools branch_open/branch_return using the actual Pi JSONL tree, the actual model
// request trace, the daemon timeline API and the rendered app timeline.
import { spawn } from "node:child_process";
import {
  closeSync,
  existsSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium } from "@playwright/test";
import { connectClient, freePort, sleep, waitFor } from "../android/lib.mjs";

const repository = process.cwd();
const prerequisiteOnly = process.argv.includes("--prerequisite");
const TOOLS =
  "visual_present,visual_update,visual_act,visual_inspect,visual_list,speak,branch_open,branch_return";
const CHECKPOINT = "pi-workspace/branch-checkpoint";
const OPENED = "pi-workspace/branch-opened";
const NOTES = "pi-workspace/branch-notes";
const RETURNED = "pi-workspace/branch-returned";
const STATUS = "pi-workspace/branch-status";
const MESSAGE_TYPES = new Set(["message"]);

function fail(message) {
  throw new Error(message);
}

let passed = 0;
async function check(label, body) {
  process.stdout.write(`B1 CHECK ${label}\n`);
  try {
    const value = await body();
    passed += 1;
    process.stdout.write(`B1 PASS ${label}\n`);
    return value;
  } catch (error) {
    process.stdout.write(`B1 FAIL ${label}: ${error.stack ?? error.message}\n`);
    throw error;
  }
}

const root = await mkdtemp(path.join(tmpdir(), "paseo-b1-judge-"));
const paseoHome = path.join(root, "paseo");
const home = path.join(root, "home");
const piDir = path.join(root, "pi");
const trace = path.join(root, "model.jsonl");
const cancelMarker = path.join(root, "cancel-tree");
for (const dir of [paseoHome, home, piDir]) await mkdir(dir, { recursive: true });
process.stdout.write(`B1 evidence directory: ${root}\n`);

const port = await freePort();
const metroPort = await freePort([port]);
writeFileSync(
  path.join(paseoHome, "config.json"),
  `${JSON.stringify({
    version: 1,
    daemon: { mcp: { enabled: false } },
    agents: {
      providers: {
        claude: { enabled: false },
        codex: { enabled: false },
        copilot: { enabled: false },
        opencode: { enabled: false },
        omp: { enabled: false },
        pi: {
          enabled: true,
          env: {
            HOME: home,
            PI_CODING_AGENT_DIR: piDir,
            PI_WORKSPACE_ORACLE_TRACE: trace,
            PI_WORKSPACE_B1_CANCEL_MARKER: cancelMarker,
          },
          command: [
            "/usr/local/bin/pi",
            "--no-extensions",
            "--no-skills",
            "--no-prompt-templates",
            "--no-context-files",
            "--offline",
            "--tools",
            TOOLS,
            "-e",
            path.join(repository, "packages/pi-workspace/extensions/workspace.ts"),
            "-e",
            path.join(repository, "qa/pi-workspace/scripted-provider.mjs"),
            "-e",
            path.join(repository, "qa/pi-workspace/fixtures/b1-tree-cancel.mjs"),
          ],
        },
      },
    },
  })}\n`,
);

let daemonChild = null;
async function startDaemon() {
  const log = openSync(path.join(root, "daemon.log"), "a");
  daemonChild = spawn(
    process.execPath,
    [
      path.join(repository, "node_modules/tsx/dist/cli.mjs"),
      "scripts/supervisor-entrypoint.ts",
      "--dev",
    ],
    {
      cwd: path.join(repository, "packages/server"),
      env: {
        PATH: process.env.PATH ?? "",
        HOME: home,
        TMPDIR: process.env.TMPDIR ?? tmpdir(),
        LANG: "en_US.UTF-8",
        PI_OFFLINE: "1",
        PI_TELEMETRY: "0",
        PI_SKIP_VERSION_CHECK: "1",
        PASEO_HOME: paseoHome,
        PASEO_SERVER_ID: `srv_b1_judge_${port}`,
        PASEO_LISTEN: `127.0.0.1:${port}`,
        PASEO_CORS_ORIGINS: `http://localhost:${metroPort}`,
        PASEO_RELAY_ENABLED: "0",
        PASEO_DICTATION_ENABLED: "0",
        PASEO_VOICE_MODE_ENABLED: "0",
        PASEO_LOCAL_SPEECH_AUTO_DOWNLOAD: "0",
        PASEO_NODE_ENV: "development",
        NODE_ENV: "development",
      },
      stdio: ["ignore", log, log],
    },
  );
  closeSync(log);
  return waitFor(
    "isolated daemon",
    async () => {
      if (daemonChild.exitCode !== null) fail("daemon exited during start");
      const response = await fetch(`http://127.0.0.1:${port}/api/status`);
      return response.ok ? response.json() : null;
    },
    { timeout: 90_000, interval: 1000 },
  );
}
async function stopDaemon() {
  if (!daemonChild || daemonChild.exitCode !== null) return;
  daemonChild.kill("SIGTERM");
  await Promise.race([new Promise((resolve) => daemonChild.once("exit", resolve)), sleep(15_000)]);
  if (daemonChild.exitCode === null) daemonChild.kill("SIGKILL");
}

// ---- Pi JSONL and trace observation (independent of product claims) ----
function sessionFile(cwd, expectedCwd) {
  const sessionRoot = path.join(piDir, "sessions");
  const matches = [];
  for (const relative of readdirSync(sessionRoot, { recursive: true })) {
    if (!String(relative).endsWith(".jsonl")) continue;
    const file = path.join(sessionRoot, String(relative));
    const header = JSON.parse(readFileSync(file, "utf8").split("\n")[0] ?? "null");
    if (header?.type === "session" && (header.cwd === cwd || header.cwd === expectedCwd))
      matches.push(file);
  }
  if (matches.length !== 1) fail(`expected exactly one Pi session file, found ${matches.length}`);
  return matches[0];
}
function readEntries(file) {
  const lines = readFileSync(file, "utf8").trim().split("\n");
  return { header: JSON.parse(lines[0]), entries: lines.slice(1).map((line) => JSON.parse(line)) };
}
function activeBranch(entries) {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const chain = [];
  let cursor = entries.at(-1);
  while (cursor) {
    chain.unshift(cursor);
    cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined;
  }
  return chain;
}
function activeBranchTo(entries, id) {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const chain = [];
  let cursor = byId.get(id);
  while (cursor) {
    chain.unshift(cursor);
    cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined;
  }
  return chain;
}
function contentText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => (part?.type === "text" ? part.text : "")).join("\n");
}
function entryText(entry) {
  if (entry.type === "message") return contentText(entry.message?.content);
  if (entry.type === "custom_message") return contentText(entry.content);
  return "";
}
function branchText(entries) {
  return activeBranch(entries).map(entryText).join("\n");
}
function requests() {
  if (!existsSync(trace)) return [];
  return readFileSync(trace, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}
function requestContext(request) {
  return request.messages.map((message) => contentText(message.content)).join("\n");
}

const cleanups = [];
let exitCode = 1;
try {
  const status = await startDaemon();
  cleanups.push(stopDaemon);
  let client = await connectClient(port);
  cleanups.push(() => client.close());
  const cwd = await mkdtemp(path.join(tmpdir(), "paseo-b1-project-"));
  const expectedCwd = await realpath(cwd);
  cleanups.push(() => rm(cwd, { recursive: true, force: true }));
  const created = await client.createWorkspace({
    source: { kind: "directory", path: cwd },
    title: "B1 judge",
  });
  if (!created.workspace) fail(created.error ?? "workspace creation failed");
  const agent = await client.createAgent({
    provider: "pi",
    model: "pi-workspace-oracle/scripted",
    thinkingOptionId: "off",
    cwd,
    workspaceId: created.workspace.id,
    title: "B1 detours",
  });

  async function send(text) {
    await client.sendAgentMessage(agent.id, text);
    const finish = await client.waitForFinish(agent.id, 60_000);
    if (finish.status !== "idle")
      fail(`agent finished ${finish.status} after ${text.slice(0, 60)}`);
  }
  function lastToolResults(count) {
    const { entries } = readEntries(sessionFile(cwd, expectedCwd));
    return entries
      .filter((entry) => entry.type === "message" && entry.message?.role === "toolResult")
      .slice(-count)
      .map((entry) => entry.message);
  }
  async function call(name, args) {
    await send(`oracle-call:${JSON.stringify({ name, arguments: args })}`);
    const [result] = lastToolResults(1);
    if (!result || result.toolName !== name) fail(`${name}: no persisted tool result`);
    return result;
  }
  function errorCode(result) {
    const code = result.details?.error?.code;
    if (!result.isError || typeof code !== "string")
      fail(`expected structured error, got ${JSON.stringify(result.details)}`);
    return code;
  }
  function entriesNow() {
    return readEntries(sessionFile(cwd, expectedCwd)).entries;
  }
  async function waitForEntry(label, predicate, timeout = 30_000) {
    return waitFor(label, () => entriesNow().find(predicate) ?? null, { timeout, interval: 500 });
  }
  async function openDetour(title, purpose) {
    const before = entriesNow().filter((entry) => entry.customType === CHECKPOINT).length;
    const result = await call("branch_open", purpose ? { title, purpose } : { title });
    if (result.isError) fail(`branch_open failed: ${JSON.stringify(result.details)}`);
    await waitFor(
      `checkpoint for ${title}`,
      () => entriesNow().filter((entry) => entry.customType === CHECKPOINT).length === before + 1,
      { timeout: 30_000, interval: 500 },
    );
    const all = entriesNow();
    const checkpoint = all.findLast((entry) => entry.customType === CHECKPOINT);
    const previous = all[all.indexOf(checkpoint) - 1];
    if (!previous || checkpoint.parentId !== previous.id)
      fail("checkpoint must be appended at the current leaf");
    const ancestry = activeBranchTo(all, checkpoint.id);
    if (
      !ancestry.some(
        (entry) =>
          entry.message?.role === "toolResult" && entry.message?.toolName === "branch_open",
      )
    ) {
      fail("checkpoint must follow the branch_open call on the same branch");
    }
    const opened = await waitForEntry(
      `opened marker for ${title}`,
      (entry) => entry.customType === OPENED && entry.parentId === checkpoint.id,
    );
    if (checkpoint.type !== "custom") fail("checkpoint must be a non-message custom entry");
    if (opened.type !== "custom_message" || !entryText(opened).includes(title))
      fail("opened marker lacks the title");
    return { checkpoint, opened };
  }
  async function returnDetour(notes, artifacts) {
    const returnedBefore = entriesNow().filter((entry) => entry.customType === RETURNED).length;
    const result = await call("branch_return", artifacts ? { notes, artifacts } : { notes });
    if (result.isError) fail(`branch_return failed: ${JSON.stringify(result.details)}`);
    await waitFor(
      "returned marker",
      () =>
        entriesNow().filter((entry) => entry.customType === RETURNED).length === returnedBefore + 1,
      { timeout: 30_000, interval: 500 },
    );
    return result;
  }

  const browser = await chromium.launch({ channel: "chrome", headless: true });
  cleanups.push(() => browser.close());
  const metroLog = openSync(path.join(root, "metro.log"), "w");
  const metro = spawn(
    process.execPath,
    [
      path.join(repository, "node_modules/expo/bin/cli"),
      "start",
      "--web",
      "--port",
      String(metroPort),
      "--offline",
    ],
    {
      cwd: path.join(repository, "packages/app"),
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        TMPDIR: process.env.TMPDIR ?? "",
        CI: "1",
        BROWSER: "none",
        EXPO_NO_DOTENV: "1",
        EXPO_PUBLIC_LOCAL_DAEMON: "127.0.0.1:9",
      },
      stdio: ["ignore", metroLog, metroLog],
    },
  );
  closeSync(metroLog);
  cleanups.push(async () => metro.kill("SIGTERM"));
  await waitFor("Metro", async () => (await fetch(`http://127.0.0.1:${metroPort}/status`)).ok, {
    timeout: 120_000,
    interval: 1000,
  });
  const { warmMetro } = await import(
    path.join(repository, "packages/app/e2e/support/metro-warmup.mjs")
  );
  await warmMetro(metroPort);
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.route(/:(6767|6768)\b/, (route) => route.abort());
  await page.goto(`http://localhost:${metroPort}/`);
  const now = new Date().toISOString();
  const host = {
    serverId: status.serverId,
    label: "localhost",
    connections: [
      { id: `direct:127.0.0.1:${port}`, type: "directTcp", endpoint: `127.0.0.1:${port}` },
    ],
    preferredConnectionId: `direct:127.0.0.1:${port}`,
    createdAt: now,
    updatedAt: now,
  };
  await page.evaluate((entry) => {
    localStorage.setItem("@paseo:e2e", "1");
    localStorage.setItem("@paseo:daemon-registry", JSON.stringify([entry]));
    localStorage.removeItem("@paseo:settings");
  }, host);
  const agentUrl = `http://localhost:${metroPort}/h/${encodeURIComponent(status.serverId)}/agent/${encodeURIComponent(agent.id)}`;
  await page.goto(agentUrl);
  await page.getByTestId("message-input-root").waitFor({ timeout: 90_000 });
  const pageText = () => page.evaluate(() => document.body.innerText);

  await check(
    "prerequisite: Paseo Pi agent, JSONL, trace and timeline are observable",
    async () => {
      await send("oracle-text:MAIN_BEFORE_DETOUR");
      if (!branchText(entriesNow()).includes("MAIN_BEFORE_DETOUR"))
        fail("main message missing from the Pi branch");
      if (requests().length !== 1) fail(`expected 1 model request, saw ${requests().length}`);
      const timeline = JSON.stringify(await client.fetchAgentTimeline(agent.id));
      if (!timeline.includes("MAIN_BEFORE_DETOUR")) fail("daemon timeline lacks the main message");
      await waitFor(
        "rendered main message",
        async () => (await pageText()).includes("MAIN_BEFORE_DETOUR"),
        { timeout: 30_000 },
      );
    },
  );

  if (prerequisiteOnly) {
    exitCode = 0;
  } else {
    const header = readEntries(sessionFile(cwd, expectedCwd)).header;

    await check(
      "branch tools are sole calls: a mixed batch refuses only the branch tool",
      async () => {
        const before = entriesNow().length;
        await send(
          `oracle-batch:${JSON.stringify([
            { name: "branch_open", arguments: { title: "Mixed" } },
            { name: "visual_list", arguments: {} },
          ])}`,
        );
        const results = lastToolResults(2);
        const branch = results.find((result) => result.toolName === "branch_open");
        const list = results.find((result) => result.toolName === "visual_list");
        if (!branch || !list) fail("mixed batch results missing");
        if (errorCode(branch) !== "BRANCH_REQUIRES_SOLE_CALL")
          fail(`mixed batch code ${errorCode(branch)}`);
        if (list.isError) fail("the sibling tool must run normally");
        await sleep(3000);
        if (
          entriesNow()
            .slice(before)
            .some((entry) => [CHECKPOINT, OPENED].includes(entry.customType))
        ) {
          fail("a refused branch call must not open a detour");
        }
      },
    );

    let visualId = null;
    const main = await check(
      "open: same file, checkpoint at the leaf, visible marker, no extra model request",
      async () => {
        const presented = await call("visual_present", {
          mode: "new",
          title: "Detour survivor",
          html: "<!doctype html><title>Detour survivor</title><p>survives</p>",
        });
        if (presented.isError) fail(`visual_present failed: ${JSON.stringify(presented.details)}`);
        visualId = presented.details.id;
        const requestsBefore = requests().length;
        const lastBefore = entriesNow().at(-1);
        const opened = await openDetour("Side question");
        if (requests().length !== requestsBefore + 1)
          fail("branch_open must not cause a follow-up model request");
        if (lastBefore.id === opened.checkpoint.id) fail("checkpoint was not appended");
        const current = readEntries(sessionFile(cwd, expectedCwd)).header;
        if (current.id !== header.id) fail("session identity changed");
        return opened;
      },
    );

    const detourArtifact = await check(
      "detour inherits context; work happens on the detour branch",
      async () => {
        await send("oracle-text:DETOUR_SECRET_ALPHA");
        const context = requestContext(requests().at(-1));
        if (!context.includes("MAIN_BEFORE_DETOUR")) fail("detour lost the main context");
        if (!context.includes("Side question")) fail("detour request lacks the visible marker");
        const detourVisual = await call("visual_present", {
          mode: "new",
          title: "Detour artifact",
          html: "<!doctype html><title>Detour artifact</title><p>made in detour</p>",
        });
        if (detourVisual.isError) fail("visual_present in detour failed");
        return detourVisual.details.id;
      },
    );

    await check(
      "return: native navigation, supplied notes only, detour kept, timeline replaced",
      async () => {
        const requestsBefore = requests().length;
        await returnDetour("SELECTED_NOTE_BETA", [detourArtifact]);
        if (requests().length !== requestsBefore + 1)
          fail("branch_return must not call a summary model");
        const entries = entriesNow();
        const branch = activeBranch(entries);
        const notes = branch.filter((entry) => entry.customType === NOTES);
        if (notes.length !== 1)
          fail(`expected one notes message on the main branch, found ${notes.length}`);
        const checkpointIndex = branch.findIndex((entry) => entry.id === main.checkpoint.id);
        const notesIndex = branch.findIndex((entry) => entry.id === notes[0].id);
        if (checkpointIndex < 0 || notesIndex < checkpointIndex)
          fail("notes must follow the stored checkpoint on the main branch");
        if (
          branch
            .slice(checkpointIndex + 1, notesIndex)
            .some((entry) => MESSAGE_TYPES.has(entry.type) || entry.customType === OPENED)
        ) {
          fail("only bookkeeping entries may sit between the checkpoint and the notes");
        }
        const noteText = entryText(notes[0]);
        if (!noteText.includes("SELECTED_NOTE_BETA") || !noteText.includes(detourArtifact))
          fail("notes lack supplied text/artifact");
        if (noteText.includes("DETOUR_SECRET_ALPHA")) fail("notes contain detour transcript");
        if (branchText(entries).includes("DETOUR_SECRET_ALPHA"))
          fail("detour content is still on the active branch");
        if (!JSON.stringify(entries).includes("DETOUR_SECRET_ALPHA"))
          fail("the detour must remain recoverable in the file");
        await send("oracle-text:MAIN_AFTER_RETURN");
        const context = requestContext(requests().at(-1));
        for (const needle of ["MAIN_BEFORE_DETOUR", "SELECTED_NOTE_BETA", detourArtifact]) {
          if (!context.includes(needle)) fail(`resumed context lacks ${needle}`);
        }
        if (context.includes("DETOUR_SECRET_ALPHA"))
          fail("resumed context contains detour content");
        const listed = await call("visual_list", {});
        if (!JSON.stringify(listed.details).includes(detourArtifact))
          fail("detour artifact not listable after return");
        const timeline = JSON.stringify(await client.fetchAgentTimeline(agent.id));
        if (timeline.includes("DETOUR_SECRET_ALPHA"))
          fail("daemon timeline still shows detour content");
        if (!timeline.includes("SELECTED_NOTE_BETA")) fail("daemon timeline lacks the notes");
        await waitFor(
          "rendered timeline replaced",
          async () => {
            const text = await pageText();
            return (
              text.includes("SELECTED_NOTE_BETA") &&
              text.includes("MAIN_AFTER_RETURN") &&
              !text.includes("DETOUR_SECRET_ALPHA")
            );
          },
          { timeout: 30_000 },
        );
        await page.reload();
        await page.getByTestId("message-input-root").waitFor({ timeout: 90_000 });
        await waitFor(
          "rendered timeline after reload",
          async () => {
            const text = await pageText();
            return text.includes("SELECTED_NOTE_BETA") && !text.includes("DETOUR_SECRET_ALPHA");
          },
          { timeout: 30_000 },
        );
      },
    );

    await check(
      "visual survives open/return; repeated return refused without duplication",
      async () => {
        const live = await call("visual_inspect", {});
        if (live.isError)
          fail(
            `the displayed visual stopped working after return: ${JSON.stringify(live.details)}`,
          );
        const reopened = await call("visual_present", { mode: "open", id: visualId });
        if (reopened.isError || reopened.details?.status !== "rendered")
          fail("pre-detour visual not reopenable after return");
        const again = await call("branch_return", { notes: "SELECTED_NOTE_BETA" });
        if (errorCode(again) !== "NO_ACTIVE_DETOUR") fail(`second return code ${errorCode(again)}`);
        await sleep(2000);
        const notes = entriesNow().filter(
          (entry) => entry.customType === NOTES && entryText(entry).includes("SELECTED_NOTE_BETA"),
        );
        if (notes.length !== 1) fail(`notes duplicated: ${notes.length}`);
      },
    );

    await check("nested detours return one level at a time", async () => {
      await openDetour("Level one");
      await send("oracle-text:L1_CONTENT");
      await openDetour("Level two");
      await send("oracle-text:L2_CONTENT");
      await returnDetour("NOTE_FROM_L2");
      await send("oracle-text:BACK_IN_L1");
      let context = requestContext(requests().at(-1));
      if (!context.includes("L1_CONTENT") || !context.includes("NOTE_FROM_L2"))
        fail("level-one context lost after inner return");
      if (context.includes("L2_CONTENT")) fail("inner detour content leaked into level one");
      await returnDetour("NOTE_FROM_L1");
      await send("oracle-text:BACK_ON_MAIN");
      context = requestContext(requests().at(-1));
      if (!context.includes("NOTE_FROM_L1") || !context.includes("MAIN_AFTER_RETURN"))
        fail("main context lost after outer return");
      for (const leaked of ["L1_CONTENT", "L2_CONTENT", "NOTE_FROM_L2", "BACK_IN_L1"]) {
        if (context.includes(leaked)) fail(`${leaked} leaked into main`);
      }
    });

    await check(
      "input sent right after the call settles is delivered once, after the transition",
      async () => {
        await client.sendAgentMessage(
          agent.id,
          `oracle-call:${JSON.stringify({ name: "branch_open", arguments: { title: "Queued" } })}`,
        );
        const first = await client.waitForFinish(agent.id, 60_000);
        if (first.status !== "idle") fail(`agent finished ${first.status}`);
        await client.sendAgentMessage(agent.id, "oracle-text:QUEUED_GAMMA");
        await waitFor(
          "queued message answered",
          () => requests().some((request) => requestContext(request).includes("QUEUED_GAMMA")),
          { timeout: 60_000, interval: 1000 },
        );
        const finish = await client.waitForFinish(agent.id, 60_000);
        if (finish.status !== "idle") fail(`agent finished ${finish.status}`);
        await sleep(2000);
        const entries = entriesNow();
        const users = entries.filter(
          (entry) =>
            entry.type === "message" &&
            entry.message?.role === "user" &&
            entryText(entry).includes("QUEUED_GAMMA"),
        );
        if (users.length !== 1) fail(`queued input delivered ${users.length} times`);
        const branch = activeBranch(entries);
        const openedIndex = branch.findIndex(
          (entry) => entry.customType === OPENED && entryText(entry).includes("Queued"),
        );
        const queuedIndex = branch.findIndex((entry) => entry.id === users[0].id);
        if (openedIndex < 0 || queuedIndex < openedIndex)
          fail("input raced ahead of the detour transition");
        await returnDetour("NOTE_QUEUED");
      },
    );

    await check("a detour survives a daemon and Pi restart", async () => {
      await openDetour("Across restart");
      await send("oracle-text:BEFORE_RESTART_DETOUR");
      await client.close();
      await stopDaemon();
      await startDaemon();
      client = await connectClient(port);
      await returnDetour("NOTE_AFTER_RESTART");
      await send("oracle-text:AFTER_RESTART_MAIN");
      const context = requestContext(requests().at(-1));
      if (!context.includes("NOTE_AFTER_RESTART")) fail("notes missing after restart return");
      if (context.includes("BEFORE_RESTART_DETOUR"))
        fail("detour content leaked after restart return");
    });

    await check(
      "cancelled navigation: BRANCH_CANCELLED status and unchanged position",
      async () => {
        await openDetour("Cancellable");
        writeFileSync(cancelMarker, "cancel");
        const notesBefore = entriesNow().filter((entry) => entry.customType === NOTES).length;
        const queued = await call("branch_return", { notes: "NOTE_SHOULD_NOT_APPEAR" });
        if (queued.isError)
          fail(`branch_return refused before navigation: ${JSON.stringify(queued.details)}`);
        const statusEntry = await waitForEntry(
          "cancellation status",
          (entry) => entry.customType === STATUS && entryText(entry).includes("BRANCH_CANCELLED"),
        );
        if (statusEntry.type !== "custom_message")
          fail("the cancellation status must be a visible message");
        await sleep(2000);
        const entries = entriesNow();
        if (entries.filter((entry) => entry.customType === NOTES).length !== notesBefore)
          fail("cancelled return appended notes");
        if (
          JSON.stringify(entries).includes("NOTE_SHOULD_NOT_APPEAR") &&
          entries.some(
            (entry) =>
              entry.customType === NOTES && entryText(entry).includes("NOTE_SHOULD_NOT_APPEAR"),
          )
        ) {
          fail("cancelled notes were recorded");
        }
        if (
          !activeBranch(entries).some(
            (entry) => entry.customType === OPENED && entryText(entry).includes("Cancellable"),
          )
        ) {
          fail("position moved despite cancellation");
        }
        rmSync(cancelMarker, { force: true });
        await returnDetour("NOTE_AFTER_CANCEL");
        const final = readEntries(sessionFile(cwd, expectedCwd)).header;
        if (final.id !== header.id) fail("session identity changed across the run");
      },
    );
    exitCode = 0;
  }
} catch (error) {
  process.stdout.write(`B1 flow stopped: ${error.message}\n`);
} finally {
  for (const cleanup of cleanups.toReversed()) {
    try {
      await cleanup();
    } catch (error) {
      process.stdout.write(`cleanup warning: ${error.message}\n`);
    }
  }
  process.stdout.write(`B1 checks passed: ${passed}. Evidence: ${root}\n`);
  process.exitCode = exitCode;
}
