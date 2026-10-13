// Supervisor-owned UR-01 acceptance. Real app, daemon, Pi and visual bridge; inference is scripted.
import { mkdtemp, mkdir, readFile, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { test as base, expect } from "../support/fixtures";
const repository = path.resolve(__dirname, "../../../..");
interface OracleHome {
  root: string;
  agentDir: string;
  trace: string;
}
const test = base.extend<object, { libraryHome: OracleHome }>({
  libraryHome: [
    async ({ browserName }, use) => {
      const root = await mkdtemp(path.join(tmpdir(), `paseo-library-${browserName}-`));
      const agentDir = path.join(root, "pi");
      await mkdir(agentDir);
      try {
        await use({ root, agentDir, trace: path.join(root, "requests.jsonl") });
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
    { scope: "worker" },
  ],
  e2eDaemonEnvironment: [
    async ({ libraryHome }, use) => {
      await use({
        HOME: libraryHome.root,
        PI_CODING_AGENT_DIR: libraryHome.agentDir,
        PI_WORKSPACE_ORACLE_TRACE: libraryHome.trace,
        PI_OFFLINE: "1",
        PI_TELEMETRY: "0",
        PI_SKIP_VERSION_CHECK: "1",
        PASEO_DICTATION_ENABLED: "0",
        PASEO_VOICE_MODE_ENABLED: "0",
        PASEO_LOCAL_SPEECH_AUTO_DOWNLOAD: "0",
      });
    },
    { scope: "worker" },
  ],
  e2eDaemonConfig: [
    async ({ libraryHome }, use) => {
      await use({
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
                HOME: libraryHome.root,
                PI_CODING_AGENT_DIR: libraryHome.agentDir,
                PI_WORKSPACE_ORACLE_TRACE: libraryHome.trace,
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
const header = z.object({ type: z.literal("session"), cwd: z.string() });
const entry = z.object({ type: z.string(), message: z.unknown().optional() });
const role = z.object({ role: z.string() });
const result = z.object({
  role: z.literal("toolResult"),
  toolName: z.string(),
  isError: z.boolean(),
  details: z.unknown(),
});
const artifact = z.object({
  id: z.string(),
  revision: z.number().int().positive(),
  status: z.enum(["stored", "rendered"]),
});
async function results(home: OracleHome, cwd: string) {
  const expected = await realpath(cwd);
  const found: z.infer<typeof result>[] = [];
  for (const file of await readdir(path.join(home.agentDir, "sessions"), { recursive: true })) {
    if (!file.endsWith(".jsonl")) continue;
    const lines = (await readFile(path.join(home.agentDir, "sessions", file), "utf8"))
      .trim()
      .split("\n");
    const identity = header.parse(JSON.parse(lines[0] ?? "null"));
    if (identity.cwd !== expected && identity.cwd !== cwd) continue;
    for (const line of lines.slice(1)) {
      const parsed = entry.parse(JSON.parse(line));
      if (parsed.type === "message" && role.parse(parsed.message).role === "toolResult")
        found.push(result.parse(parsed.message));
    }
  }
  return found;
}
async function requestCount(home: OracleHome) {
  return (await readFile(home.trace, "utf8")).trim().split("\n").length;
}
for (const size of [
  { name: "wide", width: 1440, height: 950 },
  { name: "compact", width: 393, height: 851 },
]) {
  test(`${size.name}: real sidebar browses drawings and history without prompts, overlay or data loss`, async ({
    page,
    e2eWorkerClient,
    libraryHome,
  }, testInfo) => {
    test.setTimeout(180000);
    await page.setViewportSize(size);
    const cwd = await mkdtemp(path.join(tmpdir(), "paseo-library-project-"));
    const created = await e2eWorkerClient.createWorkspace({
      source: { kind: "directory", path: cwd },
      title: "Library review",
    });
    if (!created.workspace) throw new Error(created.error ?? "No workspace");
    const workspace = created.workspace;
    let agentId: string | null = null;
    try {
      const agent = await e2eWorkerClient.createAgent({
        provider: "pi",
        model: "pi-workspace-oracle/scripted",
        thinkingOptionId: "off",
        cwd,
        workspaceId: workspace.id,
        title: "Library review",
      });
      agentId = agent.id;
      const serverId = process.env.E2E_SERVER_ID;
      if (!serverId) throw new Error("Missing isolated server ID");
      await page.goto(`/h/${encodeURIComponent(serverId)}/agent/${encodeURIComponent(agent.id)}`);
      const composer = page.getByTestId("message-input-root");
      await expect(composer).toBeVisible();
      let count = 0;
      async function call(name: string, args: Record<string, unknown>) {
        await e2eWorkerClient.sendAgentMessage(
          agent.id,
          `oracle-call:${JSON.stringify({ name, arguments: args })}`,
        );
        expect((await e2eWorkerClient.waitForFinish(agent.id, 30000)).status).toBe("idle");
        const stored = await results(libraryHome, cwd);
        expect(stored).toHaveLength(++count);
        const latest = stored.at(-1);
        if (!latest) throw new Error("Missing real Pi result");
        expect(latest.toolName).toBe(name);
        expect(latest.isError, JSON.stringify(latest.details)).toBe(false);
        return latest.details;
      }
      const html = await readFile(
        path.join(repository, "qa/pi-workspace/fixtures/interactive.html"),
        "utf8",
      );
      const first = artifact.parse(
        await call("visual_present", { mode: "new", title: "Power explorer", html }),
      );
      // A prepared drawing is retained even when its native viewer is collapsed.
      await expect(page.getByTestId("pi-visuals-toggle")).toBeVisible();
      await page.getByTestId("pi-visuals-toggle").click();
      const sidebar = page.getByTestId("pi-visuals-sidebar");
      await expect(sidebar).toBeVisible();
      const box = await sidebar.boundingBox();
      if (!box) throw new Error("Sidebar has no geometry");
      if (size.name === "wide") {
        const chat = await composer.boundingBox();
        if (!chat) throw new Error("Wide sidebar hid chat");
        expect(box.x).toBeGreaterThanOrEqual(chat.x + chat.width - 1);
      } else {
        await expect(composer).not.toBeVisible();
        expect(box.width).toBeLessThanOrEqual(size.width);
      }
      const drawing = page.frameLocator('[data-testid="pi-workspace-document"]');
      await expect(drawing.locator("#result")).toHaveText("4");
      await drawing.locator("#value").fill("5");
      await expect(drawing.locator("#result")).toHaveText("25");
      const cube = html
        .replace("value * value", "value * value * value")
        .replace("square of the input", "cube of the input");
      const updated = artifact.parse(
        await call("visual_update", { id: first.id, revision: first.revision, html: cube }),
      );
      await expect(drawing.locator("#result")).toHaveText("125");
      const other = artifact.parse(
        await call("visual_present", {
          mode: "new",
          title: "Another drawing",
          html: "<h1 id='other'>A separate drawing</h1>",
        }),
      );
      await expect(drawing.locator("#other")).toHaveText("A separate drawing");
      const before = await requestCount(libraryHome);
      await page.getByTestId(`pi-visual-library-item-${first.id}`).click();
      await expect(drawing.locator("#result")).toHaveText("125");
      await page.getByTestId("pi-visual-versions").click();
      await page.getByTestId("pi-visual-version-1").click();
      await expect(drawing.locator("#result")).toHaveText("25");
      await expect(page.getByTestId("pi-visual-history-status")).toContainText("1");
      // Historical interaction is either blocked by the host or ephemeral; never change latest.
      await page.getByTestId("pi-visual-latest").click();
      await expect(drawing.locator("#result")).toHaveText("125");
      await page.getByTestId(`pi-visual-library-item-${other.id}`).click();
      await expect(drawing.locator("#other")).toHaveText("A separate drawing");
      await page.getByTestId(`pi-visual-library-item-${first.id}`).click();
      await expect(drawing.locator("#result")).toHaveText("125");
      await page.getByTestId("pi-visuals-close").click();
      await expect(sidebar).not.toBeVisible();
      await expect(composer).toBeVisible();
      await page.getByTestId("pi-visuals-toggle").click();
      await expect(drawing.locator("#result")).toHaveText("125");
      expect(await requestCount(libraryHome)).toBe(before);
      const listed = z
        .object({ items: z.array(z.object({ id: z.string(), revision: z.number() })) })
        .parse(await call("visual_list", {}));
      expect(listed.items.find((x) => x.id === first.id)?.revision).toBe(updated.revision);
      await page.screenshot({ path: testInfo.outputPath("library.png") });
    } finally {
      if (agentId) await e2eWorkerClient.archiveAgent(agentId);
      await e2eWorkerClient.removeProject(workspace.projectId);
      await rm(cwd, { recursive: true, force: true });
    }
  });
}
