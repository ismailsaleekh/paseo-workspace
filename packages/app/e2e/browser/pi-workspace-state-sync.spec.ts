// Judge-owned VS1 Root oracle: visual state synchronization keeps every edit. Implementation workers
// must not modify this file. It drives the real app in installed Chrome against the real daemon and
// actual Pi (deterministic scripted model). Daemon-to-app latency is added by the oracle itself, on
// the page's own WebSocket route; product code has no test hook.
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FrameLocator, Locator, Page, WebSocketRoute } from "@playwright/test";
import { z } from "zod";
import { test as base, expect } from "../support/fixtures";
import { daemonWsRoutePattern } from "../support/helpers/daemon-port";
import type { SeedDaemonClient } from "../support/helpers/seed-client";

const repository = path.resolve(__dirname, "../../../..");
// One-way delay on every daemon-to-app message of the typing display. Phones over a network see
// 100-500 ms; keys arrive every 40 ms, so many publications are in flight at once.
const LATENCY_MS = 500;
const KEY_DELAY_MS = 40;
// After the last key: room for several complete publish/acknowledge cycles at LATENCY_MS, then a
// second observation proves the result is stable rather than a passing transient.
const SETTLE_MS = 8_000;
const RECHECK_MS = 2_000;

interface OracleHome {
  root: string;
  agentDir: string;
  trace: string;
}
interface OracleFixtures {
  readPiResults(cwd: string): Promise<StoredResult[]>;
}
const test = base.extend<OracleFixtures, { piOracleHome: OracleHome }>({
  readPiResults: async ({ piOracleHome }, provide) => {
    await provide((cwd) => readResults(piOracleHome.agentDir, cwd));
  },
  piOracleHome: [
    async ({ browserName }, provide) => {
      const root = await mkdtemp(path.join(tmpdir(), `paseo-vs1-${browserName}-oracle-`));
      const agentDir = path.join(root, "pi");
      await mkdir(agentDir);
      try {
        await provide({ root, agentDir, trace: path.join(root, "model.jsonl") });
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
    { scope: "worker" },
  ],
  e2eDaemonEnvironment: [
    async ({ piOracleHome }, provide) => {
      await provide({
        HOME: piOracleHome.root,
        PI_CODING_AGENT_DIR: piOracleHome.agentDir,
        PI_WORKSPACE_ORACLE_TRACE: piOracleHome.trace,
        PI_OFFLINE: "1",
        PI_TELEMETRY: "0",
        PI_SKIP_VERSION_CHECK: "1",
        PASEO_DICTATION_ENABLED: "0",
        PASEO_VOICE_MODE_ENABLED: "0",
      });
    },
    { scope: "worker" },
  ],
  e2eDaemonConfig: [
    async ({ piOracleHome }, provide) => {
      await provide({
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
                HOME: piOracleHome.root,
                PI_CODING_AGENT_DIR: piOracleHome.agentDir,
                PI_WORKSPACE_ORACLE_TRACE: piOracleHome.trace,
              },
              command: [
                "/usr/local/bin/pi",
                "--no-extensions",
                "--no-skills",
                "--no-prompt-templates",
                "--no-context-files",
                "--offline",
                "--tools",
                "visual_present,visual_update,visual_act,visual_inspect,visual_list,speak,branch_open,branch_return",
                "-e",
                path.join(repository, "packages/pi-workspace/extensions/workspace.ts"),
                "-e",
                path.join(repository, "qa/pi-workspace/scripted-provider.mjs"),
              ],
            },
          },
        },
      });
    },
    { scope: "worker" },
  ],
});
test.use({
  e2eForkProviders: [],
  e2eInjectPaseoTools: false,
  channel: "chrome",
  video: "off",
});

const envelopeSchema = z.object({ type: z.string(), message: z.unknown().optional() });
const roleSchema = z.object({ role: z.string() });
const resultSchema = z.object({
  role: z.literal("toolResult"),
  toolName: z.string(),
  isError: z.boolean(),
  details: z.unknown(),
});
type StoredResult = z.infer<typeof resultSchema>;
type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

async function readResults(agentDir: string, cwd: string): Promise<StoredResult[]> {
  const sessionRoot = path.join(agentDir, "sessions");
  const relativePaths = await readdir(sessionRoot, { recursive: true });
  const expectedCwd = await realpath(cwd);
  const matches: string[][] = [];
  for (const relative of relativePaths) {
    if (!relative.endsWith(".jsonl")) continue;
    const lines = (await readFile(path.join(sessionRoot, relative), "utf8")).trim().split("\n");
    const header: unknown = JSON.parse(lines[0] ?? "null");
    const identity = z.object({ type: z.literal("session"), cwd: z.string() }).parse(header);
    if (identity.cwd === cwd || identity.cwd === expectedCwd) matches.push(lines.slice(1));
  }
  expect(matches).toHaveLength(1);
  const lines = matches[0];
  if (!lines) throw new Error("The isolated Pi session was not found");
  const results: StoredResult[] = [];
  for (const line of lines) {
    const parsed: unknown = JSON.parse(line);
    const entry = envelopeSchema.parse(parsed);
    if (entry.type !== "message") continue;
    if (roleSchema.parse(entry.message).role !== "toolResult") continue;
    results.push(resultSchema.parse(entry.message));
  }
  return results;
}

const artifactSchema = z.object({
  id: z.string().min(1),
  revision: z.number().int().positive(),
  status: z.literal("rendered"),
});
const inspectionSchema = z.object({
  id: z.string(),
  state: z.object({ text: z.string(), number: z.string(), notes: z.string() }),
});

/** Delays every daemon-to-app message of one page by LATENCY_MS, preserving their order. */
async function addDaemonLatency(page: Page): Promise<void> {
  await page.routeWebSocket(daemonWsRoutePattern(), (ws: WebSocketRoute) => {
    const server = ws.connectToServer();
    let open = true;
    ws.onMessage((message) => {
      server.send(message);
    });
    server.onMessage((message) => {
      setTimeout(() => {
        if (open) ws.send(message);
      }, LATENCY_MS);
    });
    ws.onClose(() => {
      open = false;
      void server.close();
    });
    server.onClose(() => {
      // Messages already in flight are delivered first, as on a slow link.
      setTimeout(() => {
        open = false;
        void ws.close();
      }, LATENCY_MS);
    });
  });
}

/** A passive second display in the same browser context; it can never reach a real daemon. */
async function openSecondDisplay(page: Page, url: string): Promise<Page> {
  const second = await page.context().newPage();
  await second.route(/:(6767)\b/, (route) => route.abort());
  await second.routeWebSocket(/:(6767)\b/, (ws) => {
    void ws.close();
  });
  await second.goto(url);
  await expect(second.getByTestId("message-input-root")).toBeVisible();
  return second;
}

interface Session {
  url: string;
  present(): Promise<string>;
  inspect(id: string): Promise<z.infer<typeof inspectionSchema>>;
  close(): Promise<void>;
}

async function openSession(
  client: SeedDaemonClient,
  read: OracleFixtures["readPiResults"],
  title: string,
): Promise<Session> {
  const cwd = await mkdtemp(path.join(tmpdir(), "paseo-vs1-project-"));
  const created = await client.createWorkspace({
    source: { kind: "directory", path: cwd },
    title,
  });
  if (!created.workspace) throw new Error(created.error ?? "Workspace creation failed");
  const workspace = created.workspace;
  const agent = await client.createAgent({
    provider: "pi",
    model: "pi-workspace-oracle/scripted",
    thinkingOptionId: "off",
    cwd,
    workspaceId: workspace.id,
    title,
  });
  const serverId = process.env.E2E_SERVER_ID;
  if (!serverId) throw new Error("The isolated server ID is missing");
  let count = 0;
  const call = async (name: string, args: { [key: string]: JsonValue }): Promise<unknown> => {
    await client.sendAgentMessage(
      agent.id,
      `oracle-call:${JSON.stringify({ name, arguments: args })}`,
    );
    const finish = await client.waitForFinish(agent.id, 60_000);
    expect(finish.status).toBe("idle");
    const results = await read(cwd);
    expect(results).toHaveLength(++count);
    const result = results.at(-1);
    if (!result) throw new Error("No actual Pi tool result was persisted");
    expect(result.toolName).toBe(name);
    expect(result.isError, JSON.stringify(result.details)).toBe(false);
    return result.details;
  };
  return {
    url: `/h/${encodeURIComponent(serverId)}/agent/${encodeURIComponent(agent.id)}`,
    async present() {
      const file = path.join(cwd, "fields.html");
      await writeFile(
        file,
        await readFile(path.join(repository, "qa/pi-workspace/fixtures/ime.html"), "utf8"),
        "utf8",
      );
      const shown = artifactSchema.parse(
        await call("visual_present", { mode: "new", title: "State sync witness", file }),
      );
      return shown.id;
    },
    async inspect(id) {
      return inspectionSchema.parse(await call("visual_inspect", { id }));
    },
    async close() {
      await client.archiveAgent(agent.id);
      await client.removeProject(workspace.projectId);
      await rm(cwd, { recursive: true, force: true });
    },
  };
}

function visualOf(page: Page): FrameLocator {
  return page.frameLocator('[data-testid="pi-workspace-document"]');
}

interface Observation {
  stored: string;
  displays: string[];
}

/** Waits past every in-flight cycle, then requires two identical observations. */
async function settled(
  session: Session,
  id: string,
  fields: Locator[],
  page: Page,
): Promise<Observation> {
  const observe = async (): Promise<Observation> => ({
    stored: (await session.inspect(id)).state.text,
    displays: await Promise.all(fields.map((field) => field.inputValue())),
  });
  await page.waitForTimeout(SETTLE_MS);
  const first = await observe();
  await page.waitForTimeout(RECHECK_MS);
  const second = await observe();
  expect(second, "the visual state kept changing after typing stopped").toEqual(first);
  return second;
}

test("edits typed faster than the daemon round trip all reach the stored visual state", async ({
  page,
  e2eWorkerClient,
  readPiResults,
}) => {
  test.setTimeout(300_000);
  await addDaemonLatency(page);
  const session = await openSession(e2eWorkerClient, readPiResults, "State sync oracle");
  try {
    await page.goto(session.url);
    await expect(page.getByTestId("message-input-root")).toBeVisible();
    const id = await session.present();
    const field = visualOf(page).locator("#text");
    await expect(field).toBeVisible();
    await expect(field).toHaveValue("");

    await field.click();
    await field.pressSequentially("Hello worr", { delay: KEY_DELAY_MS });
    await field.press("Backspace");
    await field.pressSequentially("ld", { delay: KEY_DELAY_MS });
    expect(await settled(session, id, [field], page)).toEqual({
      stored: "Hello world",
      displays: ["Hello world"],
    });

    await field.press("End");
    await field.pressSequentially(" again and again", { delay: KEY_DELAY_MS });
    expect(await settled(session, id, [field], page)).toEqual({
      stored: "Hello world again and again",
      displays: ["Hello world again and again"],
    });

    await field.press("ControlOrMeta+A");
    await field.pressSequentially("Every key counts", { delay: KEY_DELAY_MS });
    await field.press("Backspace");
    await field.press("Backspace");
    await field.pressSequentially("ts!", { delay: KEY_DELAY_MS });
    expect(await settled(session, id, [field], page)).toEqual({
      stored: "Every key counts!",
      displays: ["Every key counts!"],
    });
  } finally {
    await session.close();
  }
});

test("a second display converges to every edit of a slow typing display", async ({
  page,
  e2eWorkerClient,
  readPiResults,
}) => {
  test.setTimeout(300_000);
  await addDaemonLatency(page);
  const session = await openSession(e2eWorkerClient, readPiResults, "State sync displays");
  let second: Page | null = null;
  try {
    await page.goto(session.url);
    await expect(page.getByTestId("message-input-root")).toBeVisible();
    second = await openSecondDisplay(page, session.url);
    const id = await session.present();
    const typing = visualOf(page).locator("#text");
    const watching = visualOf(second).locator("#text");
    await expect(typing).toBeVisible();
    await expect(watching).toBeVisible();

    await typing.click();
    await typing.pressSequentially("Shared across displays", { delay: KEY_DELAY_MS });
    expect(await settled(session, id, [typing, watching], page)).toEqual({
      stored: "Shared across displays",
      displays: ["Shared across displays", "Shared across displays"],
    });
  } finally {
    if (second) await second.close();
    await session.close();
  }
});

test("concurrent edits on two displays converge to one stored state", async ({
  page,
  e2eWorkerClient,
  readPiResults,
}) => {
  test.setTimeout(300_000);
  await addDaemonLatency(page);
  const session = await openSession(e2eWorkerClient, readPiResults, "State sync conflict");
  let second: Page | null = null;
  try {
    await page.goto(session.url);
    await expect(page.getByTestId("message-input-root")).toBeVisible();
    second = await openSecondDisplay(page, session.url);
    const id = await session.present();
    const slow = visualOf(page).locator("#text");
    const fast = visualOf(second).locator("#text");
    await expect(slow).toBeVisible();
    await expect(fast).toBeVisible();

    await slow.click();
    await fast.click();
    await Promise.all([
      slow.pressSequentially("slow side typing", { delay: KEY_DELAY_MS }),
      fast.pressSequentially("FAST SIDE TYPING", { delay: KEY_DELAY_MS }),
    ]);
    const outcome = await settled(session, id, [slow, fast], page);
    // Which writer wins a conflict is not prescribed; silent divergence is a failure.
    expect(outcome.displays, "displays diverged from each other").toEqual([
      outcome.stored,
      outcome.stored,
    ]);
    expect(outcome.stored.length).toBeGreaterThan(0);
  } finally {
    if (second) await second.close();
    await session.close();
  }
});
