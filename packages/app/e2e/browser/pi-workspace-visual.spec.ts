// Judge-owned proposed Root oracle. Implementation workers must not modify this file.
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { test as base, expect } from "../support/fixtures";
import type { SeedDaemonClient } from "../support/helpers/seed-client";

const repository = path.resolve(__dirname, "../../../..");
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
      const root = await mkdtemp(path.join(tmpdir(), `paseo-visual-${browserName}-oracle-`));
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
type VisualTool =
  | "visual_present"
  | "visual_update"
  | "visual_act"
  | "visual_inspect"
  | "visual_list";

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

interface CallToolInput {
  client: SeedDaemonClient;
  agentId: string;
  readResults: OracleFixtures["readPiResults"];
  cwd: string;
  name: VisualTool;
  args: { [key: string]: JsonValue };
  expectedCount: number;
  error?: boolean;
}
async function callTool(input: CallToolInput): Promise<unknown> {
  await input.client.sendAgentMessage(
    input.agentId,
    `oracle-call:${JSON.stringify({ name: input.name, arguments: input.args })}`,
  );
  const finish = await input.client.waitForFinish(input.agentId, 30000);
  expect(finish.status).toBe("idle");
  const results = await input.readResults(input.cwd);
  expect(results).toHaveLength(input.expectedCount);
  const result = results.at(-1);
  if (!result) throw new Error("No actual Pi tool result was persisted");
  expect(result.toolName).toBe(input.name);
  expect(result.isError, JSON.stringify({ tool: result.toolName, details: result.details })).toBe(
    input.error === true,
  );
  return result.details;
}

interface RequestText {
  role: string;
  text: string;
}
async function lastRequestTexts(trace: string): Promise<RequestText[]> {
  const lines = (await readFile(trace, "utf8")).trim().split("\n");
  const parsed: unknown = JSON.parse(lines.at(-1) ?? "null");
  const request = z
    .object({
      messages: z.array(
        z.object({
          role: z.string(),
          content: z.union([
            z.string(),
            z.array(z.object({ type: z.string(), text: z.string().optional() })),
          ]),
        }),
      ),
    })
    .parse(parsed);
  return request.messages.map((message) => {
    const text =
      typeof message.content === "string"
        ? message.content
        : message.content
            .filter((part) => part.type === "text")
            .map((part) => {
              if (part.text === undefined) throw new Error("Malformed text content");
              return part.text;
            })
            .join("\n");
    return { role: message.role, text };
  });
}

const artifactSchema = z.object({
  id: z.string().min(1),
  revision: z.number().int().positive(),
  status: z.literal("rendered"),
});
const inspectionSchema = z.object({
  id: z.string(),
  revision: z.number().int().positive(),
  state: z.object({ value: z.number() }),
  selection: z.object({ id: z.literal("result"), text: z.string() }).nullable(),
});

// This checks the real browser/app feedback loop. It does not certify Electron isolation or a physical phone.
test("real Pi controls and inspects a persistent interactive explanation", async ({
  page,
  e2eWorkerClient,
  piOracleHome,
  readPiResults,
}, testInfo) => {
  test.setTimeout(180000);
  z.object({ features: z.object({ piWorkspace: z.literal(true) }) }).parse(
    e2eWorkerClient.getLastServerInfoMessage(),
  );
  const cwd = await mkdtemp(path.join(tmpdir(), "paseo-visual-project-"));
  const created = await e2eWorkerClient.createWorkspace({
    source: { kind: "directory", path: cwd },
    title: "Visual oracle",
  });
  if (!created.workspace) throw new Error(created.error ?? "Workspace creation failed");
  const workspace = created.workspace;
  let agentId: string | null = null;
  try {
    const agent = await e2eWorkerClient.createAgent({
      provider: "pi",
      model: "pi-workspace-oracle/scripted",
      thinkingOptionId: "off",
      cwd,
      workspaceId: workspace.id,
      title: "Interactive explanation oracle",
    });
    agentId = agent.id;
    const serverId = process.env.E2E_SERVER_ID;
    if (!serverId) throw new Error("The isolated server ID is missing");
    await page.goto(`/h/${encodeURIComponent(serverId)}/agent/${encodeURIComponent(agent.id)}`);
    await expect(page.getByTestId("message-input-root")).toBeVisible();
    const html = await readFile(
      path.join(repository, "qa/pi-workspace/fixtures/interactive.html"),
      "utf8",
    );
    let count = 0;
    const call = (name: VisualTool, args: { [key: string]: JsonValue }, error = false) =>
      callTool({
        client: e2eWorkerClient,
        agentId: agent.id,
        readResults: readPiResults,
        cwd,
        name,
        args,
        expectedCount: ++count,
        error,
      });
    const preparedFile = path.join(cwd, "explanation.html");
    await writeFile(preparedFile, html, "utf8");
    const shown = artifactSchema.parse(
      await call("visual_present", { mode: "new", title: "Power explorer", file: preparedFile }),
    );
    const visual = page.frameLocator('[data-testid="pi-workspace-document"]');
    await expect(visual.locator("#result")).toHaveText("4");
    const requestsBefore = (await readFile(piOracleHome.trace, "utf8")).trim().split("\n").length;
    await visual.locator("#value").fill("3");
    await expect(visual.locator("#result")).toHaveText("9");
    await visual.getByRole("button", { name: "Discuss this result" }).click();
    await expect(visual.locator("#selected")).toHaveText("Selected: result");
    expect((await readFile(piOracleHome.trace, "utf8")).trim().split("\n").length).toBe(
      requestsBefore,
    );
    const followup = "oracle-text:FOLLOWUP_AFTER_DRAG";
    await e2eWorkerClient.sendAgentMessage(agent.id, followup);
    expect((await e2eWorkerClient.waitForFinish(agent.id, 30000)).status).toBe("idle");
    const texts = await lastRequestTexts(piOracleHome.trace);
    expect(texts.some((message) => message.role === "user" && message.text === followup)).toBe(
      true,
    );
    const prefix = "<pi-workspace-context>";
    const suffix = "</pi-workspace-context>";
    const contexts = texts.filter(
      (message) => message.text.startsWith(prefix) && message.text.endsWith(suffix),
    );
    expect(contexts).toHaveLength(1);
    const context = contexts[0];
    if (!context) throw new Error("No separate visual context reached the actual Pi model request");
    const contextData: unknown = JSON.parse(
      context.text.slice(prefix.length, -suffix.length).trim(),
    );
    const supplied = z
      .object({
        id: z.string(),
        state: z.object({ value: z.number() }),
        selection: z.object({ id: z.string(), text: z.string() }),
      })
      .parse(contextData);
    expect(supplied).toEqual({
      id: shown.id,
      state: { value: 3 },
      selection: { id: "result", text: "9" },
    });
    const observed = inspectionSchema.parse(await call("visual_inspect", { id: shown.id }));
    expect(observed.id).toBe(shown.id);
    expect(observed.state.value).toBe(3);
    expect(observed.selection).toEqual({ id: "result", text: "9" });
    await call("visual_act", { id: shown.id, action: "setValue", value: { value: 5 } });
    await expect(visual.locator("#result")).toHaveText("25");
    await call("visual_act", { id: shown.id, action: "missingAction", value: {} }, true);
    await expect(visual.locator("#result")).toHaveText("25");
    const cube = html
      .replace("value * value", "value * value * value")
      .replace("square of the input", "cube of the input");
    const updated = artifactSchema.parse(
      await call("visual_update", { id: shown.id, revision: shown.revision, html: cube }),
    );
    expect(updated.id).toBe(shown.id);
    expect(updated.revision).toBe(shown.revision + 1);
    await expect(visual.locator("#result")).toHaveText("125");
    await call("visual_update", { id: shown.id, revision: shown.revision, html }, true);
    await expect(visual.locator("#result")).toHaveText("125");
    const listed = z
      .object({
        items: z.array(z.object({ id: z.string(), title: z.string(), revision: z.number() })),
      })
      .parse(await call("visual_list", {}));
    expect(listed.items).toEqual([
      { id: shown.id, title: "Power explorer", revision: updated.revision },
    ]);
    await page.reload();
    await expect(page.getByTestId("message-input-root")).toBeVisible();
    // The composer can mount before the independent visual subscription reconnects. Require the
    // saved visual to auto-restore before testing a tool call on that newly connected display.
    await expect(visual.locator("#result")).toHaveText("125", { timeout: 15_000 });
    await expect(visual.locator("#selected")).toHaveText("Selected: result");
    const reopened = artifactSchema.parse(
      await call("visual_present", { mode: "open", id: shown.id }),
    );
    expect(reopened.id).toBe(shown.id);
    expect(reopened.revision).toBe(updated.revision);
    await expect(visual.locator("#result")).toHaveText("125");
    await expect(visual.locator("#selected")).toHaveText("Selected: result");
    const restored = inspectionSchema.parse(await call("visual_inspect", { id: shown.id }));
    expect(restored.state.value).toBe(5);
    expect(restored.selection).toEqual({ id: "result", text: "125" });
    await page.screenshot({ path: testInfo.outputPath("visual-loop.png") });
  } finally {
    if (agentId) await e2eWorkerClient.archiveAgent(agentId);
    await e2eWorkerClient.removeProject(workspace.projectId);
    await rm(cwd, { recursive: true, force: true });
  }
});
