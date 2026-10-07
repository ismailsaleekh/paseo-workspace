// Judge-owned VS2 Root oracle: visual state synchronization on the desktop app keeps every edit,
// across windows and with an agent action arriving during typing.
// Implementation workers must not modify this file. It drives actual Pi -> isolated daemon ->
// actual Electron 44 running the unmodified checkout desktop main and the Electron-flavored app
// bundle; each window displays the visual in its own isolated guest. Daemon-to-app latency is added
// by the oracle itself on the typing window's own WebSocket route; product code has no test hook.
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import {
  _electron as electron,
  type ElectronApplication,
  type Locator,
  type Page,
  type WebSocketRoute,
} from "@playwright/test";
import { z } from "zod";
import { test as base, expect } from "../support/fixtures";
import { buildCreateAgentPreferences, buildSeededHost } from "../support/helpers/daemon-registry";
import { daemonWsRoutePattern, getE2EDaemonPort } from "../support/helpers/daemon-port";
import type { SeedDaemonClient } from "../support/helpers/seed-client";

const repository = path.resolve(__dirname, "../../../..");
const electronBinary = path.join(
  repository,
  "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron",
);
const desktopMain = path.join(repository, "packages/desktop/dist/main.js");
const entryWrapper = path.join(repository, "qa/pi-workspace/electron-quiet.cjs");
const productionHome = path.join(homedir(), ".paseo");
// The fixtures' own document titles; they identify the guest that displays each one.
const FIELDS_TITLE = "Keyboard witness"; // qa/pi-workspace/fixtures/ime.html
const ACTION_TITLE = "State and action witness"; // qa/pi-workspace/fixtures/state-sync-action.html
// The VS1 browser oracle's parameters: a slow link on the typing window and a key every 40 ms, so
// many publications are in flight at once.
const LATENCY_MS = 500;
const KEY_DELAY_MS = 40;
// After the last key: room for several complete publish/acknowledge cycles at LATENCY_MS, then a
// second observation proves the result is stable rather than a passing transient.
const SETTLE_MS = 8_000;
const RECHECK_MS = 2_000;
// The agent acts shortly after typing starts; typing continues until the action has completed and
// for KEYS_AFTER_ACTION more keys, so the action always overlaps typing (bounded by MAX_KEYS).
const ACTION_AFTER_MS = 600;
const KEYS_AFTER_ACTION = 20;
const MAX_KEYS = 600;
const PHRASE = "every key counts while the agent acts ";

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
      const root = await mkdtemp(path.join(tmpdir(), `paseo-vs2-${browserName}-oracle-`));
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
// Each test launches its own isolated desktop app; a failing test does not skip the others.
test.use({ e2eForkProviders: [], e2eInjectPaseoTools: false, channel: "chrome", video: "off" });

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
const inspectionSchema = z.object({ id: z.string(), state: z.unknown() });
const fieldsStateSchema = z.object({ text: z.string(), number: z.string(), notes: z.string() });
const actionStateSchema = z.object({ text: z.string(), count: z.number().int() });

interface Session {
  agentId: string;
  presentFields(): Promise<string>;
  presentAction(): Promise<string>;
  act(id: string): Promise<void>;
  inspect(id: string): Promise<unknown>;
  close(): Promise<void>;
}

async function openSession(
  client: SeedDaemonClient,
  read: OracleFixtures["readPiResults"],
  title: string,
): Promise<Session> {
  const cwd = await mkdtemp(path.join(tmpdir(), "paseo-vs2-project-"));
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
  const present = async (fixture: string, visualTitle: string): Promise<string> => {
    const file = path.join(cwd, fixture);
    await writeFile(
      file,
      await readFile(path.join(repository, "qa/pi-workspace/fixtures", fixture), "utf8"),
      "utf8",
    );
    const shown = await call("visual_present", { mode: "new", title: visualTitle, file });
    return artifactSchema.parse(shown).id;
  };
  return {
    agentId: agent.id,
    presentFields: () => present("ime.html", "Desktop state sync witness"),
    presentAction: () => present("state-sync-action.html", "Desktop state and action witness"),
    async act(id) {
      // Reported as succeeded (call() requires a non-error actual Pi tool result).
      await call("visual_act", { id, action: "increment", value: {} });
    },
    async inspect(id) {
      return inspectionSchema.parse(await call("visual_inspect", { id })).state;
    },
    async close() {
      await client.archiveAgent(agent.id);
      await client.removeProject(workspace.projectId);
      await rm(cwd, { recursive: true, force: true });
    },
  };
}

async function launchDesktop(input: {
  userData: string;
  home: string;
}): Promise<ElectronApplication> {
  const daemonHome = process.env.E2E_PASEO_HOME;
  const metroPort = process.env.E2E_METRO_PORT;
  if (!daemonHome || !metroPort) throw new Error("The isolated daemon and Metro must start first");
  if (path.resolve(daemonHome) === productionHome)
    throw new Error("Refusing production PASEO_HOME");
  for (const required of [electronBinary, desktopMain, entryWrapper]) {
    if (!existsSync(required)) throw new Error(`HARNESS_PREPARATION_FAILED: missing ${required}`);
  }
  await mkdir(input.home, { recursive: true });
  const env: Record<string, string> = {};
  for (const name of ["PATH", "TMPDIR", "LANG", "LC_ALL", "USER", "LOGNAME", "SHELL"]) {
    const value = process.env[name];
    if (value) env[name] = value;
  }
  Object.assign(env, {
    HOME: input.home,
    PASEO_HOME: daemonHome,
    EXPO_DEV_URL: `http://localhost:${metroPort}`,
    PASEO_DISABLE_SINGLE_INSTANCE_LOCK: "1",
    PASEO_ELECTRON_USER_DATA_DIR: input.userData,
    PASEO_ORACLE_DESKTOP_MAIN: desktopMain,
  });
  const app = await electron.launch({
    executablePath: electronBinary,
    args: [entryWrapper],
    cwd: repository,
    env,
    timeout: 120_000,
  });
  expect(await app.evaluate(() => process.versions.electron)).toBe("44.2.0");
  return app;
}

interface Desktop {
  app: ElectronApplication;
  close(): Promise<void>;
}

/** One isolated desktop app (own HOME and userData) for one test. */
async function startDesktop(): Promise<Desktop> {
  const runtime = await mkdtemp(path.join(tmpdir(), "paseo-vs2-runtime-"));
  const removeRuntime = () => rm(runtime, { recursive: true, force: true });
  const app = await launchDesktop({
    userData: path.join(runtime, "user-data"),
    home: path.join(runtime, "home"),
  }).catch(async (error: unknown) => {
    await removeRuntime();
    throw error;
  });
  return {
    app,
    close: async () => {
      // Cleanup after a failed check must not mask that failure (as in the V2-D oracle).
      await app.close().catch(() => undefined);
      await removeRuntime();
    },
  };
}

async function guardPage(page: Page): Promise<void> {
  await page.route(/:(6767|6768)\b/, (route) => route.abort());
  await page.routeWebSocket(/:(6767|6768)\b/, async (socket) => {
    await socket.close({ code: 1008, reason: "Production daemon blocked during desktop oracle" });
  });
}

async function mainWindow(app: ElectronApplication): Promise<Page> {
  const page = await app.firstWindow({ timeout: 120_000 });
  await guardPage(page);
  await page.waitForLoadState("domcontentloaded");
  return page;
}

async function openAgent(page: Page, agentId: string): Promise<void> {
  const serverId = process.env.E2E_SERVER_ID;
  const metroPort = process.env.E2E_METRO_PORT;
  if (!serverId || !metroPort) throw new Error("Missing isolated server identity");
  const host = buildSeededHost({
    serverId,
    endpoint: `127.0.0.1:${getE2EDaemonPort()}`,
    nowIso: new Date().toISOString(),
  });
  await page.evaluate(
    ({ daemon, preferences }) => {
      localStorage.setItem("@paseo:e2e", "1");
      localStorage.setItem("@paseo:daemon-registry", JSON.stringify([daemon]));
      localStorage.removeItem("@paseo:settings");
      localStorage.setItem("@paseo:create-agent-preferences", JSON.stringify(preferences));
    },
    { daemon: host, preferences: buildCreateAgentPreferences() },
  );
  const route = `/h/${encodeURIComponent(serverId)}/agent/${encodeURIComponent(agentId)}`;
  await page.goto(`http://localhost:${metroPort}${route}`);
  await expect(page.getByTestId("message-input-root")).toBeVisible({ timeout: 90_000 });
}

/**
 * Delays every daemon-to-app message of one desktop window by LATENCY_MS, preserving their order.
 * Install before the window navigates to the agent, so its daemon connection is routed.
 */
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

/** The BrowserWindow whose own page this is, or null for any other page (for example a guest). */
async function browserWindowContentsId(
  app: ElectronApplication,
  page: Page,
): Promise<number | null> {
  const marker = `oracle-window-${Math.random().toString(36).slice(2)}`;
  await page.evaluate((value) => {
    Reflect.set(window, "__paseoOracleWindow", value);
  }, marker);
  return app.evaluate(async ({ BrowserWindow }, wanted) => {
    for (const window of BrowserWindow.getAllWindows()) {
      const value: unknown = await window.webContents
        .executeJavaScript("window.__paseoOracleWindow ?? null")
        .catch(() => null);
      if (value === wanted) return window.webContents.id;
    }
    return null;
  }, marker);
}

async function windowContentsId(app: ElectronApplication, page: Page): Promise<number> {
  const id = await browserWindowContentsId(app, page);
  if (id === null) throw new Error("Could not identify the desktop window");
  return id;
}

async function openSecondWindow(
  app: ElectronApplication,
  windowA: Page,
  agentId: string,
): Promise<Page> {
  const before = new Set(app.windows());
  // Runs inside the app renderer: only page globals are available, no test-side imports.
  await windowA.evaluate(async () => {
    const desktop: unknown = Reflect.get(window, "paseoDesktop");
    if (typeof desktop !== "object" || desktop === null) throw new Error("paseoDesktop missing");
    const windowApi: unknown = Reflect.get(desktop, "window");
    if (typeof windowApi !== "object" || windowApi === null) throw new Error("window API missing");
    const openNew: unknown = Reflect.get(windowApi, "openNew");
    if (typeof openNew !== "function") throw new Error("openNew missing");
    await Reflect.apply(openNew, windowApi, []);
  });
  // Guest views can also surface as pages; only a new BrowserWindow's own page qualifies.
  let opened: Page | undefined;
  const findWindow = async () => {
    for (const candidate of app.windows()) {
      if (before.has(candidate)) continue;
      if ((await browserWindowContentsId(app, candidate)) !== null) opened = candidate;
    }
    return opened !== undefined;
  };
  await expect.poll(findWindow, { timeout: 60_000 }).toBe(true);
  if (!opened) throw new Error("The second desktop window did not open");
  await guardPage(opened);
  await opened.waitForLoadState("domcontentloaded");
  await openAgent(opened, agentId);
  return opened;
}

interface VisualFrame {
  webContentsId: number;
  ownerWindowContentsId: number | null;
  isMainFrame: boolean;
}

/** Every frame, in any WebContents, whose document title matches (V2-D's ownership rules). */
async function visualFrames(app: ElectronApplication, wanted: string): Promise<VisualFrame[]> {
  return app.evaluate(async ({ BrowserWindow, webContents }, documentTitle) => {
    const windows = BrowserWindow.getAllWindows().filter((window) => !window.isDestroyed());
    const windowIds = new Set(windows.map((window) => window.webContents.id));
    const timeout = () => new Promise<null>((resolve) => setTimeout(() => resolve(null), 1500));
    // A WebContentsView embedding is owned by the window whose view tree contains it.
    const viewOwner = (contentsId: number) => {
      for (const window of windows) {
        const pending: unknown[] = [...window.contentView.children];
        while (pending.length > 0) {
          const view = pending.pop();
          const viewContents: unknown = view ? Reflect.get(view, "webContents") : undefined;
          if (viewContents && Reflect.get(viewContents, "id") === contentsId) {
            return window.webContents;
          }
          const children: unknown = view ? Reflect.get(view, "children") : undefined;
          if (Array.isArray(children)) pending.push(...children);
        }
      }
      return null;
    };
    const found: VisualFrame[] = [];
    for (const contents of webContents.getAllWebContents()) {
      if (contents.isDestroyed()) continue;
      for (const frame of contents.mainFrame.framesInSubtree) {
        const read = frame.executeJavaScript("document.title").catch(() => null);
        if ((await Promise.race([read, timeout()])) !== documentTitle) continue;
        const owner = windowIds.has(contents.id)
          ? contents
          : (contents.hostWebContents ??
            BrowserWindow.fromWebContents(contents)?.webContents ??
            viewOwner(contents.id));
        found.push({
          webContentsId: contents.id,
          ownerWindowContentsId: owner && windowIds.has(owner.id) ? owner.id : null,
          isMainFrame: frame === contents.mainFrame,
        });
      }
    }
    return found;
  }, wanted);
}

/** The guest WebContents showing the fixture document for this window (never the window itself). */
async function ownedGuest(
  app: ElectronApplication,
  ownerId: number,
  title: string,
): Promise<number | null> {
  const frame = (await visualFrames(app, title)).find(
    (candidate) =>
      candidate.ownerWindowContentsId === ownerId &&
      candidate.isMainFrame &&
      candidate.webContentsId !== ownerId,
  );
  return frame ? frame.webContentsId : null;
}

/** Playwright's page for the guest that carries this one-off marker, if Playwright exposes it. */
async function markedPage(app: ElectronApplication, marker: string): Promise<Page | null> {
  for (const candidate of app.windows()) {
    if (candidate.isClosed()) continue;
    const value: unknown = await candidate
      .evaluate(() => Reflect.get(window, "__paseoOracleGuest") ?? null)
      .catch(() => null);
    if (value === marker) return candidate;
  }
  return null;
}

/**
 * The isolated guest page displaying the fixture for this desktop window. Input goes through the
 * guest's own input pipeline (trusted key and pointer events), as a user typing in that window.
 */
async function guestPage(
  app: ElectronApplication,
  owner: Page,
  title = FIELDS_TITLE,
): Promise<Page> {
  const ownerId = await windowContentsId(app, owner);
  await expect
    .poll(() => ownedGuest(app, ownerId, title), {
      timeout: 30_000,
      message: "the visual is not displayed by this desktop window",
    })
    .not.toBeNull();
  const contentsId = await ownedGuest(app, ownerId, title);
  if (contentsId === null) throw new Error("The visual disappeared from this desktop window");
  const marker = `oracle-guest-${Math.random().toString(36).slice(2)}`;
  await app.evaluate(
    async ({ webContents }, input) => {
      const contents = webContents.fromId(input.contentsId);
      if (!contents || contents.isDestroyed()) throw new Error("The visual guest disappeared");
      await contents.executeJavaScript(
        `window.__paseoOracleGuest = ${JSON.stringify(input.marker)}; true`,
      );
    },
    { contentsId, marker },
  );
  await expect
    .poll(async () => (await markedPage(app, marker)) !== null, {
      timeout: 30_000,
      message: "the guest page of this desktop window is not reachable",
    })
    .toBe(true);
  const page = await markedPage(app, marker);
  if (!page) throw new Error("The guest page of this desktop window disappeared");
  return page;
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
    stored: fieldsStateSchema.parse(await session.inspect(id)).text,
    displays: await Promise.all(fields.map((field) => field.inputValue())),
  });
  await page.waitForTimeout(SETTLE_MS);
  const first = await observe();
  await page.waitForTimeout(RECHECK_MS);
  const second = await observe();
  expect(second, "the visual state kept changing after typing stopped").toEqual(first);
  return second;
}

test("desktop edits typed faster than the daemon round trip all reach the stored visual state", async ({
  e2eWorkerClient,
  readPiResults,
}) => {
  test.setTimeout(300_000);
  const session = await openSession(e2eWorkerClient, readPiResults, "Desktop state sync oracle");
  let desktop: Desktop | null = null;
  try {
    desktop = await startDesktop();
    const typingWindow = await mainWindow(desktop.app);
    await addDaemonLatency(typingWindow);
    await openAgent(typingWindow, session.agentId);
    const id = await session.presentFields();
    const field = (await guestPage(desktop.app, typingWindow)).locator("#text");
    await expect(field).toBeVisible();
    await expect(field).toHaveValue("");

    await field.click();
    await field.pressSequentially("Hello worr", { delay: KEY_DELAY_MS });
    await field.press("Backspace");
    await field.pressSequentially("ld", { delay: KEY_DELAY_MS });
    expect(await settled(session, id, [field], typingWindow)).toEqual({
      stored: "Hello world",
      displays: ["Hello world"],
    });

    await field.press("End");
    await field.pressSequentially(" again and again", { delay: KEY_DELAY_MS });
    expect(await settled(session, id, [field], typingWindow)).toEqual({
      stored: "Hello world again and again",
      displays: ["Hello world again and again"],
    });

    await field.press("ControlOrMeta+A");
    await field.pressSequentially("Every key counts", { delay: KEY_DELAY_MS });
    await field.press("Backspace");
    await field.press("Backspace");
    await field.pressSequentially("ts!", { delay: KEY_DELAY_MS });
    expect(await settled(session, id, [field], typingWindow)).toEqual({
      stored: "Every key counts!",
      displays: ["Every key counts!"],
    });
  } finally {
    if (desktop) await desktop.close();
    await session.close();
  }
});

test("a second desktop window converges to every edit of a slow typing window", async ({
  e2eWorkerClient,
  readPiResults,
}) => {
  test.setTimeout(300_000);
  const session = await openSession(e2eWorkerClient, readPiResults, "Desktop state sync windows");
  let desktop: Desktop | null = null;
  try {
    desktop = await startDesktop();
    const windowA = await mainWindow(desktop.app);
    await addDaemonLatency(windowA);
    await openAgent(windowA, session.agentId);
    const id = await session.presentFields();
    const windowB = await openSecondWindow(desktop.app, windowA, session.agentId);
    const typing = (await guestPage(desktop.app, windowA)).locator("#text");
    const watching = (await guestPage(desktop.app, windowB)).locator("#text");
    await expect(typing).toBeVisible();
    await expect(watching).toBeVisible();

    await typing.click();
    await typing.pressSequentially("Shared across windows", { delay: KEY_DELAY_MS });
    expect(await settled(session, id, [typing, watching], windowA)).toEqual({
      stored: "Shared across windows",
      displays: ["Shared across windows", "Shared across windows"],
    });
  } finally {
    if (desktop) await desktop.close();
    await session.close();
  }
});

test("concurrent edits in two desktop windows converge to one stored state", async ({
  e2eWorkerClient,
  readPiResults,
}) => {
  test.setTimeout(300_000);
  const session = await openSession(e2eWorkerClient, readPiResults, "Desktop state sync conflict");
  let desktop: Desktop | null = null;
  try {
    desktop = await startDesktop();
    const windowA = await mainWindow(desktop.app);
    await addDaemonLatency(windowA);
    await openAgent(windowA, session.agentId);
    const id = await session.presentFields();
    const windowB = await openSecondWindow(desktop.app, windowA, session.agentId);
    const slow = (await guestPage(desktop.app, windowA)).locator("#text");
    const fast = (await guestPage(desktop.app, windowB)).locator("#text");
    await expect(slow).toBeVisible();
    await expect(fast).toBeVisible();

    await slow.click();
    await fast.click();
    await Promise.all([
      slow.pressSequentially("slow side typing", { delay: KEY_DELAY_MS }),
      fast.pressSequentially("FAST SIDE TYPING", { delay: KEY_DELAY_MS }),
    ]);
    const outcome = await settled(session, id, [slow, fast], windowA);
    // Which writer wins a conflict is not prescribed; silent divergence is a failure.
    expect(outcome.displays, "displays diverged from each other").toEqual([
      outcome.stored,
      outcome.stored,
    ]);
    expect(outcome.stored.length).toBeGreaterThan(0);
  } finally {
    if (desktop) await desktop.close();
    await session.close();
  }
});

interface ActionObservation {
  stored: { text: string; count: number };
  display: { text: string; count: string };
}

/** Waits past every in-flight cycle, then requires two identical observations. */
async function settledAction(
  session: Session,
  id: string,
  field: Locator,
  count: Locator,
  page: Page,
): Promise<ActionObservation> {
  const observe = async (): Promise<ActionObservation> => ({
    stored: actionStateSchema.parse(await session.inspect(id)),
    display: { text: await field.inputValue(), count: (await count.textContent()) ?? "" },
  });
  await page.waitForTimeout(SETTLE_MS);
  const first = await observe();
  await page.waitForTimeout(RECHECK_MS);
  const second = await observe();
  expect(second, "the visual state kept changing after typing stopped").toEqual(first);
  return second;
}

test("a desktop agent action during fast typing on a slow link is applied once and every edit is kept", async ({
  e2eWorkerClient,
  readPiResults,
}) => {
  test.setTimeout(300_000);
  const session = await openSession(e2eWorkerClient, readPiResults, "Desktop state sync action");
  let desktop: Desktop | null = null;
  try {
    desktop = await startDesktop();
    const typingWindow = await mainWindow(desktop.app);
    await addDaemonLatency(typingWindow);
    await openAgent(typingWindow, session.agentId);
    const id = await session.presentAction();
    const guest = await guestPage(desktop.app, typingWindow, ACTION_TITLE);
    const field = guest.locator("#text");
    const count = guest.locator("#count");
    await expect(field).toBeVisible();
    await expect(field).toHaveValue("");
    await expect(count).toHaveText("0");

    await field.click();
    const action = { done: false };
    const acted = (async () => {
      await typingWindow.waitForTimeout(ACTION_AFTER_MS);
      try {
        await session.act(id);
      } finally {
        action.done = true;
      }
    })();
    let typed = "";
    let after = 0;
    for (let key = 0; key < MAX_KEYS && after < KEYS_AFTER_ACTION; key += 1) {
      const character = PHRASE[key % PHRASE.length] ?? " ";
      await field.pressSequentially(character);
      typed += character;
      if (action.done) after += 1;
      await typingWindow.waitForTimeout(KEY_DELAY_MS);
    }
    await acted;
    expect(after, "typing continued after the action completed").toBe(KEYS_AFTER_ACTION);
    expect(await settledAction(session, id, field, count, typingWindow)).toEqual({
      stored: { text: typed, count: 1 },
      display: { text: typed, count: "1" },
    });
  } finally {
    if (desktop) await desktop.close();
    await session.close();
  }
});
