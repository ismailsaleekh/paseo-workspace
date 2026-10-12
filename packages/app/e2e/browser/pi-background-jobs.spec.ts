// Supervisor-owned native jobs oracle. Real browser, daemon, Pi and package; inference is scripted.
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
  chmod,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";
import type { Locator, Page } from "@playwright/test";
import { test as base, expect } from "../support/fixtures";

const repository = path.resolve(__dirname, "../../../..");
const packageRoot = process.env.PASEO_BG_ORACLE_PACKAGE;
if (!packageRoot || !path.isAbsolute(packageRoot)) {
  throw new Error(
    "PASEO_BG_ORACLE_PACKAGE must name the independently hash-verified package input",
  );
}
interface OracleHome {
  root: string;
  agentDir: string;
  trace: string;
  gate: string;
  childPath: string;
}
const test = base.extend<object, { bgHome: OracleHome }>({
  bgHome: [
    async ({ browserName }, provide) => {
      const root = await mkdtemp(path.join(tmpdir(), `paseo-bg-${browserName}-`));
      const agentDir = path.join(root, "pi");
      await mkdir(agentDir);
      const gate = path.join(root, "hold-gate");
      await writeFile(gate, "closed");
      const bin = path.join(root, "bin");
      await mkdir(bin);
      const child = path.join(bin, "pi");
      await writeFile(
        child,
        await readFile(path.join(repository, "qa/pi-background-jobs/delegate-child.cjs")),
      );
      await chmod(child, 0o700);
      const inheritedPath = process.env.PATH;
      if (!inheritedPath) throw new Error("Fixture PATH is missing");
      const childPath = `${bin}${path.delimiter}${inheritedPath}`;
      try {
        await provide({
          root,
          agentDir,
          trace: path.join(root, "requests.jsonl"),
          gate,
          childPath,
        });
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
    { scope: "worker" },
  ],
  e2eDaemonEnvironment: [
    async ({ bgHome }, provide) => {
      await provide({
        HOME: bgHome.root,
        PI_CODING_AGENT_DIR: bgHome.agentDir,
        PI_WORKSPACE_ORACLE_TRACE: bgHome.trace,
        PI_BG_ORACLE_GATE: bgHome.gate,
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
    async ({ bgHome }, provide) => {
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
                HOME: bgHome.root,
                PI_CODING_AGENT_DIR: bgHome.agentDir,
                PI_WORKSPACE_ORACLE_TRACE: bgHome.trace,
                PI_BG_ORACLE_GATE: bgHome.gate,
                PATH: bgHome.childPath,
                PI_OFFLINE: "1",
                PI_TELEMETRY: "0",
              },
              command: [
                "/usr/local/bin/pi",
                "--no-extensions",
                "--no-skills",
                "--no-prompt-templates",
                "--no-context-files",
                "--offline",
                "--tools",
                "bg_run,bg_status,bg_logs,bg_kill,bg_result,bg_delegate",
                "-e",
                path.join(packageRoot, "dist/extensions/background-tasks.js"),
                "-e",
                path.join(repository, "qa/pi-background-jobs/scripted-provider.mjs"),
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

const entry = z.object({ type: z.string(), message: z.unknown().optional() });
const message = z.object({ role: z.string() });
const launch = z.object({
  role: z.literal("toolResult"),
  toolName: z.enum(["bg_run", "bg_delegate"]),
  isError: z.literal(false),
  details: z.object({
    task: z.object({
      id: z.string(),
      name: z.string(),
      command: z.string(),
      outputPath: z.string().startsWith(".pi/tasks/"),
      pid: z.number().int().positive(),
    }),
  }),
});
type Task = z.infer<typeof launch>["details"]["task"];
async function tasks(
  home: OracleHome,
  cwd: string,
  toolName: "bg_run" | "bg_delegate" = "bg_run",
): Promise<Task[]> {
  const expected = await realpath(cwd);
  const files = await readdir(path.join(home.agentDir, "sessions"), { recursive: true });
  const found: Task[] = [];
  for (const file of files) {
    if (!file.endsWith(".jsonl")) continue;
    const lines = (await readFile(path.join(home.agentDir, "sessions", file), "utf8"))
      .trim()
      .split("\n");
    const header = z.object({ cwd: z.string() }).parse(JSON.parse(lines[0] ?? "null"));
    if (header.cwd !== cwd && header.cwd !== expected) continue;
    for (const line of lines.slice(1)) {
      const parsed = entry.parse(JSON.parse(line));
      if (parsed.type !== "message" || message.parse(parsed.message).role !== "toolResult")
        continue;
      const result = launch.parse(parsed.message);
      if (result.toolName === toolName) found.push(result.details.task);
    }
  }
  return found;
}
async function requestCount(home: OracleHome): Promise<number> {
  return (await readFile(home.trace, "utf8")).trim().split("\n").length;
}
async function draft(input: Locator): Promise<string> {
  return input.evaluate((element) =>
    element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement
      ? element.value
      : (element.textContent ?? ""),
  );
}
async function confirm(page: Page, control: Locator, allow: boolean): Promise<void> {
  const pending = page.waitForEvent("dialog");
  const clicked = control.click();
  const dialog = await pending;
  expect(dialog.type()).toBe("confirm");
  if (allow) await dialog.accept();
  else await dialog.dismiss();
  await clicked;
}
async function metadata(cwd: string, task: Task): Promise<unknown> {
  return JSON.parse(
    await readFile(path.join(cwd, task.outputPath.replace(/\.output$/, ".json")), "utf8"),
  );
}
type OutcomeSnapshot = { exists: false } | { exists: true; text: string; modified: bigint };
async function outcomeSnapshot(file: string): Promise<OutcomeSnapshot> {
  try {
    const text = await readFile(file, "utf8");
    const modified = (await stat(file, { bigint: true })).mtimeNs;
    return { exists: true, text, modified };
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return { exists: false };
    throw error;
  }
}
const status = z.object({ status: z.string(), pid: z.number().optional() });

for (const size of [
  { name: "desktop", width: 1440, height: 1000 },
  { name: "compact", width: 393, height: 851 },
]) {
  test(`${size.name}: jobs stay visible, inspectable and controllable without model prompts`, async ({
    page,
    e2eWorkerClient,
    bgHome,
  }) => {
    test.setTimeout(180000);
    await page.setViewportSize(size);
    const cwd = await mkdtemp(path.join(tmpdir(), "paseo-bg-project-"));
    const created = await e2eWorkerClient.createWorkspace({
      source: { kind: "directory", path: cwd },
      title: "Background jobs acceptance",
    });
    if (!created.workspace) throw new Error(created.error ?? "Missing workspace");
    const workspace = created.workspace;
    let second: Page | undefined;
    try {
      const agent = await e2eWorkerClient.createAgent({
        provider: "pi",
        model: "pi-background-oracle/scripted",
        thinkingOptionId: "off",
        cwd,
        workspaceId: workspace.id,
        title: "Native background jobs",
      });
      const serverId = process.env.E2E_SERVER_ID;
      if (!serverId) throw new Error("Missing isolated server ID");
      const route = `/h/${encodeURIComponent(serverId)}/agent/${encodeURIComponent(agent.id)}`;
      await page.goto(route);
      await expect(page.getByTestId("message-input-root")).toBeVisible();
      const command = `node -e ${JSON.stringify("let n=0; console.log('visible Unicode α'); setInterval(()=>console.log('line '+(++n)),40)")}`;
      await e2eWorkerClient.sendAgentMessage(
        agent.id,
        `oracle-call:${JSON.stringify({
          name: "bg_run",
          arguments: {
            name: "Streaming check",
            command,
            isAgent: false,
            notifyOnCompletion: false,
            triggerOnCompletion: false,
          },
        })}`,
      );
      const finished = await e2eWorkerClient.waitForFinish(agent.id, 30000);
      expect(finished.status, JSON.stringify(finished)).toBe("idle");
      const launched = await tasks(bgHome, cwd);
      expect(launched).toHaveLength(1);
      const task = launched[0];
      if (!task) throw new Error("Real Pi did not persist its bg_run receipt");
      expect(status.parse(await metadata(cwd, task)).status).toBe("running");
      const promptsBefore = await requestCount(bgHome);
      const input = page
        .getByTestId("message-input-root")
        .locator('textarea, [contenteditable="true"]')
        .first();
      await input.fill("Draft remains private");
      const trigger = page.getByTestId("bg-jobs-trigger");
      await expect(trigger).toBeVisible();
      await expect(trigger).toContainText("running");
      await trigger.click();
      await expect(page.getByTestId("bg-jobs-panel")).toBeVisible();
      await page.getByTestId(`bg-job-${task.id}`).click();
      const detail = page.getByTestId("bg-job-detail");
      await expect(detail).toContainText("Streaming check");
      await expect(detail).toContainText(task.id);
      await expect(detail).toContainText("Unavailable");
      const logs = page.getByTestId("bg-job-logs");
      await expect(logs).toContainText("visible Unicode α");
      await page.getByTestId("bg-job-pause").click();
      const frozen = await logs.textContent();
      await expect
        .poll(async () => (await readFile(path.join(cwd, task.outputPath), "utf8")).length)
        .toBeGreaterThan((frozen ?? "").length + 100);
      await expect(logs).toHaveText(frozen ?? "");
      await page.getByTestId("bg-job-follow").click();
      await expect.poll(() => logs.textContent()).not.toBe(frozen);
      await confirm(page, page.getByTestId("bg-job-stop"), false);
      expect(status.parse(await metadata(cwd, task)).status).toBe("running");
      expect(await draft(input)).toBe("Draft remains private");
      expect(await requestCount(bgHome)).toBe(promptsBefore);
      second = await page.context().newPage();
      await second.goto(route);
      await expect(second.getByTestId("bg-jobs-trigger")).toContainText("running");
      await confirm(page, page.getByTestId("bg-job-stop"), true);
      await expect(detail).toContainText(/stopped|killed/i);
      await expect(second.getByTestId("bg-jobs-trigger")).not.toContainText("running");
      expect(status.parse(await metadata(cwd, task)).status).toBe("killed");
      expect(await requestCount(bgHome)).toBe(promptsBefore);
      expect(await draft(input)).toBe("Draft remains private");
      await page.reload();
      await expect(page.getByTestId("bg-jobs-trigger")).toBeVisible();
      await page.getByTestId("bg-jobs-trigger").click();
      await page.getByTestId(`bg-job-${task.id}`).click();
      await expect(page.getByTestId("bg-job-logs")).toContainText("visible Unicode α");
      expect(await requestCount(bgHome)).toBe(promptsBefore);
      await e2eWorkerClient.refreshAgent(agent.id);
      await expect(page.getByTestId("bg-job-stop")).not.toBeVisible();
      await expect(page.getByTestId("bg-jobs-trigger")).not.toContainText("running");
      expect(await requestCount(bgHome)).toBe(promptsBefore);
      await e2eWorkerClient.sendAgentMessage(
        agent.id,
        `oracle-call:${JSON.stringify({ name: "bg_run", arguments: { name: "After runtime reload", command: "sleep 90", isAgent: false, notifyOnCompletion: false, triggerOnCompletion: false } })}`,
      );
      const resumed = await e2eWorkerClient.waitForFinish(agent.id, 30000);
      expect(resumed.status, JSON.stringify(resumed)).toBe("idle");
      await expect(page.getByTestId("bg-jobs-trigger")).toContainText("running");
      expect(await requestCount(bgHome)).toBe(promptsBefore + 2);
    } finally {
      if (second) await second.close();
      await e2eWorkerClient.removeProject(workspace.projectId);
      await rm(cwd, { recursive: true, force: true });
    }
  });
}

const storedTask = z.object({
  id: z.string(),
  name: z.string(),
  command: z.string(),
  outputPath: z.string(),
  status: z.string(),
  notifyOnCompletion: z.boolean(),
  triggerOnCompletion: z.boolean(),
  isAgent: z.boolean(),
});
async function storedTasks(cwd: string): Promise<z.infer<typeof storedTask>[]> {
  const root = path.join(cwd, ".pi/tasks");
  const files = await readdir(root, { recursive: true });
  const found: z.infer<typeof storedTask>[] = [];
  for (const file of files) {
    if (file.endsWith(".json"))
      found.push(storedTask.parse(JSON.parse(await readFile(path.join(root, file), "utf8"))));
  }
  return found;
}

test("rerun is one new job, stop-all uses the confirmed selection, and log failures recover visibly", async ({
  page,
  e2eWorkerClient,
  bgHome,
}) => {
  test.setTimeout(180000);
  await page.setViewportSize({ width: 1440, height: 1000 });
  const cwd = await mkdtemp(path.join(tmpdir(), "paseo-bg-controls-"));
  const created = await e2eWorkerClient.createWorkspace({
    source: { kind: "directory", path: cwd },
    title: "Job controls acceptance",
  });
  if (!created.workspace) throw new Error(created.error ?? "Missing workspace");
  const workspace = created.workspace;
  try {
    const agent = await e2eWorkerClient.createAgent({
      provider: "pi",
      model: "pi-background-oracle/scripted",
      thinkingOptionId: "off",
      cwd,
      workspaceId: workspace.id,
      title: "Background controls",
    });
    const serverId = process.env.E2E_SERVER_ID;
    if (!serverId) throw new Error("Missing isolated server ID");
    await page.goto(`/h/${encodeURIComponent(serverId)}/agent/${encodeURIComponent(agent.id)}`);
    await expect(page.getByTestId("message-input-root")).toBeVisible();
    const start = async (name: string, command: string): Promise<Task> => {
      await e2eWorkerClient.sendAgentMessage(
        agent.id,
        `oracle-call:${JSON.stringify({ name: "bg_run", arguments: { name, command, isAgent: false, notifyOnCompletion: false, triggerOnCompletion: false } })}`,
      );
      const finished = await e2eWorkerClient.waitForFinish(agent.id, 30000);
      expect(finished.status, JSON.stringify(finished)).toBe("idle");
      const task = (await tasks(bgHome, cwd)).at(-1);
      if (!task) throw new Error("Missing actual launch receipt");
      return task;
    };
    const failureScript =
      "require('node:fs').appendFileSync('run-count.txt','x'); console.error('FAILURE_SENTINEL'); process.exit(7)";
    const failed = await start("Failing check", `node -e ${JSON.stringify(failureScript)}`);
    await expect.poll(async () => status.parse(await metadata(cwd, failed)).status).toBe("failed");
    await expect(page.getByTestId("bg-jobs-trigger")).toBeVisible();
    await page.getByTestId("bg-jobs-trigger").click();
    await page.getByTestId(`bg-job-${failed.id}`).click();
    await expect(page.getByTestId("bg-job-logs")).toContainText("FAILURE_SENTINEL");
    const beforeRerun = await requestCount(bgHome);
    await confirm(page, page.getByTestId("bg-job-rerun"), false);
    expect(await readFile(path.join(cwd, "run-count.txt"), "utf8")).toBe("x");
    await confirm(page, page.getByTestId("bg-job-rerun"), true);
    await expect.poll(() => readFile(path.join(cwd, "run-count.txt"), "utf8")).toBe("xx");
    const copies = (await storedTasks(cwd)).filter((task) => task.name === failed.name);
    expect(copies).toHaveLength(2);
    const rerun = copies.find((task) => task.id !== failed.id);
    if (!rerun) throw new Error("UI rerun did not create a new identity");
    expect(rerun.command).toBe(failed.command);
    expect(rerun.notifyOnCompletion).toBe(true);
    expect(rerun.triggerOnCompletion).toBe(false);
    expect(await requestCount(bgHome)).toBe(beforeRerun);
    await page.getByTestId("bg-job-back").click();
    const first = await start("First selected job", "sleep 90");
    const second = await start("Second selected job", "sleep 90");
    await expect(page.getByTestId(`bg-job-${first.id}`)).toBeVisible();
    await expect(page.getByTestId(`bg-job-${second.id}`)).toBeVisible();
    const pending = page.waitForEvent("dialog");
    const clicked = page.getByTestId("bg-jobs-stop-all").click();
    const dialog = await pending;
    expect(dialog.type()).toBe("confirm");
    const later = await start("Started after confirmation opened", "sleep 90");
    const beforeStop = await requestCount(bgHome);
    await dialog.accept();
    await clicked;
    await expect.poll(async () => status.parse(await metadata(cwd, first)).status).toBe("killed");
    await expect.poll(async () => status.parse(await metadata(cwd, second)).status).toBe("killed");
    expect(status.parse(await metadata(cwd, later)).status).toBe("running");
    expect(await requestCount(bgHome)).toBe(beforeStop);
    await page.getByTestId(`bg-job-${later.id}`).click();
    const output = path.join(cwd, later.outputPath);
    await rm(output);
    await expect(page.getByTestId("bg-job-error")).toBeVisible();
    await expect(page.getByTestId("bg-job-error")).toContainText(/log|output|file/i);
    await writeFile(output, "RECOVERED_OUTPUT");
    await page.getByTestId("bg-job-retry").click();
    await expect(page.getByTestId("bg-job-logs")).toContainText("RECOVERED_OUTPUT");
    await expect(page.getByTestId("bg-job-error")).not.toBeVisible();
    expect(await requestCount(bgHome)).toBe(beforeStop);
    await confirm(page, page.getByTestId("bg-job-stop"), true);
    await expect.poll(async () => status.parse(await metadata(cwd, later)).status).toBe("killed");
    expect(await readFile(path.join(cwd, "run-count.txt"), "utf8")).toBe("xx");
  } finally {
    await e2eWorkerClient.removeProject(workspace.projectId);
    await rm(cwd, { recursive: true, force: true });
  }
});

test("inspection and Stop remain available during a parent turn without aborting or prompting it", async ({
  page,
  e2eWorkerClient,
  bgHome,
}) => {
  test.setTimeout(120000);
  await page.setViewportSize({ width: 1440, height: 1000 });
  const cwd = await mkdtemp(path.join(tmpdir(), "paseo-bg-busy-"));
  const created = await e2eWorkerClient.createWorkspace({
    source: { kind: "directory", path: cwd },
    title: "Busy parent acceptance",
  });
  if (!created.workspace) throw new Error(created.error ?? "Missing workspace");
  const workspace = created.workspace;
  try {
    const agent = await e2eWorkerClient.createAgent({
      provider: "pi",
      model: "pi-background-oracle/scripted",
      thinkingOptionId: "off",
      cwd,
      workspaceId: workspace.id,
      title: "Active parent",
    });
    const serverId = process.env.E2E_SERVER_ID;
    if (!serverId) throw new Error("Missing isolated server ID");
    await page.goto(`/h/${encodeURIComponent(serverId)}/agent/${encodeURIComponent(agent.id)}`);
    await expect(page.getByTestId("message-input-root")).toBeVisible();
    await e2eWorkerClient.sendAgentMessage(
      agent.id,
      `oracle-call:${JSON.stringify({ name: "bg_run", arguments: { name: "Independent long job", command: "printf busy-output; sleep 90", isAgent: false, notifyOnCompletion: false, triggerOnCompletion: false } })}`,
    );
    const idle = await e2eWorkerClient.waitForFinish(agent.id, 30000);
    expect(idle.status, JSON.stringify(idle)).toBe("idle");
    const task = (await tasks(bgHome, cwd))[0];
    if (!task) throw new Error("Missing real background task");
    await expect(page.getByTestId("bg-jobs-trigger")).toBeVisible();
    await page.getByTestId("bg-jobs-trigger").click();
    await page.getByTestId(`bg-job-${task.id}`).click();
    await expect(page.getByTestId("bg-job-logs")).toContainText("busy-output");
    await writeFile(bgHome.gate, "closed");
    const beforeHold = await requestCount(bgHome);
    await Promise.all([
      e2eWorkerClient.waitForAgentUpsert(agent.id, (state) => state.status === "running", 15000),
      e2eWorkerClient.sendAgentMessage(agent.id, "oracle-hold:background controls"),
    ]);
    await expect.poll(() => requestCount(bgHome)).toBe(beforeHold + 1);
    const prompts = beforeHold + 1;
    await page.getByTestId("bg-job-pause").click();
    await page.getByTestId("bg-job-follow").click();
    await confirm(page, page.getByTestId("bg-job-stop"), true);
    await expect.poll(async () => status.parse(await metadata(cwd, task)).status).toBe("killed");
    z.object({ agent: z.object({ status: z.literal("running") }) }).parse(
      await e2eWorkerClient.fetchAgent({ agentId: agent.id }),
    );
    expect(await requestCount(bgHome)).toBe(prompts);
    await writeFile(bgHome.gate, "open");
    const finished = await e2eWorkerClient.waitForFinish(agent.id, 30000);
    expect(finished.status, JSON.stringify(finished)).toBe("idle");
    expect(await requestCount(bgHome)).toBe(prompts);
  } finally {
    await writeFile(bgHome.gate, "open");
    await e2eWorkerClient.removeProject(workspace.projectId);
    await rm(cwd, { recursive: true, force: true });
  }
});

test("verified delegate results are readable without model calls or file writes and reject corruption", async ({
  page,
  e2eWorkerClient,
  bgHome,
}) => {
  test.setTimeout(180000);
  const cwd = await mkdtemp(path.join(tmpdir(), "paseo-bg-result-"));
  const created = await e2eWorkerClient.createWorkspace({
    source: { kind: "directory", path: cwd },
    title: "Verified result acceptance",
  });
  if (!created.workspace) throw new Error(created.error ?? "Missing workspace");
  const workspace = created.workspace;
  try {
    const agent = await e2eWorkerClient.createAgent({
      provider: "pi",
      model: "pi-background-oracle/scripted",
      thinkingOptionId: "off",
      cwd,
      workspaceId: workspace.id,
      title: "Verified background result",
    });
    const serverId = process.env.E2E_SERVER_ID;
    if (!serverId) throw new Error("Missing isolated server ID");
    const route = `/h/${encodeURIComponent(serverId)}/agent/${encodeURIComponent(agent.id)}`;
    await page.goto(route);
    await expect(page.getByTestId("message-input-root")).toBeVisible();
    await e2eWorkerClient.sendAgentMessage(
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
    const finished = await e2eWorkerClient.waitForFinish(agent.id, 30000);
    expect(finished.status, JSON.stringify(finished)).toBe("idle");
    const task = (await tasks(bgHome, cwd, "bg_delegate"))[0];
    if (!task) throw new Error("Actual Pi did not launch the delegate");
    await expect.poll(async () => status.parse(await metadata(cwd, task)).status).toBe("completed");
    const facts = z
      .object({ delegate: z.object({ artifactDirAbs: z.string() }) })
      .parse(await metadata(cwd, task));
    const outcome = path.join(facts.delegate.artifactDirAbs, "outcome.json");
    const before = await outcomeSnapshot(outcome);
    const prompts = await requestCount(bgHome);
    await expect(page.getByTestId("bg-jobs-trigger")).toBeVisible();
    await page.getByTestId("bg-jobs-trigger").click();
    await page.getByTestId(`bg-job-${task.id}`).click();
    await expect(page.getByTestId("bg-job-detail")).toContainText(/delegate/i);
    await expect(page.getByTestId("bg-job-rerun")).not.toBeVisible();
    await page.getByTestId("bg-job-result-open").click();
    await expect(page.getByTestId("bg-job-result")).toHaveText(
      "DELEGATE VERIFIED ANSWER: UI result sentinel",
    );
    expect(await outcomeSnapshot(outcome)).toEqual(before);
    expect(await requestCount(bgHome)).toBe(prompts);
    await writeFile(path.join(facts.delegate.artifactDirAbs, "result.json"), "{}");
    await page.reload();
    await page.getByTestId("bg-jobs-trigger").click();
    await page.getByTestId(`bg-job-${task.id}`).click();
    await page.getByTestId("bg-job-result-open").click();
    await expect(page.getByTestId("bg-job-error")).toBeVisible();
    await expect(page.getByTestId("bg-job-error")).toContainText(/verif|integrity|result/i);
    await expect(page.getByTestId("bg-job-result")).not.toBeVisible();
    expect(await requestCount(bgHome)).toBe(prompts);
    expect(await outcomeSnapshot(outcome)).toEqual(before);
  } finally {
    await e2eWorkerClient.removeProject(workspace.projectId);
    await rm(cwd, { recursive: true, force: true });
  }
});
