import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createSocket } from "node:dgram";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { z } from "zod";
import { _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import { test as base, expect } from "../support/fixtures";
import { buildCreateAgentPreferences, buildSeededHost } from "../support/helpers/daemon-registry";
import { getE2EDaemonPort } from "../support/helpers/daemon-port";
import type { SeedDaemonClient } from "../support/helpers/seed-client";

// Judge-owned V2 desktop oracle. It drives actual Pi -> isolated daemon -> actual Electron 44
// running the unmodified checkout desktop main and the Electron-flavored app bundle.
// It does not certify Android, speech, conversation detours or deployment.

const repository = path.resolve(__dirname, "../../../..");
const electronBinary = path.join(
  repository,
  "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron",
);
const desktopMain = path.join(repository, "packages/desktop/dist/main.js");
const entryWrapper = path.join(repository, "qa/pi-workspace/electron-quiet.cjs");
const fixtures = path.join(repository, "qa/pi-workspace/fixtures");
const productionHome = path.join(homedir(), ".paseo");

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
      const root = await mkdtemp(path.join(tmpdir(), `paseo-desktop-${browserName}-oracle-`));
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
test.use({ e2eForkProviders: [], e2eInjectPaseoTools: false, channel: "chrome", video: "off" });
test.describe.configure({ mode: "serial" });

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
const envelopeSchema = z.object({ type: z.string(), message: z.unknown().optional() });
const resultSchema = z.object({
  role: z.literal("toolResult"),
  toolName: z.string(),
  isError: z.boolean(),
  details: z.unknown(),
  content: z.array(
    z.object({ type: z.string(), data: z.string().optional(), mimeType: z.string().optional() }),
  ),
});
type StoredResult = z.infer<typeof resultSchema>;

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
  const results: StoredResult[] = [];
  for (const line of matches[0] ?? []) {
    const entry = envelopeSchema.parse(JSON.parse(line));
    if (entry.type !== "message") continue;
    const role = z.object({ role: z.string() }).parse(entry.message).role;
    if (role === "toolResult") results.push(resultSchema.parse(entry.message));
  }
  return results;
}

interface ToolOutcome {
  details: unknown;
  png: Buffer | null;
}
interface PiDriver {
  call(
    name: string,
    args: { [key: string]: JsonValue },
    expectError?: boolean,
  ): Promise<ToolOutcome>;
}
function piDriver(input: {
  client: SeedDaemonClient;
  agentId: string;
  cwd: string;
  readResults(cwd: string): Promise<StoredResult[]>;
}): PiDriver {
  let count = 0;
  return {
    async call(name, args, expectError = false) {
      await input.client.sendAgentMessage(
        input.agentId,
        `oracle-call:${JSON.stringify({ name, arguments: args })}`,
      );
      const finish = await input.client.waitForFinish(input.agentId, 45_000);
      expect(finish.status).toBe("idle");
      const results = await input.readResults(input.cwd);
      count += 1;
      expect(results).toHaveLength(count);
      const result = results.at(-1);
      if (!result) throw new Error("No actual Pi tool result was persisted");
      expect(result.toolName).toBe(name);
      expect(result.isError, JSON.stringify({ name, details: result.details })).toBe(expectError);
      const images = result.content.filter((part) => part.type === "image");
      expect(images.length).toBeLessThanOrEqual(1);
      const image = images[0];
      if (image) expect(image.mimeType).toBe("image/png");
      return {
        details: result.details,
        png: image?.data ? Buffer.from(image.data, "base64") : null,
      };
    },
  };
}

const errorSchema = z.object({ error: z.object({ code: z.string(), message: z.string() }) });
const presentedSchema = z.object({
  id: z.string().min(1),
  revision: z.number().int().positive(),
  status: z.literal("rendered"),
});
const displaySchema = z.object({ client: z.string().min(1), active: z.boolean() }).passthrough();
const inspectionSchema = z
  .object({
    id: z.string(),
    revision: z.number().int().positive(),
    state: z.unknown(),
    client: z.string().min(1),
    displays: z.array(displaySchema),
  })
  .passthrough();
const screenshotSchema = z
  .object({
    client: z.string().min(1),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
  })
  .passthrough();
const valueSchema = z.object({ value: z.number().int() });

function errorCode(outcome: ToolOutcome): string {
  return errorSchema.parse(outcome.details).error.code;
}
async function inspect(pi: PiDriver, id: string) {
  return inspectionSchema.parse((await pi.call("visual_inspect", { id })).details);
}
async function storedValue(pi: PiDriver, id: string): Promise<number> {
  return valueSchema.parse((await inspect(pi, id)).state).value;
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

interface VisualFrame {
  webContentsId: number;
  ownerWindowContentsId: number | null;
  isMainFrame: boolean;
  frameProcessId: number;
  windowProcessIds: number[];
  persistent: boolean;
  defaultSession: boolean;
  browserProfile: boolean;
}

/** Every frame, in any WebContents, whose document title matches. Hung frames time out. */
async function visualFrames(app: ElectronApplication, wanted: string): Promise<VisualFrame[]> {
  return app.evaluate(async ({ BrowserWindow, session, webContents }, documentTitle) => {
    const windows = BrowserWindow.getAllWindows().filter((window) => !window.isDestroyed());
    const windowIds = new Set(windows.map((window) => window.webContents.id));
    const windowProcessIds = windows.map((window) => window.webContents.getOSProcessId());
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
          frameProcessId: frame.osProcessId,
          windowProcessIds,
          persistent: contents.session.isPersistent(),
          defaultSession: contents.session === session.defaultSession,
          browserProfile: contents.session === session.fromPartition("persist:paseo-browser"),
        });
      }
    }
    return found;
  }, wanted);
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

async function browserWindowCount(app: ElectronApplication): Promise<number> {
  return app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
}

/** The document must be the top-level document of its own isolated guest for this window. */
async function isolatedVisual(
  app: ElectronApplication,
  title: string,
  owner: Page,
): Promise<VisualFrame> {
  const ownerId = await windowContentsId(app, owner);
  const ownedFrame = async () =>
    (await visualFrames(app, title)).find((frame) => frame.ownerWindowContentsId === ownerId);
  await expect
    .poll(async () => (await ownedFrame()) !== undefined, {
      timeout: 30_000,
      message: `${title} is not displayed by this desktop window`,
    })
    .toBe(true);
  const frame = await ownedFrame();
  if (!frame) throw new Error(`${title} disappeared from this desktop window`);
  expect({
    dedicatedGuest: frame.webContentsId !== ownerId,
    topLevelDocument: frame.isMainFrame,
    separateProcess: !frame.windowProcessIds.includes(frame.frameProcessId),
    nonpersistentSession: !frame.persistent,
    notAppSession: !frame.defaultSession,
    notBrowserProfile: !frame.browserProfile,
  }).toEqual({
    dedicatedGuest: true,
    topLevelDocument: true,
    separateProcess: true,
    nonpersistentSession: true,
    notAppSession: true,
    notBrowserProfile: true,
  });
  return frame;
}

async function inGuest<T>(
  app: ElectronApplication,
  contentsId: number,
  script: string,
): Promise<T> {
  const result = await app.evaluate(
    async ({ webContents }, input) => {
      const contents = webContents.fromId(input.contentsId);
      if (!contents || contents.isDestroyed()) return { ok: false, value: "destroyed" };
      const timeout = new Promise<{ ok: boolean; value: unknown }>((resolve) =>
        setTimeout(() => resolve({ ok: false, value: "timeout" }), 3000),
      );
      const evaluation = contents
        .executeJavaScript(input.script)
        .then((value: unknown) => ({ ok: true, value }));
      return Promise.race([evaluation, timeout]);
    },
    { contentsId, script },
  );
  if (!result.ok) throw new Error(`Guest evaluation failed: ${String(result.value)}`);
  return result.value as T;
}

/** Trusted input through the guest's own input pipeline, like a real pointer click. */
async function clickInGuest(
  app: ElectronApplication,
  contentsId: number,
  selector: string,
): Promise<void> {
  const box = await inGuest<{ x: number; y: number }>(
    app,
    contentsId,
    `(() => { const element = document.querySelector(${JSON.stringify(selector)}); element.scrollIntoView({ block: "center" }); const r = element.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`,
  );
  await app.evaluate(
    ({ webContents }, input) => {
      const contents = webContents.fromId(input.contentsId);
      if (!contents) throw new Error("Guest disappeared before input");
      const click = { x: input.x, y: input.y, button: "left" as const, clickCount: 1 };
      contents.sendInputEvent({ type: "mouseMove", x: input.x, y: input.y });
      contents.sendInputEvent({ type: "mouseDown", ...click });
      contents.sendInputEvent({ type: "mouseUp", ...click });
    },
    { contentsId, ...box },
  );
}

async function motif(app: ElectronApplication, contentsId: number): Promise<string> {
  const code = await inGuest<string>(
    app,
    contentsId,
    "document.getElementById('pattern').textContent",
  );
  expect(code).toMatch(/^[0-9a-f]{48}$/);
  return code;
}

/** Paints a fresh private motif locally (never published) and brings it into the viewport. */
async function repaint(app: ElectronApplication, contentsId: number): Promise<string> {
  const before = await motif(app, contentsId);
  await clickInGuest(app, contentsId, "#repaint");
  await expect.poll(() => motif(app, contentsId)).not.toBe(before);
  await inGuest(app, contentsId, "window.scrollTo(0, 0)");
  return motif(app, contentsId);
}

async function readValue(app: ElectronApplication, contentsId: number): Promise<string> {
  return inGuest<string>(app, contentsId, "document.getElementById('value').textContent");
}

/** Decodes the actual Pi image and checks all 192 private client cells. */
async function expectMotif(png: Buffer | null, expected: string): Promise<void> {
  if (!png) throw new Error("visual_inspect returned no real Pi image content");
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const at = (x: number, y: number) => {
    const offset = (y * info.width + x) * 4;
    return [data[offset] ?? 0, data[offset + 1] ?? 0, data[offset + 2] ?? 0];
  };
  let minX = info.width;
  let minY = info.height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < info.height; y += 1) {
    for (let x = 0; x < info.width; x += 1) {
      const [r, g, b] = at(x, y);
      if (r > 235 && g < 25 && b > 235) {
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
    }
  }
  expect(maxX, "private motif frame not present in the actual capture").toBeGreaterThan(minX);
  const scale = (maxX - minX + 1) / 256;
  expect(Math.abs((maxY - minY + 1) / scale - 128), "motif frame clipped").toBeLessThan(2);
  const bits: number[] = [];
  for (let index = 0; index < 192; index += 1) {
    const x = Math.floor(minX + (8 + (index % 16) * 15 + 7) * scale);
    const y = Math.floor(minY + (8 + Math.floor(index / 16) * 9 + 4) * scale);
    const [r, g, b] = at(x, y);
    const luminance = (r + g + b) / 3;
    expect(luminance < 40 || luminance > 215, `cell ${index} is not a crisp motif cell`).toBe(true);
    bits.push(luminance > 127 ? 1 : 0);
  }
  let observed = "";
  for (let byte = 0; byte < 24; byte += 1) {
    let value = 0;
    for (const bit of bits.slice(byte * 8, byte * 8 + 8)) value = value * 2 + bit;
    observed += value.toString(16).padStart(2, "0");
  }
  expect(observed).toBe(expected);
}

interface Sink {
  port: number;
  udpPort: number;
  arrivals: string[];
  close(): Promise<void>;
}
async function startSink(): Promise<Sink> {
  const arrivals: string[] = [];
  const tcp = createServer((socket) => {
    arrivals.push("tcp:connection");
    socket.once("data", (chunk) => {
      arrivals.push(`tcp:${chunk.toString("latin1").split("\r\n")[0]}`);
    });
    socket.on("error", () => undefined);
    setTimeout(() => socket.destroy(), 200);
  });
  await new Promise<void>((resolve) => tcp.listen(0, "127.0.0.1", resolve));
  const udp = createSocket("udp4");
  udp.on("message", () => arrivals.push("udp:datagram"));
  await new Promise<void>((resolve) => udp.bind(0, "127.0.0.1", resolve));
  const tcpAddress = tcp.address();
  if (!tcpAddress || typeof tcpAddress === "string") throw new Error("Sink did not bind");
  return {
    port: tcpAddress.port,
    udpPort: udp.address().port,
    arrivals,
    close: async () => {
      udp.close();
      await new Promise<void>((resolve) => tcp.close(() => resolve()));
    },
  };
}

async function prepareAgent(client: SeedDaemonClient, title: string) {
  const cwd = await mkdtemp(path.join(tmpdir(), "paseo-desktop-project-"));
  const created = await client.createWorkspace({ source: { kind: "directory", path: cwd }, title });
  if (!created.workspace) throw new Error(created.error ?? "Workspace creation failed");
  const projectId = created.workspace.projectId;
  const agent = await client.createAgent({
    provider: "pi",
    model: "pi-workspace-oracle/scripted",
    thinkingOptionId: "off",
    cwd,
    workspaceId: created.workspace.id,
    title,
  });
  return {
    cwd,
    agentId: agent.id,
    cleanup: async () => {
      await client.archiveAgent(agent.id);
      await client.removeProject(projectId);
      await rm(cwd, { recursive: true, force: true });
    },
  };
}

async function presentFile(pi: PiDriver, cwd: string, name: string, title: string, html: string) {
  const file = path.join(cwd, name);
  await writeFile(file, html, "utf8");
  const presented = await pi.call("visual_present", { mode: "new", title, file });
  return presentedSchema.parse(presented.details);
}

interface Run {
  app: ElectronApplication;
  windowA: Page;
  pi: PiDriver;
  cwd: string;
  agentId: string;
  shownId: string;
  sink: Sink;
  outputPath(name: string): string;
}

async function checkGuest(run: Run): Promise<VisualFrame> {
  const frame = await isolatedVisual(run.app, "Client pixel witness", run.windowA);
  const privileges = await inGuest<Record<string, string>>(
    run.app,
    frame.webContentsId,
    "({ require: typeof require, process: typeof process, module: typeof module, paseoDesktop: typeof window.paseoDesktop })",
  );
  expect(privileges).toEqual({
    require: "undefined",
    process: "undefined",
    module: "undefined",
    paseoDesktop: "undefined",
  });
  return frame;
}

async function checkPixels(run: Run, a: VisualFrame): Promise<void> {
  const first = await repaint(run.app, a.webContentsId);
  const firstCapture = await run.pi.call("visual_inspect", { id: run.shownId, screenshot: true });
  await expectMotif(firstCapture.png, first);
  const inspected = inspectionSchema.parse(firstCapture.details);
  expect(screenshotSchema.parse(inspected.screenshot).client).toBe(inspected.client);
  const second = await repaint(run.app, a.webContentsId);
  const secondCapture = await run.pi.call("visual_inspect", { id: run.shownId, screenshot: true });
  await expectMotif(secondCapture.png, second);
  await expect(expectMotif(firstCapture.png, second)).rejects.toThrow();
}

async function openSecondWindow(run: Run): Promise<Page> {
  const before = new Set(run.app.windows());
  // Runs inside the app renderer: only page globals are available, no test-side imports.
  await run.windowA.evaluate(async () => {
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
    for (const candidate of run.app.windows()) {
      if (before.has(candidate)) continue;
      if ((await browserWindowContentsId(run.app, candidate)) !== null) opened = candidate;
    }
    return opened !== undefined;
  };
  await expect.poll(findWindow, { timeout: 60_000 }).toBe(true);
  if (!opened) throw new Error("The second desktop window did not open");
  await guardPage(opened);
  await opened.waitForLoadState("domcontentloaded");
  await openAgent(opened, run.agentId);
  return opened;
}

async function checkDisplays(run: Run, a: VisualFrame, b: VisualFrame) {
  const motifA = await repaint(run.app, a.webContentsId);
  const activeA = await run.pi.call("visual_inspect", { id: run.shownId, screenshot: true });
  await expectMotif(activeA.png, motifA);
  const inspectedA = inspectionSchema.parse(activeA.details);
  const activeClients = inspectedA.displays.filter((display) => display.active);
  expect(activeClients.map((display) => display.client)).toEqual([inspectedA.client]);
  const motifB = await repaint(run.app, b.webContentsId);
  const activeB = await run.pi.call("visual_inspect", { id: run.shownId, screenshot: true });
  await expectMotif(activeB.png, motifB);
  const inspectedB = inspectionSchema.parse(activeB.details);
  expect(inspectedB.client).not.toBe(inspectedA.client);
  expect(new Set(inspectedB.displays.map((display) => display.client))).toEqual(
    new Set([inspectedA.client, inspectedB.client]),
  );
  const addressed = await run.pi.call("visual_inspect", {
    id: run.shownId,
    screenshot: true,
    client: inspectedA.client,
  });
  await expectMotif(addressed.png, motifA);
  const addressedShot = inspectionSchema.parse(addressed.details).screenshot;
  expect(screenshotSchema.parse(addressedShot).client).toBe(inspectedA.client);
  return { a: inspectedA.client, b: inspectedB.client };
}

async function checkConvergence(run: Run, a: VisualFrame, b: VisualFrame): Promise<void> {
  const start = await storedValue(run.pi, run.shownId);
  await clickInGuest(run.app, a.webContentsId, "#increment");
  await expect
    .poll(() => readValue(run.app, b.webContentsId), { timeout: 10_000 })
    .toBe(`Value: ${start + 1}`);
  // Two local publications from the same base revision race; neither display may diverge.
  await run.app.evaluate(
    ({ webContents }, ids) => {
      for (const id of ids) {
        void webContents
          .fromId(id)
          ?.executeJavaScript("document.getElementById('increment').click()");
      }
    },
    [a.webContentsId, b.webContentsId],
  );
  const converged = async () => {
    const stored = `Value: ${await storedValue(run.pi, run.shownId)}`;
    const shown = [
      await readValue(run.app, a.webContentsId),
      await readValue(run.app, b.webContentsId),
    ];
    return shown.every((value) => value === stored);
  };
  await expect.poll(converged, { timeout: 20_000, intervals: [1000] }).toBe(true);
  expect([`Value: ${start + 2}`, `Value: ${start + 3}`]).toContain(
    await readValue(run.app, a.webContentsId),
  );
}

async function checkClosedDisplay(
  run: Run,
  windowB: Page,
  a: VisualFrame,
  clients: { a: string; b: string },
): Promise<void> {
  await windowB.close();
  const remaining = async () =>
    (await inspect(run.pi, run.shownId)).displays.map((display) => display.client);
  await expect.poll(remaining, { timeout: 20_000, intervals: [1000] }).toEqual([clients.a]);
  const gone = await run.pi.call(
    "visual_inspect",
    { id: run.shownId, screenshot: true, client: clients.b },
    true,
  );
  expect(errorCode(gone)).toBe("DISPLAY_UNAVAILABLE");
  expect(gone.png).toBeNull();
  const fresh = await repaint(run.app, a.webContentsId);
  await expectMotif(
    (await run.pi.call("visual_inspect", { id: run.shownId, screenshot: true })).png,
    fresh,
  );
}

const egressVectors = [
  "fetch",
  "xhr",
  "websocket",
  "eventSource",
  "image",
  "cssBackground",
  "cssImport",
  "font",
  "svgImage",
  "audio",
  "video",
  "script",
  "stylesheet",
  "prefetch",
  "iframe",
  "beacon",
  "dynamicImport",
  "worker",
  "serviceWorker",
  "form",
  "preconnect",
  "ping",
  "webTransport",
  "webrtc",
  "webrtcNestedFrame",
  "webrtcSrcdocFrame",
];
const egressStateSchema = z
  .object({
    done: z.literal(true),
    attempted: z.array(z.string()),
    lateVectors: z.array(z.string()),
    privileged: z.object({
      require: z.literal("undefined"),
      process: z.literal("undefined"),
      module: z.literal("undefined"),
      paseoDesktop: z.literal("undefined"),
      electron: z.literal("undefined"),
      ipcRenderer: z.literal("undefined"),
      fileFetch: z.literal("blocked"),
      notification: z.enum(["denied", "default", "unavailable"]),
      media: z.enum(["denied", "skipped", "unavailable"]),
    }),
  })
  .passthrough();

async function checkEgress(run: Run): Promise<void> {
  const egress = (await readFile(path.join(fixtures, "egress.html"), "utf8"))
    .replaceAll("__SINK_HOST__", "127.0.0.1")
    .replaceAll("__SINK_PORT__", String(run.sink.port))
    .replaceAll("__SINK_UDP_PORT__", String(run.sink.udpPort));
  const presented = await presentFile(run.pi, run.cwd, "egress.html", "Egress witness", egress);
  const frame = await isolatedVisual(run.app, "Egress witness", run.windowA);
  await expect
    .poll(
      () => inGuest<string | undefined>(run.app, frame.webContentsId, "document.body.dataset.done"),
      {
        timeout: 20_000,
      },
    )
    .toBe("1");
  const state = egressStateSchema.parse((await inspect(run.pi, presented.id)).state);
  expect(state.attempted).toEqual(egressVectors);
  expect(state.lateVectors).toEqual(["windowOpen", "download", "topNavigation"]);
  await new Promise((resolve) => setTimeout(resolve, 4000));
  expect(run.sink.arrivals).toEqual([]);
  // Navigation, windows and downloads were denied: the document is still the displayed guest.
  const still = await isolatedVisual(run.app, "Egress witness", run.windowA);
  expect(still.webContentsId).toBe(frame.webContentsId);
  expect(await browserWindowCount(run.app)).toBe(1);
  await run.windowA.screenshot({ path: run.outputPath("egress.png") });
}

function processState(pid: number): "alive" | "terminated" {
  try {
    process.kill(pid, 0);
    return "alive";
  } catch {
    return "terminated";
  }
}

async function checkHang(run: Run): Promise<void> {
  const hang = await readFile(path.join(fixtures, "hang.html"), "utf8");
  const presented = await presentFile(run.pi, run.cwd, "hang.html", "Hang witness", hang);
  const frame = await isolatedVisual(run.app, "Hang witness", run.windowA);
  await run.pi.call("visual_act", { id: presented.id, action: "freeze", value: {} });
  await new Promise((resolve) => setTimeout(resolve, 1500));
  // The desktop app follows the operator's system locale, so the composer is located by its
  // stable test identity rather than a translated accessible name.
  const composer = run.windowA.getByTestId("message-input-root").getByRole("textbox").first();
  const draft = "draft typed while a visual is hung";
  await composer.fill(draft, { timeout: 5000 });
  await expect(composer).toHaveValue(draft);
  const started = Date.now();
  const unresponsive = await run.pi.call("visual_inspect", { id: presented.id }, true);
  expect(errorCode(unresponsive)).toBe("DOCUMENT_UNRESPONSIVE");
  expect(Date.now() - started).toBeLessThan(25_000);
  await expect
    .poll(() => processState(frame.frameProcessId), { timeout: 15_000 })
    .toBe("terminated");
  await expect(composer).toHaveValue(draft);
  const again = await run.pi.call("visual_inspect", { id: presented.id }, true);
  expect(errorCode(again)).toBe("DOCUMENT_UNRESPONSIVE");
  const reopened = await run.pi.call("visual_present", { mode: "open", id: run.shownId });
  expect(presentedSchema.parse(reopened.details).id).toBe(run.shownId);
  const recovered = await isolatedVisual(run.app, "Client pixel witness", run.windowA);
  const fresh = await repaint(run.app, recovered.webContentsId);
  await expectMotif(
    (await run.pi.call("visual_inspect", { id: run.shownId, screenshot: true })).png,
    fresh,
  );
}

test("harness prerequisite: isolated real Electron reaches the agent and Pi visual", async ({
  e2eWorkerClient,
  piOracleHome,
  readPiResults,
}, testInfo) => {
  test.setTimeout(300_000);
  const { cwd, agentId, cleanup } = await prepareAgent(
    e2eWorkerClient,
    "Desktop harness prerequisite",
  );
  const runtime = await mkdtemp(path.join(tmpdir(), "paseo-desktop-runtime-"));
  const app = await launchDesktop({
    userData: path.join(runtime, "user-data"),
    home: path.join(runtime, "home"),
  });
  try {
    const page = await mainWindow(app);
    expect(await page.evaluate(() => typeof Reflect.get(window, "paseoDesktop"))).toBe("object");
    await openAgent(page, agentId);
    const pi = piDriver({ client: e2eWorkerClient, agentId, cwd, readResults: readPiResults });
    const html = await readFile(path.join(fixtures, "client-pixels.html"), "utf8");
    await presentFile(pi, cwd, "pixels.html", "Pixel prerequisite", html);
    const displayed = async () => (await visualFrames(app, "Client pixel witness")).length;
    await expect.poll(displayed, { timeout: 30_000 }).toBeGreaterThan(0);
    await page.screenshot({ path: testInfo.outputPath("prerequisite.png") });
    expect(piOracleHome.root.startsWith(tmpdir())).toBe(true);
  } finally {
    await app.close();
    await rm(runtime, { recursive: true, force: true });
    await cleanup();
  }
});

test("desktop V2: isolated guest, actual pixels, displays, egress, hang and relaunch", async ({
  e2eWorkerClient,
  readPiResults,
}, testInfo) => {
  test.setTimeout(900_000);
  const { cwd, agentId, cleanup } = await prepareAgent(e2eWorkerClient, "Desktop V2 oracle");
  const runtime = await mkdtemp(path.join(tmpdir(), "paseo-desktop-runtime-"));
  const userData = path.join(runtime, "user-data");
  const home = path.join(runtime, "home");
  const sink = await startSink();
  const pi = piDriver({ client: e2eWorkerClient, agentId, cwd, readResults: readPiResults });
  let app = await launchDesktop({ userData, home });
  try {
    const windowA = await mainWindow(app);
    await openAgent(windowA, agentId);
    const pixels = await readFile(path.join(fixtures, "client-pixels.html"), "utf8");
    const shown = await presentFile(pi, cwd, "pixels.html", "Pixel witness", pixels);
    const run: Run = {
      app,
      windowA,
      pi,
      cwd,
      agentId,
      shownId: shown.id,
      sink,
      outputPath: (name) => testInfo.outputPath(name),
    };
    const a = await test.step("dedicated isolated guest", () => checkGuest(run));
    await test.step("actual pixels twice, stale rejected", () => checkPixels(run, a));
    const windowB = await test.step("second desktop window", () => openSecondWindow(run));
    const b = await isolatedVisual(app, "Client pixel witness", windowB);
    expect(b.webContentsId).not.toBe(a.webContentsId);
    const clients = await test.step("active and addressed displays", () =>
      checkDisplays(run, a, b));
    await test.step("displays converge on stored state", () => checkConvergence(run, a, b));
    await test.step("closed display is never substituted", () =>
      checkClosedDisplay(run, windowB, a, clients));
    await test.step("egress, permissions and navigation blocked", () => checkEgress(run));
    await test.step("hung document terminated, host usable", () => checkHang(run));
    const value = await storedValue(pi, shown.id);
    await app.close();
    app = await launchDesktop({ userData, home });
    const page = await mainWindow(app);
    await openAgent(page, agentId);
    await pi.call("visual_present", { mode: "open", id: shown.id });
    const restored = await isolatedVisual(app, "Client pixel witness", page);
    await expect.poll(() => readValue(app, restored.webContentsId)).toBe(`Value: ${value}`);
    const fresh = await repaint(app, restored.webContentsId);
    await expectMotif(
      (await pi.call("visual_inspect", { id: shown.id, screenshot: true })).png,
      fresh,
    );
  } finally {
    await sink.close();
    await app.close().catch(() => undefined);
    await rm(runtime, { recursive: true, force: true });
    await cleanup();
  }
});
