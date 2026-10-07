import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import type { Page } from "@playwright/test";
import type { DaemonClient as TestDaemonClient } from "../test-utils/daemon-client.js";
import { test } from "vitest";
import { VisualFailure, type VisualSnapshot } from "@getpaseo/protocol/pi-workspace/contracts";
import {
  decodeVisualEvent,
  type VisualCommand,
  type VisualEvent,
  type VisualReceipt,
  type VisualView,
} from "@getpaseo/protocol/pi-workspace/rpc-schemas";
import { VisualStorage } from "./storage.js";
import { VisualService, type ScheduleVisualDeadline } from "./service.js";
import { z } from "zod";
import {
  withIsolatedHome,
  extensionPath,
  providerPath,
  visualTools,
  packageRoot,
  type IsolatedHome,
} from "../../../../pi-workspace/tests/helpers/pi-harness.js";

const owner = { agentId: "test-agent", sessionId: "test-session" };
const actions = {
  setAngle: {
    description: "Set the angle",
    parameters: {
      type: "object",
      properties: { angle: { type: "integer", minimum: 0, maximum: 90 } },
      required: ["angle"],
      additionalProperties: false,
    },
  },
};

async function withService(
  run: (service: VisualService, storage: VisualStorage) => Promise<void>,
  schedule?: ScheduleVisualDeadline,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "paseo-visual-service-"));
  const storage = new VisualStorage(directory);
  const service = new VisualService(storage, schedule);
  try {
    await run(service, storage);
  } finally {
    service.close();
    await rm(directory, { recursive: true, force: true });
  }
}

class Display {
  readonly source = {};
  readonly snapshots: VisualEvent[] = [];
  private readonly commands: VisualCommand[] = [];
  private waiter: ((command: VisualCommand) => void) | null = null;
  private readonly sequences = new Map<string, number>();
  constructor(private readonly service: VisualService) {}
  emit = (event: VisualEvent): void => {
    this.snapshots.push(event);
    if (event.kind !== "command") return;
    if (this.waiter) {
      const accept = this.waiter;
      this.waiter = null;
      accept(event.command);
    } else this.commands.push(event.command);
  };
  next(): Promise<VisualCommand> {
    const command = this.commands.shift();
    if (command) return Promise.resolve(command);
    return new Promise((resolve) => {
      this.waiter = resolve;
    });
  }
  receipt(command: VisualCommand, snapshot: VisualSnapshot): VisualReceipt {
    const binding = command.kind === "render" ? command.current.binding : command.binding;
    const sequence = (this.sequences.get(binding.nonce) ?? 0) + 1;
    this.sequences.set(binding.nonce, sequence);
    return { binding, commandId: command.commandId, sequence, snapshot, actions, error: null };
  }
  async acknowledgeView(view: VisualView): Promise<VisualReceipt> {
    const current = view.current;
    if (!current) throw new Error("No document to acknowledge in the restored view");
    const sequence = (this.sequences.get(current.binding.nonce) ?? 0) + 1;
    this.sequences.set(current.binding.nonce, sequence);
    const receipt: VisualReceipt = {
      binding: current.binding,
      commandId: null,
      sequence,
      snapshot: current.document.snapshot,
      actions,
      error: null,
    };
    await this.service.receive({ agentId: owner.agentId, source: this.source, receipt });
    return receipt;
  }
  async acknowledge(command: VisualCommand, snapshot: VisualSnapshot): Promise<VisualReceipt> {
    const receipt = this.receipt(command, snapshot);
    await this.service.receive({ agentId: owner.agentId, source: this.source, receipt });
    return receipt;
  }
}

test("real daemon routes Pi presentation to an authenticated owned observation", async () => {
  await withIsolatedHome(async (home) => {
    const { createTestPaseoDaemon } = await import("../test-utils/paseo-daemon.js");
    const { DaemonClient } = await import("../test-utils/daemon-client.js");
    const { PiRpcAgentClient } = await import("../agent/providers/pi/agent.js");
    const { default: pino } = await import("pino");
    const logger = pino({ level: "silent" });
    const provider = new PiRpcAgentClient({
      logger,
      runtimeSettings: {
        command: {
          mode: "replace",
          argv: [
            "pi",
            "--no-extensions",
            "--no-skills",
            "--no-prompt-templates",
            "--no-context-files",
            "--offline",
            "--tools",
            visualTools.join(","),
            "-e",
            extensionPath,
            "-e",
            providerPath,
          ],
        },
        env: home.env,
      },
    });
    const disabled = { provider: "local", explicit: true, enabled: false } as const;
    const daemon = await createTestPaseoDaemon({
      logger,
      paseoHomeRoot: join(home.root, "daemon"),
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
    const client = new DaemonClient({
      url: `ws://127.0.0.1:${daemon.port}/ws`,
      appVersion: "0.10.3",
    });
    const failures: unknown[] = [];
    try {
      await client.connect();
      const created = await client.createWorkspace({
        source: { kind: "directory", path: home.cwd },
      });
      if (!created.workspace) throw new Error("Test workspace was not created");
      const workspace = created.workspace;
      try {
        const agent = await client.createAgent({
          provider: "pi",
          model: "pi-workspace-tests/scripted",
          thinkingOptionId: "off",
          cwd: home.cwd,
          workspaceId: workspace.id,
          title: "Visual transport integration",
        });
        const observation = client.observePiWorkspace(agent.id);
        const initial = await observation.ready;
        assert.equal(initial.agentId, agent.id);
        assert.equal(initial.view.current, null);
        // This controlled display endpoint proves wiring, not browser rendering or capture.
        const commands: VisualCommand[] = [];
        observation.subscribe({
          snapshot() {},
          update(message) {
            if (message.type !== "pi_workspace.update") return;
            const event = decodeVisualEvent(message.payload.event);
            if (event.kind !== "command") return;
            const command = event.command;
            commands.push(command);
            if (command.kind !== "render") {
              failures.push(new Error("Unexpected display command"));
              return;
            }
            void client
              .sendPiWorkspaceReceipt(agent.id, {
                binding: command.current.binding,
                commandId: command.commandId,
                sequence: 1,
                snapshot: { state: null, selection: null },
                actions: {},
                error: null,
              })
              .catch((error: unknown) => {
                failures.push(error);
              });
          },
          error(error) {
            failures.push(error);
          },
        });
        try {
          const file = join(home.cwd, "document.html");
          await writeFile(file, "<!doctype html><p>Prepared document</p>");
          await client.sendMessage(
            agent.id,
            `call:${JSON.stringify({ name: "visual_present", arguments: { mode: "new", title: "Prepared document", file } })}`,
          );
          const finished = await client.waitForFinish(agent.id, 30_000);
          assert.equal(finished.status, "idle");
          const lines = (await readFile(home.trace, "utf8")).trim().split("\n");
          const last = lines.at(-1);
          if (!last) throw new Error("Missing scripted provider request trace");
          const raw: unknown = JSON.parse(last);
          const trace = z
            .object({
              messages: z.array(
                z.object({
                  role: z.string(),
                  toolName: z.string().optional(),
                  isError: z.boolean().optional(),
                  details: z.unknown().optional(),
                }),
              ),
            })
            .parse(raw);
          const result = trace.messages.findLast((message) => message.role === "toolResult");
          if (!result) throw new Error(`Missing tool result: ${JSON.stringify(raw)}`);
          assert.equal(result.toolName, "visual_present");
          assert.equal(result.isError, false, `Persisted Pi result: ${JSON.stringify(result)}`);
          const details = z
            .object({ id: z.string(), status: z.literal("rendered") })
            .parse(result.details);
          assert.equal(commands.length, 1);
          const command = commands[0];
          if (!command || command.kind !== "render")
            throw new Error("Missing actual correlated render command");
          assert.equal(command.current.document.id, details.id);
          assert.deepEqual(failures, []);
        } finally {
          await observation.release();
        }
      } finally {
        await client.removeProject(workspace.projectId);
      }
    } finally {
      await client.close();
      await daemon.daemon.stop();
      await daemon.daemon.agentManager.flush();
      await rm(daemon.staticDir, { recursive: true, force: true });
    }
  });
}, 60_000);

async function verifyApp(home: IsolatedHome): Promise<void> {
  home.env["EXPO_OFFLINE"] = "1";
  const { default: startMetro } = await import("../../../../app/e2e/support/global-setup.js");
  const { buildSeededHost, buildCreateAgentPreferences } =
    await import("../../../../app/e2e/support/helpers/daemon-registry.js");
  const { chromium } = await import("@playwright/test");
  const { startIsolatedHostDaemon } =
    await import("../../../../app/e2e/support/helpers/isolated-host-daemon.js");
  const { DaemonClient } = await import("../test-utils/daemon-client.js");
  const stopMetro = await startMetro();
  if (!stopMetro) throw new Error("Metro did not return a teardown handle");
  try {
    const paseoHome = join(home.root, "daemon");
    await mkdir(paseoHome);
    await writeFile(
      join(paseoHome, "config.json"),
      JSON.stringify({
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
              env: home.env,
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
                extensionPath,
                "-e",
                providerPath,
              ],
            },
          },
        },
      }),
    );
    const daemon = await startIsolatedHostDaemon("visual-diagnostic-host", {
      paseoHome,
      environment: home.env,
    });
    const client = new DaemonClient({
      url: `ws://127.0.0.1:${daemon.port}/ws`,
      appVersion: "0.10.3",
    });
    try {
      assert.notEqual(daemon.port, 6767);
      await client.connect();
      const browser = await chromium.launch({ channel: "chrome", headless: true });
      try {
        const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
        await page.route(/:(6767)\b/, (route) => route.abort());
        await page.routeWebSocket(/:(6767)\b/, async (socket) => {
          await socket.close({ code: 1008, reason: "Production daemon is outside this test" });
        });
        const consoleEntries: string[] = [];
        const frames: string[] = [];
        page.on("console", (message) => {
          if (consoleEntries.length < 200) consoleEntries.push(message.text());
        });
        page.on("pageerror", (error) => {
          consoleEntries.push(error.message);
        });
        page.on("websocket", (socket) => {
          socket.on("framereceived", ({ payload }) => {
            if (
              typeof payload === "string" &&
              payload.includes("pi_workspace") &&
              frames.length < 100
            )
              frames.push(payload);
          });
          socket.on("framesent", ({ payload }) => {
            if (
              typeof payload === "string" &&
              payload.includes("pi_workspace") &&
              frames.length < 100
            )
              frames.push(payload);
          });
        });
        const serverId = daemon.serverId;
        const host = buildSeededHost({
          serverId,
          endpoint: `127.0.0.1:${daemon.port}`,
          nowIso: new Date().toISOString(),
        });
        await page.addInitScript(
          ({ host: seededHost, preferences }) => {
            if (window.top !== window) return;
            localStorage.setItem("@paseo:e2e", "1");
            localStorage.setItem("@paseo:e2e-seed-nonce", "isolated-visual-diagnostic");
            localStorage.setItem("@paseo:daemon-registry", JSON.stringify([seededHost]));
            localStorage.setItem("@paseo:create-agent-preferences", JSON.stringify(preferences));
          },
          { host, preferences: buildCreateAgentPreferences() },
        );
        await exerciseVisualDocument({ page, client, home, serverId, consoleEntries, frames });
      } finally {
        await browser.close();
      }
    } finally {
      await client.close();
      await daemon.close();
    }
  } finally {
    await stopMetro();
  }
}

test("real app presentation preserves diagnostic tool and browser receipts before cleanup", async () => {
  await withIsolatedHome(verifyApp);
}, 180_000);

interface BrowserPresentationInput {
  page: Page;
  client: TestDaemonClient;
  home: IsolatedHome;
  serverId: string;
  consoleEntries: string[];
  frames: string[];
}
const CapturedMessageSchema = z.object({
  role: z.string(),
  toolName: z.string().optional(),
  isError: z.boolean().optional(),
  details: z.unknown().optional(),
});
type CapturedMessage = z.infer<typeof CapturedMessageSchema>;
async function lastToolResult(tracePath: string): Promise<CapturedMessage> {
  const line = (await readFile(tracePath, "utf8")).trim().split("\n").at(-1);
  if (!line) throw new Error("Missing model request trace");
  const raw: unknown = JSON.parse(line);
  const trace = z.object({ messages: z.array(CapturedMessageSchema) }).parse(raw);
  const result = trace.messages.findLast((message) => message.role === "toolResult");
  if (!result) throw new Error(`Missing tool result: ${JSON.stringify(raw)}`);
  return result;
}

async function exerciseVisualDocument({
  page,
  client,
  home,
  serverId,
  consoleEntries,
  frames,
}: BrowserPresentationInput): Promise<void> {
  const created = await client.createWorkspace({ source: { kind: "directory", path: home.cwd } });
  if (!created.workspace) throw new Error("Test workspace was not created");
  const workspace = created.workspace;
  try {
    const agent = await client.createAgent({
      provider: "pi",
      model: "pi-workspace-tests/scripted",
      thinkingOptionId: "off",
      cwd: home.cwd,
      workspaceId: workspace.id,
      title: "Visual browser diagnosis",
    });
    const metroPort = process.env["E2E_METRO_PORT"];
    if (!metroPort) throw new Error("The isolated Metro port is missing");
    await page.goto(
      `http://localhost:${metroPort}/h/${encodeURIComponent(serverId)}/agent/${encodeURIComponent(agent.id)}`,
    );
    await page.getByTestId("message-input-root").waitFor({ state: "visible", timeout: 30_000 });
    const file = join(home.cwd, "interactive.html");
    const html = await readFile(
      resolvePath(packageRoot, "../../qa/pi-workspace/fixtures/interactive.html"),
      "utf8",
    );
    await writeFile(file, html);
    await client.sendMessage(
      agent.id,
      `call:${JSON.stringify({ name: "visual_present", arguments: { mode: "new", title: "Interactive visual", file } })}`,
    );
    assert.equal((await client.waitForFinish(agent.id, 30_000)).status, "idle");
    const result = await lastToolResult(home.trace);
    const surface = await page.getByTestId("pi-workspace-surface").allTextContents();
    assert.equal(result.toolName, "visual_present");
    assert.equal(
      result.isError,
      false,
      JSON.stringify({ result, surface, consoleEntries, frames }, null, 2),
    );
    const shown = z
      .object({ id: z.string(), revision: z.number(), status: z.literal("rendered") })
      .parse(result.details);
    const visual = page.frameLocator('[data-testid="pi-workspace-document"]');
    assert.equal(await visual.locator("#result").textContent(), "4");
    await visual.locator("body").evaluate(() => {
      window.addEventListener("message", (event: MessageEvent<unknown>) => {
        console.debug("Visual diagnostic received command", JSON.stringify(event.data));
      });
    });
    for (const call of [
      { name: "visual_inspect", arguments: { id: shown.id } },
      { name: "visual_act", arguments: { id: shown.id, action: "setValue", value: { value: 5 } } },
    ]) {
      await client.sendMessage(agent.id, `call:${JSON.stringify(call)}`);
      assert.equal((await client.waitForFinish(agent.id, 30_000)).status, "idle");
      const completed = await lastToolResult(home.trace);
      assert.equal(completed.toolName, call.name);
      const currentSurface = await page.getByTestId("pi-workspace-surface").allTextContents();
      assert.equal(
        completed.isError,
        false,
        JSON.stringify({ completed, currentSurface, consoleEntries, frames }, null, 2),
      );
    }
    assert.equal(await visual.locator("#result").textContent(), "25");
    await client.sendMessage(
      agent.id,
      `call:${JSON.stringify({
        name: "visual_update",
        arguments: {
          id: shown.id,
          revision: shown.revision,
          html: '<!doctype html><script>throw new Error("Visual document failure")</script>',
        },
      })}`,
    );
    assert.equal((await client.waitForFinish(agent.id, 30_000)).status, "idle");
    const failed = await lastToolResult(home.trace);
    assert.equal(failed.toolName, "visual_update");
    assert.equal(failed.isError, true, JSON.stringify(failed));
    const failedDetails = z
      .object({ id: z.string(), error: z.object({ code: z.string(), message: z.string() }) })
      .parse(failed.details);
    assert.equal(
      failedDetails.error.code,
      "DOCUMENT_ERROR",
      JSON.stringify({ failed, consoleEntries, frames }, null, 2),
    );
    assert.equal(failedDetails.id, shown.id);
    assert.notEqual(failedDetails.error.message, "");
    assert.equal(
      await visual.locator("#result").textContent(),
      "25",
      "A genuine document exception must retain the prior source and latest state for recovery",
    );
  } finally {
    await client.removeProject(workspace.projectId);
  }
}

function failure(code: string): (error: unknown) => boolean {
  return (error) => error instanceof VisualFailure && error.code === code;
}

test("present waits for the real display port's receipt and inspect sees locally published state", async () => {
  await withService(async (service) => {
    const display = new Display(service);
    const observation = await service.observe({
      agentId: owner.agentId,
      source: display.source,
      emit: display.emit,
    });
    assert.equal(observation.view.current, null);
    const signal = new AbortController().signal;
    const presenting = service.execute(
      owner,
      { kind: "present", title: "Angles", html: "<p>angle</p>" },
      signal,
    );
    const command = await display.next();
    assert.equal(command.kind, "render");
    const first = await display.acknowledge(command, { state: { angle: 10 }, selection: null });
    const shown = await presenting;
    if (shown.kind !== "visual") throw new Error("Expected a visual result");
    assert.equal(shown.status, "rendered");
    const local: VisualReceipt = {
      ...first,
      sequence: first.sequence + 1,
      commandId: null,
      snapshot: { state: { angle: 23 }, selection: { id: "angle", text: "23°" } },
    };
    await service.receive({ agentId: owner.agentId, source: display.source, receipt: local });
    const context = await service.execute(owner, { kind: "context" }, signal);
    if (context.kind !== "context" || !context.visual) throw new Error("Expected current context");
    assert.deepEqual(context.visual.state, { angle: 23 });
    assert.deepEqual(context.visual.selection, local.snapshot.selection);
    assert.equal(context.visual.revision, shown.revision);
    assert.equal(
      display.snapshots.filter((event) => event.kind === "command").length,
      1,
      "A local publication must not request another action",
    );
    await assert.rejects(
      service.receive({ agentId: owner.agentId, source: display.source, receipt: local }),
      failure("STALE_STATE"),
    );
    await assert.rejects(
      service.receive({ agentId: owner.agentId, source: {}, receipt: { ...local, sequence: 3 } }),
      failure("STALE_CLIENT"),
    );
    observation.release();
  });
});

test("multiple authenticated displays can observe an agent; replaced clients cannot publish", async () => {
  await withService(async (service) => {
    const first = new Display(service);
    const observation = await service.observe({
      agentId: owner.agentId,
      source: first.source,
      emit: first.emit,
    });
    const other = new Display(service);
    const concurrent = await service.observe({
      agentId: owner.agentId,
      source: other.source,
      emit: other.emit,
    });
    assert.notEqual(concurrent.view.generation, observation.view.generation);
    concurrent.release();
    const presenting = service.execute(
      owner,
      { kind: "present", title: "Owned display", html: "<p>owned</p>" },
      new AbortController().signal,
    );
    const command = await first.next();
    const receipt = await first.acknowledge(command, { state: { angle: 8 }, selection: null });
    await presenting;
    observation.release();
    const replacement = await service.observe({
      agentId: owner.agentId,
      source: other.source,
      emit: other.emit,
    });
    assert.notEqual(replacement.view.generation, observation.view.generation);
    await assert.rejects(
      service.receive({
        agentId: owner.agentId,
        source: first.source,
        receipt: { ...receipt, sequence: receipt.sequence + 1 },
      }),
      failure("STALE_CLIENT"),
    );
    replacement.release();
  });
});

test("display deadlines reject late receipts and preserve the previous source/state", async () => {
  const deadlines: Array<{ expire: () => void; milliseconds: number; cancelled: boolean }> = [];
  const schedule: ScheduleVisualDeadline = (expire, milliseconds) => {
    const deadline = { expire, milliseconds, cancelled: false };
    deadlines.push(deadline);
    return () => {
      deadline.cancelled = true;
    };
  };
  await withService(async (service, storage) => {
    const display = new Display(service);
    await service.observe({ agentId: owner.agentId, source: display.source, emit: display.emit });
    const signal = new AbortController().signal;
    const presenting = service.execute(
      owner,
      { kind: "present", title: "Deadline", html: "<p>retained</p>" },
      signal,
    );
    await display.acknowledge(await display.next(), { state: { angle: 31 }, selection: "angle" });
    const shown = await presenting;
    if (shown.kind !== "visual") throw new Error("Expected visual");
    const before = await storage.get({ owner, id: shown.id });
    const updating = service.execute(
      owner,
      { kind: "update", id: shown.id, revision: shown.revision, html: "<p>pending</p>" },
      signal,
    );
    const rejected = assert.rejects(updating, failure("DISPLAY_TIMEOUT"));
    const command = await display.next();
    const deadline = deadlines.find((entry) => !entry.cancelled);
    if (!deadline) throw new Error("Display command did not schedule its deadline");
    assert.equal(deadline.milliseconds, 13_000, "Production deadline must not be extended");
    deadline.expire();
    await rejected;
    assert.equal(deadline.cancelled, true);
    assert.deepEqual(await storage.get({ owner, id: shown.id }), before);
    await assert.rejects(
      display.acknowledge(command, { state: { angle: 0 }, selection: null }),
      failure("STALE_DOCUMENT"),
    );
    const listing = await service.execute(owner, { kind: "list", cursor: null }, signal);
    if (listing.kind !== "list") throw new Error("Expected list after timeout");
    assert.equal(listing.items[0]?.revision, before.revision);
  }, schedule);
});

test("malformed action declarations and oversized observations cannot mutate stored state", async () => {
  await withService(async (service, storage) => {
    const display = new Display(service);
    await service.observe({ agentId: owner.agentId, source: display.source, emit: display.emit });
    const signal = new AbortController().signal;
    const presenting = service.execute(
      owner,
      { kind: "present", title: "Untrusted data", html: "<p>data</p>" },
      signal,
    );
    const command = await display.next();
    const base = display.receipt(command, { state: { angle: 4 }, selection: null });
    await assert.rejects(
      service.receive({
        agentId: owner.agentId,
        source: display.source,
        receipt: {
          ...base,
          actions: {
            remote: {
              description: "Unsupported remote schema",
              parameters: { $ref: "https://example.invalid/schema.json" },
            },
          },
        },
      }),
      failure("INVALID_ACTIONS"),
    );
    await assert.rejects(
      service.receive({
        agentId: owner.agentId,
        source: display.source,
        receipt: {
          ...base,
          snapshot: { state: "x".repeat(32769), selection: null },
        },
      }),
      failure("INVALID_DATA"),
    );
    assert.deepEqual((await storage.get({ owner, id: base.binding.id })).snapshot, {
      state: null,
      selection: null,
    });
    await display.acknowledge(command, { state: { angle: 4 }, selection: null });
    const shown = await presenting;
    if (shown.kind !== "visual") throw new Error("Expected visual");
    assert.deepEqual(shown.state, { angle: 4 });
  });
});

test("unknown actions and invalid values are rejected before dispatch", async () => {
  await withService(async (service) => {
    const display = new Display(service);
    await service.observe({ agentId: owner.agentId, source: display.source, emit: display.emit });
    const signal = new AbortController().signal;
    const presenting = service.execute(
      owner,
      { kind: "present", title: "Actions", html: "<p>action</p>" },
      signal,
    );
    await display.acknowledge(await display.next(), { state: { angle: 10 }, selection: null });
    const shown = await presenting;
    if (shown.kind !== "visual") throw new Error("Expected visual");
    const eventCount = display.snapshots.length;
    await assert.rejects(
      service.execute(owner, { kind: "act", id: shown.id, action: "missing", value: null }, signal),
      failure("UNKNOWN_ACTION"),
    );
    await assert.rejects(
      service.execute(
        owner,
        { kind: "act", id: shown.id, action: "setAngle", value: { angle: 100 } },
        signal,
      ),
      failure("INVALID_ACTION_VALUE"),
    );
    assert.equal(display.snapshots.length, eventCount);
    const acting = service.execute(
      owner,
      { kind: "act", id: shown.id, action: "setAngle", value: { angle: 42 } },
      signal,
    );
    const command = await display.next();
    assert.equal(command.kind, "act");
    await display.acknowledge(command, { state: { angle: 42 }, selection: null });
    const changed = await acting;
    if (changed.kind !== "visual") throw new Error("Expected visual");
    assert.deepEqual(changed.state, { angle: 42 });
  });
});

for (const failureMode of ["DOCUMENT_ERROR", "CANCELLED"] as const) {
  test(`R1 failed presentation preserves current visual and recoverable artifact (${failureMode})`, async () => {
    await withService(async (service, storage) => {
      const display = new Display(service);
      await service.observe({ agentId: owner.agentId, source: display.source, emit: display.emit });
      const signal = new AbortController().signal;
      const stateA = { state: { angle: 17 }, selection: { id: "angle", text: "17 degrees" } };
      const presentingA = service.execute(
        owner,
        { kind: "present", title: "A", html: "<p>A</p>" },
        signal,
      );
      await display.acknowledge(await display.next(), stateA);
      const shownA = await presentingA;
      if (shownA.kind !== "visual") throw new Error("Expected rendered A");
      assert.equal(shownA.status, "rendered");
      const controller = new AbortController();
      const presentingB = service.execute(
        owner,
        { kind: "present", title: "B", html: "<p>B</p>" },
        controller.signal,
      );
      let failedId: string | null = null;
      const rejected = assert.rejects(presentingB, (error: unknown) => {
        if (!(error instanceof VisualFailure)) return false;
        failedId = error.artifactId;
        return error.code === failureMode && failedId !== null;
      });
      const commandB = await display.next();
      if (commandB.kind !== "render") throw new Error("Expected B render command");
      if (failureMode === "CANCELLED") controller.abort();
      else {
        await service.receive({
          agentId: owner.agentId,
          source: display.source,
          receipt: {
            ...display.receipt(commandB, { state: null, selection: null }),
            error: { code: "DOCUMENT_ERROR", message: "B failed to render" },
          },
        });
      }
      await rejected;
      assert.equal(
        failedId,
        commandB.current.document.id,
        "B failure must retain B's recovery identity",
      );
      assert.notEqual(failedId, shownA.id);
      const restored = display.snapshots.at(-1);
      if (!restored || restored.kind !== "snapshot" || !restored.view.current)
        throw new Error("Expected restoration of A");
      assert.equal(restored.view.current.document.id, shownA.id);
      assert.deepEqual(restored.view.current.document.snapshot, stateA);
      await display.acknowledgeView(restored.view);
      const listing = await service.execute(owner, { kind: "list", cursor: null }, signal);
      if (listing.kind !== "list") throw new Error("Expected saved artifact list");
      assert.equal(listing.items.length, 2);
      assert.equal(listing.items.find((item) => item.id === failedId)?.title, "B");
      assert.equal(
        (await storage.get({ owner, id: commandB.current.document.id })).html,
        "<p>B</p>",
      );
      const context = await service.execute(owner, { kind: "context" }, signal);
      if (context.kind !== "context" || !context.visual)
        throw new Error("Expected current context for restored A");
      assert.equal(
        context.visual.id,
        shownA.id,
        "Normal follow-up context must name restored A, not failed B",
      );
      assert.deepEqual(context.visual.state, stateA.state);
      assert.deepEqual(context.visual.selection, stateA.selection);
      const inspecting = service.execute(
        owner,
        { kind: "inspect", id: null, screenshot: false },
        signal,
      );
      const inspection = await display.next();
      if (inspection.kind !== "inspect") throw new Error("Expected default inspection command");
      assert.equal(inspection.binding.id, shownA.id);
      await display.acknowledge(inspection, stateA);
      const inspected = await inspecting;
      if (inspected.kind !== "visual") throw new Error("Expected inspected A");
      assert.equal(inspected.id, shownA.id);
      assert.equal(inspected.status, "rendered");
      const reopening = service.execute(
        owner,
        { kind: "open", id: commandB.current.document.id },
        signal,
      );
      const reopenCommand = await display.next();
      if (reopenCommand.kind !== "render") throw new Error("Expected B reopen command");
      assert.equal(reopenCommand.current.document.id, failedId);
      assert.equal(reopenCommand.current.document.html, "<p>B</p>");
      await display.acknowledge(reopenCommand, { state: { angle: 5 }, selection: "B" });
      const reopened = await reopening;
      if (reopened.kind !== "visual") throw new Error("Expected reopened B");
      assert.equal(reopened.id, failedId);
      assert.equal(reopened.status, "rendered");
      const afterOpen = await service.execute(owner, { kind: "context" }, signal);
      if (afterOpen.kind !== "context" || !afterOpen.visual)
        throw new Error("Expected reopened B context");
      assert.equal(afterOpen.visual.id, failedId);
    });
  });
}

for (const failureMode of ["DOCUMENT_ERROR", "CANCELLED", "CLIENT_UNAVAILABLE"] as const) {
  test(`R1 initial failed presentation stays stored without becoming current (${failureMode})`, async () => {
    await withService(async (service, storage) => {
      const display = new Display(service);
      if (failureMode !== "CLIENT_UNAVAILABLE") {
        await service.observe({
          agentId: owner.agentId,
          source: display.source,
          emit: display.emit,
        });
      }
      const controller = new AbortController();
      let failedId: string | null = null;
      const presenting = service.execute(
        owner,
        { kind: "present", title: "Saved", html: "<p>saved</p>" },
        controller.signal,
      );
      const rejected = assert.rejects(presenting, (error: unknown) => {
        if (!(error instanceof VisualFailure)) return false;
        failedId = error.artifactId;
        return error.code === failureMode && failedId !== null;
      });
      if (failureMode !== "CLIENT_UNAVAILABLE") {
        const command = await display.next();
        if (failureMode === "CANCELLED") controller.abort();
        else {
          await service.receive({
            agentId: owner.agentId,
            source: display.source,
            receipt: {
              ...display.receipt(command, { state: null, selection: null }),
              error: { code: "DOCUMENT_ERROR", message: "Initial render failed" },
            },
          });
        }
      }
      await rejected;
      const signal = new AbortController().signal;
      assert.deepEqual(await service.execute(owner, { kind: "context" }, signal), {
        kind: "context",
        visual: null,
      });
      await assert.rejects(
        service.execute(owner, { kind: "inspect", id: null, screenshot: false }, signal),
        failure("NO_CURRENT_VISUAL"),
      );
      const listing = await service.execute(owner, { kind: "list", cursor: null }, signal);
      if (listing.kind !== "list") throw new Error("Expected stored artifact list");
      assert.equal(listing.items.length, 1);
      const item = listing.items[0];
      if (!item) throw new Error("Failed presentation erased the saved artifact");
      assert.equal(item.id, failedId);
      assert.equal((await storage.get({ owner, id: item.id })).html, "<p>saved</p>");
    });
  });
}

test("failed source restoration preserves prior source/state and rejects the late binding", async () => {
  await withService(async (service, storage) => {
    const display = new Display(service);
    await service.observe({ agentId: owner.agentId, source: display.source, emit: display.emit });
    const signal = new AbortController().signal;
    const presenting = service.execute(
      owner,
      { kind: "present", title: "Recovery", html: "<p>old</p>" },
      signal,
    );
    await display.acknowledge(await display.next(), { state: { angle: 33 }, selection: "angle" });
    const shown = await presenting;
    if (shown.kind !== "visual") throw new Error("Expected visual");
    const before = await storage.get({ owner, id: shown.id });
    const updating = service.execute(
      owner,
      { kind: "update", id: shown.id, revision: 1, html: "<p>incompatible</p>" },
      signal,
    );
    const rejected = assert.rejects(updating, failure("RESTORE_FAILED"));
    const command = await display.next();
    const bad = display.receipt(command, { state: null, selection: null });
    await service.receive({
      agentId: owner.agentId,
      source: display.source,
      receipt: { ...bad, error: { code: "RESTORE_FAILED", message: "State is incompatible" } },
    });
    await rejected;
    assert.deepEqual(await storage.get({ owner, id: shown.id }), before);
    assert.equal(
      await storage.readSourceVersion({ owner, id: shown.id }, 2),
      "<p>incompatible</p>",
    );
    await assert.rejects(
      service.receive({
        agentId: owner.agentId,
        source: display.source,
        receipt: { ...bad, sequence: bad.sequence + 1 },
      }),
      failure("STALE_DOCUMENT"),
    );
  });
});

test("offline presentation retains a recoverable ID, listing survives and capture never fabricates pixels", async () => {
  await withService(async (service, storage) => {
    const signal = new AbortController().signal;
    let storedId: string | null = null;
    await assert.rejects(
      service.execute(owner, { kind: "present", title: "Offline", html: "<p>saved</p>" }, signal),
      (error: unknown) => {
        if (!(error instanceof VisualFailure)) return false;
        storedId = error.artifactId;
        return error.code === "CLIENT_UNAVAILABLE" && storedId !== null;
      },
    );
    const listing = await service.execute(owner, { kind: "list", cursor: null }, signal);
    if (listing.kind !== "list") throw new Error("Expected list");
    assert.equal(listing.items.length, 1);
    const item = listing.items[0];
    if (!item) throw new Error("Missing retained artifact");
    assert.equal(item.id, storedId);
    assert.equal((await storage.get({ owner, id: item.id })).html, "<p>saved</p>");
    await assert.rejects(
      service.execute(owner, { kind: "inspect", id: item.id, screenshot: true }, signal),
      failure("CLIENT_UNAVAILABLE"),
    );
  });
});

test("disconnect and cancellation settle pending operations without accepting a stale display", async () => {
  await withService(async (service) => {
    const display = new Display(service);
    const observation = await service.observe({
      agentId: owner.agentId,
      source: display.source,
      emit: display.emit,
    });
    const controller = new AbortController();
    const presenting = service.execute(
      owner,
      { kind: "present", title: "Cancel", html: "<p>cancel</p>" },
      controller.signal,
    );
    const rejected = assert.rejects(presenting, failure("CANCELLED"));
    const command = await display.next();
    controller.abort();
    await rejected;
    await assert.rejects(
      display.acknowledge(command, { state: null, selection: null }),
      failure("STALE_DOCUMENT"),
    );
    observation.release();
    const next = await service.observe({ agentId: owner.agentId, source: {}, emit: display.emit });
    assert.notEqual(next.view.generation, observation.view.generation);
    next.release();
  });
});

test("a publication is answered with the stored revision that holds it, including an unchanged one", async () => {
  await withService(async (service, storage) => {
    const display = new Display(service);
    await service.observe({ agentId: owner.agentId, source: display.source, emit: display.emit });
    const signal = new AbortController().signal;
    const presenting = service.execute(
      owner,
      { kind: "present", title: "Answers", html: "<p>answers</p>" },
      signal,
    );
    const render = await display.next();
    if (render.kind !== "render") throw new Error("Expected a render command");
    await display.acknowledge(render, { state: { angle: 1 }, selection: null });
    const shown = await presenting;
    if (shown.kind !== "visual") throw new Error("Expected visual");
    const publish = (sequence: number, stateRevision: number, angle: number) =>
      service.receive({
        agentId: owner.agentId,
        source: display.source,
        receipt: {
          binding: render.current.binding,
          commandId: null,
          sequence,
          stateRevision,
          snapshot: { state: { angle }, selection: null },
          actions,
          error: null,
        },
      });
    const events = display.snapshots.length;
    assert.equal(await publish(2, shown.stateRevision, 2), shown.stateRevision + 1);
    assert.equal(display.snapshots.length, events + 1);
    assert.equal(await publish(3, shown.stateRevision + 1, 2), shown.stateRevision + 1);
    assert.equal(display.snapshots.length, events + 1, "An unchanged publication emits no state");
    assert.deepEqual((await storage.get({ owner, id: shown.id })).snapshot, {
      state: { angle: 2 },
      selection: null,
    });
  });
});
