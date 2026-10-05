import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { test } from "vitest";
import { VisualFailure } from "@getpaseo/protocol/pi-workspace/contracts";
import type { VisualEvent } from "@getpaseo/protocol/pi-workspace/rpc-schemas";
import {
  parseSpeechEvent,
  speechReceipt,
  type SpeechPlayback,
} from "@getpaseo/protocol/pi-workspace/speech";
import type { ClientPresenceState } from "../agent-attention-policy.js";
import type { SpeechStreamResult, TextToSpeechProvider } from "../speech/speech-provider.js";
import { VisualService } from "./service.js";
import { VisualStorage } from "./storage.js";

const owner = { agentId: "speech-agent", sessionId: "speech-session" };

class Tts implements TextToSpeechProvider {
  readonly texts: string[] = [];
  async synthesizeSpeech(text: string): Promise<SpeechStreamResult> {
    this.texts.push(text);
    return { stream: Readable.from([Buffer.alloc(4800)]), format: "pcm;rate=24000" };
  }
}

class Display {
  readonly source = {};
  readonly speech: SpeechPlayback[] = [];
  readonly events: VisualEvent[] = [];
  presence: ClientPresenceState | null = null;
  generation = "";
  emit = (event: VisualEvent): void => {
    this.events.push(event);
    if (event.kind !== "speech") return;
    const playback = parseSpeechEvent(event.speech);
    if (!playback) throw new Error("Invalid speech event");
    this.speech.push(playback);
  };
}

async function harness(run: (service: VisualService, tts: Tts) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "paseo-visual-speech-"));
  const service = new VisualService(new VisualStorage(directory));
  const tts = new Tts();
  service.connectSpeech({ resolveTts: () => tts });
  try {
    await run(service, tts);
  } finally {
    service.close();
    await rm(directory, { recursive: true, force: true });
  }
}

async function display(
  service: VisualService,
  ready = true,
): Promise<Display & { release(): void }> {
  const port = new Display();
  const observation = await service.observe({
    agentId: owner.agentId,
    source: port.source,
    platform: "electron",
    emit: port.emit,
    presence: () => port.presence,
  });
  port.generation = observation.view.generation;
  if (ready)
    await service.receive({
      agentId: owner.agentId,
      source: port.source,
      receipt: speechReceipt(port.generation, { type: "ready" }),
    });
  return Object.assign(port, { release: () => observation.release() });
}

const settle = async () => {
  for (let index = 0; index < 20; index += 1) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
};

function utteranceId(index: number): string {
  return `6f3a7a52-0d4b-4c1e-8b2a-${String(index).padStart(12, "0")}`;
}

test("speak fails with CLIENT_UNAVAILABLE when no speech-capable display shows the conversation", async () => {
  await harness(async (service) => {
    await display(service, false);
    await assert.rejects(
      service.speak(
        owner,
        { utterance: utteranceId(1), text: "Hi." },
        new AbortController().signal,
      ),
      (error: unknown) =>
        error instanceof VisualFailure &&
        error.code === "CLIENT_UNAVAILABLE" &&
        error.artifactId === utteranceId(1),
    );
  });
});

test("speak fails with TTS_UNAVAILABLE when the host has no local engine", async () => {
  const directory = await mkdtemp(join(tmpdir(), "paseo-visual-speech-"));
  const service = new VisualService(new VisualStorage(directory));
  service.connectSpeech({ resolveTts: () => null });
  try {
    await display(service);
    await assert.rejects(
      service.speak(
        owner,
        { utterance: utteranceId(2), text: "Hi." },
        new AbortController().signal,
      ),
      (error: unknown) => error instanceof VisualFailure && error.code === "TTS_UNAVAILABLE",
    );
  } finally {
    service.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("exactly one client plays: the visible, focused, most recently active display wins", async () => {
  await harness(async (service, tts) => {
    const now = Date.now();
    const desktop = await display(service);
    const phone = await display(service);
    desktop.presence = {
      appVisible: true,
      lastActivityAtMs: now - 1000,
      focusedAgentId: owner.agentId,
      focusedTerminalId: null,
    };
    phone.presence = {
      appVisible: true,
      lastActivityAtMs: now - 60_000,
      focusedAgentId: owner.agentId,
      focusedTerminalId: null,
    };
    const speaking = service.speak(
      owner,
      { utterance: utteranceId(3), text: "Exact words. More words." },
      new AbortController().signal,
    );
    await settle();
    assert.deepEqual(tts.texts, ["Exact words. ", "More words."]);
    assert.deepEqual(
      desktop.speech.map((playback) => playback.type),
      ["audio", "audio", "end"],
    );
    assert.deepEqual(phone.speech, [], "speech is never broadcast to a second client");
    await service.receive({
      agentId: owner.agentId,
      source: desktop.source,
      receipt: speechReceipt(desktop.generation, {
        type: "completed",
        utterance: utteranceId(3),
        durationMs: 200,
      }),
    });
    assert.deepEqual(await speaking, {
      kind: "speech",
      utterance: utteranceId(3),
      status: "completed",
      client: desktop.generation,
      durationMs: 200,
    });

    desktop.presence = { ...desktop.presence, appVisible: false };
    const second = service.speak(
      owner,
      { utterance: utteranceId(4), text: "Phone now." },
      new AbortController().signal,
    );
    await settle();
    assert.equal(phone.speech.length, 2, "a hidden app is never chosen");
    await service.receive({
      agentId: owner.agentId,
      source: phone.source,
      receipt: speechReceipt(phone.generation, {
        type: "stopped",
        utterance: utteranceId(4),
        durationMs: 10,
      }),
    });
    assert.equal((await second).status, "stopped");
  });
});

test("a hidden app does not display the conversation; an idle visible display still plays", async () => {
  await harness(async (service) => {
    const desktop = await display(service);
    desktop.presence = {
      appVisible: false,
      lastActivityAtMs: Date.now(),
      focusedAgentId: owner.agentId,
      focusedTerminalId: null,
    };
    await assert.rejects(
      service.speak(
        owner,
        { utterance: utteranceId(10), text: "Hidden." },
        new AbortController().signal,
      ),
      (error: unknown) => error instanceof VisualFailure && error.code === "CLIENT_UNAVAILABLE",
    );
    assert.deepEqual(desktop.speech, []);

    desktop.presence = {
      appVisible: true,
      lastActivityAtMs: Date.now() - 24 * 60 * 60 * 1000,
      focusedAgentId: null,
      focusedTerminalId: null,
    };
    const idle = service.speak(
      owner,
      { utterance: utteranceId(11), text: "Still heard." },
      new AbortController().signal,
    );
    await settle();
    assert.equal(desktop.speech.at(-1)?.type, "end", "activity age only ranks displays");
    await service.receive({
      agentId: owner.agentId,
      source: desktop.source,
      receipt: speechReceipt(desktop.generation, {
        type: "completed",
        utterance: utteranceId(11),
        durationMs: 100,
      }),
    });
    assert.equal((await idle).status, "completed");
  });
});

test("a released display fails its utterance; receipts from other connections are refused", async () => {
  await harness(async (service) => {
    const desktop = await display(service);
    const speaking = service.speak(
      owner,
      { utterance: utteranceId(5), text: "Going away." },
      new AbortController().signal,
    );
    await settle();
    await assert.rejects(
      service.receive({
        agentId: owner.agentId,
        source: {},
        receipt: speechReceipt(desktop.generation, {
          type: "stopped",
          utterance: utteranceId(5),
          durationMs: 1,
        }),
      }),
      (error: unknown) => error instanceof VisualFailure && error.code === "STALE_CLIENT",
    );
    desktop.release();
    await assert.rejects(
      speaking,
      (error: unknown) => error instanceof VisualFailure && error.code === "CLIENT_DISCONNECTED",
    );
  });
});

test("utterances of one conversation play in order and never block visual operations", async () => {
  await harness(async (service, tts) => {
    const desktop = await display(service);
    const signal = new AbortController().signal;
    const first = service.speak(owner, { utterance: utteranceId(6), text: "First." }, signal);
    const second = service.speak(owner, { utterance: utteranceId(7), text: "Second." }, signal);
    await settle();
    assert.deepEqual(tts.texts, ["First."], "the second utterance waits for the first");
    const listed = await service.execute(owner, { kind: "list", cursor: null }, signal);
    assert.equal(listed.kind, "list");
    await service.receive({
      agentId: owner.agentId,
      source: desktop.source,
      receipt: speechReceipt(desktop.generation, {
        type: "completed",
        utterance: utteranceId(6),
        durationMs: 100,
      }),
    });
    assert.equal((await first).status, "completed");
    await settle();
    assert.deepEqual(tts.texts, ["First.", "Second."]);
    await service.receive({
      agentId: owner.agentId,
      source: desktop.source,
      receipt: speechReceipt(desktop.generation, {
        type: "completed",
        utterance: utteranceId(7),
        durationMs: 100,
      }),
    });
    assert.equal((await second).status, "completed");
  });
});

test("a cancelled queued utterance leaves the queue without playing", async () => {
  await harness(async (service, tts) => {
    const desktop = await display(service);
    const first = service.speak(
      owner,
      { utterance: utteranceId(8), text: "First." },
      new AbortController().signal,
    );
    const controller = new AbortController();
    const queued = service.speak(
      owner,
      { utterance: utteranceId(9), text: "Never." },
      controller.signal,
    );
    await settle();
    controller.abort();
    await assert.rejects(
      queued,
      (error: unknown) => error instanceof VisualFailure && error.code === "CANCELLED",
    );
    await service.receive({
      agentId: owner.agentId,
      source: desktop.source,
      receipt: speechReceipt(desktop.generation, {
        type: "stopped",
        utterance: utteranceId(8),
        durationMs: 5,
      }),
    });
    await first;
    await settle();
    assert.deepEqual(tts.texts, ["First."]);
  });
});
