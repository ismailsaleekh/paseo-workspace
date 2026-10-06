import { expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

import { createTestLogger } from "../../test-utils/test-logger.js";
import { AgentManager, type AgentManagerEvent } from "./agent-manager.js";
import type {
  AgentClient,
  AgentHistoryReplacementHandler,
  AgentPersistenceHandle,
  AgentRunResult,
  AgentSession,
  AgentSessionConfig,
  AgentStreamEvent,
  AgentTimelineItem,
} from "./agent-sdk-types.js";

const CAPABILITIES = {
  supportsStreaming: false,
  supportsSessionPersistence: false,
  supportsSessionListing: true,
  supportsDynamicModes: false,
  supportsMcpServers: false,
  supportsReasoningStream: false,
  supportsToolInvocations: false,
} as const;

/** A provider whose active history can change on its own, like Pi after tree navigation. */
class BranchingSession implements AgentSession {
  readonly provider = "codex" as const;
  readonly capabilities = CAPABILITIES;
  readonly id = randomUUID();
  history: AgentTimelineItem[] = [];
  replacement: AgentHistoryReplacementHandler | null = null;
  private readonly subscribers = new Set<(event: AgentStreamEvent) => void>();

  async run(): Promise<AgentRunResult> {
    return { sessionId: this.id, finalText: "", timeline: [] };
  }
  async startTurn(): Promise<{ turnId: string }> {
    return { turnId: "unused" };
  }
  subscribe(callback: (event: AgentStreamEvent) => void): () => void {
    this.subscribers.add(callback);
    return () => {
      this.subscribers.delete(callback);
    };
  }
  emit(event: AgentStreamEvent): void {
    for (const subscriber of this.subscribers) subscriber(event);
  }
  async *streamHistory(): AsyncGenerator<AgentStreamEvent> {
    for (const item of this.history) yield { type: "timeline", provider: this.provider, item };
  }
  setHistoryReplacementHandler(handler: AgentHistoryReplacementHandler | null): void {
    this.replacement = handler;
  }
  async getRuntimeInfo() {
    return { provider: this.provider, sessionId: this.id, model: null, modeId: null };
  }
  async getAvailableModes() {
    return [];
  }
  async getCurrentMode() {
    return null;
  }
  async setMode(): Promise<void> {}
  getPendingPermissions() {
    return [];
  }
  async respondToPermission(): Promise<void> {}
  describePersistence() {
    return { provider: this.provider, sessionId: this.id };
  }
  async interrupt(): Promise<void> {}
  async close(): Promise<void> {}
}

function clientFor(session: BranchingSession): AgentClient {
  return {
    provider: "codex",
    capabilities: CAPABILITIES,
    isAvailable: async () => true,
    fetchCatalog: async () => ({ models: [], modes: [] }),
    createSession: async (_config: AgentSessionConfig) => session,
    resumeSession: async (_handle: AgentPersistenceHandle) => session,
  };
}

test("a provider-initiated history replacement republishes the active branch as the timeline", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-branch-"));
  const session = new BranchingSession();
  session.history = [
    { type: "user_message", text: "MAIN" },
    { type: "assistant_message", text: "DETOUR_ONLY" },
  ];
  const manager = new AgentManager({
    clients: { codex: clientFor(session) },
    logger: createTestLogger(),
  });
  let agentId: string | null = null;
  try {
    const agent = await manager.resumeAgentFromPersistence(
      { provider: "codex", sessionId: "branching" },
      { cwd: workdir },
    );
    agentId = agent.id;
    await manager.hydrateTimelineFromProvider(agent.id);
    expect(manager.getTimeline(agent.id)).toContainEqual({
      type: "assistant_message",
      text: "DETOUR_ONLY",
    });
    const replace = session.replacement;
    if (!replace) throw new Error("the manager did not register a history replacement handler");

    const events: AgentManagerEvent[] = [];
    const unsubscribe = manager.subscribe((event) => events.push(event), {
      agentId: agent.id,
      replayState: false,
    });
    session.emit({
      type: "timeline",
      provider: "codex",
      item: { type: "assistant_message", text: "LIVE_DETOUR_TAIL" },
    });
    session.history = [
      { type: "user_message", text: "MAIN" },
      { type: "assistant_message", text: "SELECTED_NOTES" },
    ];
    await replace();
    unsubscribe();

    expect(manager.getTimeline(agent.id)).toEqual([
      { type: "user_message", text: "MAIN" },
      { type: "assistant_message", text: "SELECTED_NOTES" },
    ]);
    expect(events.some((event) => event.type === "timeline_replacement")).toBe(true);
  } finally {
    if (agentId) await manager.closeAgent(agentId).catch(() => undefined);
    rmSync(workdir, { recursive: true, force: true });
  }
});
