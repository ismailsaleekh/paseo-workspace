import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { z } from "zod";
import type { AgentSession, RpcClient } from "@earendil-works/pi-coding-agent";

export const packageRoot = fileURLToPath(new URL("../../", import.meta.url));
export const extensionPath = join(packageRoot, "extensions/workspace.ts");
export const providerPath = fileURLToPath(new URL("../fixtures/provider.ts", import.meta.url));
export const visualTools = [
  "visual_act",
  "visual_inspect",
  "visual_list",
  "visual_present",
  "visual_update",
];
/** Direct tools the package registers in the S1 phase: the five visual tools plus `speak`. */
export const packageTools = [...visualTools, "speak"].sort();
export const testId = "7e8e07d1-c3af-4b75-b61e-3ce2c2c8603a";
export const unavailableCalls = [
  { name: "visual_present", arguments: { mode: "new", title: "SDK example", html: "<p>test</p>" } },
  { name: "visual_update", arguments: { id: testId, revision: 1, html: "<p>changed</p>" } },
  { name: "visual_act", arguments: { id: testId, action: "pause" } },
  { name: "visual_inspect", arguments: { screenshot: true } },
  { name: "visual_list", arguments: {} },
  { name: "speak", arguments: { text: "Exact supplied words." } },
];
export interface IsolatedHome {
  root: string;
  cwd: string;
  agentDir: string;
  trace: string;
  cache: string;
  env: Record<string, string>;
}

export async function withIsolatedHome(run: (home: IsolatedHome) => Promise<void>): Promise<void> {
  const previous = process.env;
  const root = await mkdtemp(join(tmpdir(), "pi-workspace-test-"));
  const cwd = join(root, "project");
  const agentDir = join(root, "agent");
  const trace = join(root, "requests.jsonl");
  const cache = previous["npm_config_cache"] ?? join(root, "npm-cache");
  const env: Record<string, string> = {
    HOME: root,
    PI_CODING_AGENT_DIR: agentDir,
    PI_WORKSPACE_TEST_TRACE: trace,
    PI_OFFLINE: "1",
    PI_SKIP_VERSION_CHECK: "1",
    PI_TELEMETRY: "0",
    CI: "1",
    npm_config_cache: cache,
    npm_config_offline: "true",
  };
  for (const name of ["PATH", "TMPDIR", "LANG", "LC_ALL", "SHELL"]) {
    const value = previous[name];
    if (value !== undefined) env[name] = value;
  }
  await Promise.all([mkdir(cwd), mkdir(agentDir)]);
  process.env = env;
  try {
    await run({ root, cwd, agentDir, trace, cache, env });
  } finally {
    process.env = previous;
    await rm(root, { recursive: true, force: true });
  }
}

export async function withSdk(
  home: IsolatedHome,
  run: (session: AgentSession) => Promise<void>,
  entry = extensionPath,
): Promise<void> {
  const sdk = await import("@earendil-works/pi-coding-agent");
  const settingsManager = sdk.SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: false },
  });
  const resourceLoader = new sdk.DefaultResourceLoader({
    cwd: home.cwd,
    agentDir: home.agentDir,
    settingsManager,
    additionalExtensionPaths: [entry, providerPath],
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noContextFiles: true,
  });
  await resourceLoader.reload();
  assert.deepEqual(resourceLoader.getExtensions().errors, []);
  const { session } = await sdk.createAgentSession({
    cwd: home.cwd,
    agentDir: home.agentDir,
    noTools: "builtin",
    resourceLoader,
    settingsManager,
    sessionManager: sdk.SessionManager.inMemory(home.cwd),
  });
  try {
    await session.bindExtensions({});
    const model = session.modelRuntime.getModel("pi-workspace-tests", "scripted");
    if (!model) throw new Error("Isolated scripted test provider did not load");
    await session.setModel(model);
    await run(session);
  } finally {
    session.dispose();
  }
}

export async function withRpc(
  home: IsolatedHome,
  run: (client: RpcClient) => Promise<void>,
  entry = extensionPath,
): Promise<void> {
  const { RpcClient: Client } = await import("@earendil-works/pi-coding-agent");
  const cliPath = fileURLToPath(
    new URL("./cli.js", import.meta.resolve("@earendil-works/pi-coding-agent")),
  );
  const client = new Client({
    cliPath,
    cwd: home.cwd,
    env: home.env,
    provider: "pi-workspace-tests",
    model: "scripted",
    args: [
      "--offline",
      "--no-session",
      "--no-extensions",
      "--no-skills",
      "--no-prompt-templates",
      "--no-context-files",
      "--tools",
      packageTools.join(","),
      "-e",
      entry,
      "-e",
      providerPath,
    ],
  });
  try {
    await client.start();
    await client.setAutoCompaction(false);
    await client.setAutoRetry(false);
    await run(client);
  } finally {
    await client.stop();
  }
}

const RequestSchema = z.object({
  tools: z.array(z.string()),
  messages: z.array(z.object({ role: z.string(), content: z.unknown() })),
});
export async function readRequests(home: IsolatedHome): Promise<z.infer<typeof RequestSchema>[]> {
  const text = await readFile(home.trace, "utf8");
  return text
    .trim()
    .split("\n")
    .map((line) => {
      const value: unknown = JSON.parse(line);
      return RequestSchema.parse(value);
    });
}

export const FailedToolSchema = z.object({
  role: z.literal("toolResult"),
  toolName: z.string(),
  isError: z.literal(true),
  details: z.object({
    kind: z.literal("error"),
    id: z.string().nullable(),
    error: z.object({ code: z.string().min(1), message: z.string().min(1) }),
  }),
});
export interface CommandInput {
  program: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
}
export function runCommand(input: CommandInput): string {
  const result = spawnSync(input.program, input.args, {
    cwd: input.cwd,
    env: input.env,
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  assert.equal(result.signal, null, result.stderr);
  assert.equal(
    result.status,
    0,
    `${input.program} ${input.args.join(" ")}\n${result.stdout}\n${result.stderr}`,
  );
  return result.stdout;
}
