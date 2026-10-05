import assert from "node:assert/strict";
import { test } from "vitest";
import type { ConnectionState } from "@getpaseo/client/internal/daemon-client";
import {
  encodeVisualEvent,
  encodeVisualView,
  type VisualClientReceipt,
  type VisualEvent,
} from "@getpaseo/protocol/pi-workspace/rpc-schemas";
import type { SpeechEvent } from "@getpaseo/protocol/pi-workspace/speech";
import type { AudioEngine, AudioPlaybackSource } from "@/voice/audio-engine-types";
import {
  VisualController,
  type SpeechOrigin,
  type SpeechSink,
  type VisualTransport,
} from "./controller";
import { SpeechPlayer } from "./speech-player";

type Observation = ReturnType<VisualTransport["observePiWorkspace"]>;
type Observer = Parameters<Observation["subscribe"]>[0];
type Snapshot = Parameters<Observer["snapshot"]>[0];
type ReceiptAck = Awaited<ReturnType<VisualTransport["sendPiWorkspaceReceipt"]>>;
const agentId = "speech-agent";
const generation = "c5bed943-2cd8-48bd-ab77-8808b6284674";
const utterance = "1a2b3c4d-1c1a-4a8e-9f3c-6f1f6d2f0a01";

class SpeechTransport implements VisualTransport {
  observer: Observer | null = null;
  readonly receipts: VisualClientReceipt[] = [];
  observePiWorkspace(): Observation {
    const snapshot: Snapshot = {
      requestId: "observe",
      subscriptionId: "speech",
      agentId,
      view: encodeVisualView({ generation, sequence: 0, current: null }),
    };
    return {
      subscriptionId: "speech",
      ready: Promise.resolve(snapshot),
      subscribe: (observer) => {
        this.observer = observer;
        observer.snapshot(snapshot);
        return () => {
          this.observer = null;
        };
      },
      release: async () => {
        this.observer = null;
      },
    };
  }
  async sendPiWorkspaceReceipt(
    _agentId: string,
    receipt: VisualClientReceipt,
  ): Promise<ReceiptAck> {
    this.receipts.push(receipt);
    return { requestId: "receipt", agentId, stateRevision: this.receipts.length };
  }
  subscribeConnectionStatus(listener: (state: ConnectionState) => void): () => void {
    listener({ status: "connected" });
    return () => undefined;
  }
  emit(event: VisualEvent): void {
    if (!this.observer) throw new Error("Display is not observing");
    this.observer.update({
      type: "pi_workspace.update",
      payload: { subscriptionId: "speech", agentId, event: encodeVisualEvent(event) },
    });
  }
}

class RecordingSink implements SpeechSink {
  readonly events: SpeechEvent[] = [];
  resets = 0;
  accept(event: SpeechEvent, origin: SpeechOrigin): void {
    this.events.push(event);
    this.origin = origin;
  }
  reset(): void {
    this.resets += 1;
  }
  origin: SpeechOrigin | null = null;
}

class InstantEngine implements AudioEngine {
  readonly played: string[] = [];
  async initialize(): Promise<void> {}
  async destroy(): Promise<void> {}
  async startCapture(): Promise<void> {
    throw new Error("Speech playback never captures audio");
  }
  async stopCapture(): Promise<void> {}
  toggleMute(): boolean {
    return false;
  }
  isMuted(): boolean {
    return false;
  }
  async play(audio: AudioPlaybackSource): Promise<number> {
    await audio.arrayBuffer();
    this.played.push(audio.type);
    return 0.5;
  }
  stop(): void {}
  clearQueue(): void {}
  isPlaying(): boolean {
    return false;
  }
}

const flush = async () => {
  for (let index = 0; index < 10; index += 1) await Promise.resolve();
};

test("an observation with a player announces speech readiness for its generation", async () => {
  const transport = new SpeechTransport();
  const controller = new VisualController(transport, agentId, "electron");
  const sink = new RecordingSink();
  controller.attachSpeech(sink);
  assert.deepEqual(transport.receipts, [], "nothing is announced before an observation exists");
  controller.start();
  await flush();
  assert.deepEqual(transport.receipts, [
    { kind: "speech", clientGeneration: generation, type: "ready" },
  ]);
  await controller.stop();
  assert.ok(sink.resets >= 1, "stopping the observation silences its speech");
});

test("speech events reach the player unsequenced and reports carry the observation identity", async () => {
  const transport = new SpeechTransport();
  const controller = new VisualController(transport, agentId, "android");
  const sink = new RecordingSink();
  controller.attachSpeech(sink);
  controller.start();
  try {
    const speech: SpeechEvent = { type: "cancel", utterance };
    transport.emit({ kind: "speech", speech });
    assert.deepEqual(sink.events, [speech]);
    assert.equal(controller.getSnapshot().error, null);
    sink.origin?.report({ type: "stopped", utterance, durationMs: 120 });
    await flush();
    assert.deepEqual(transport.receipts.at(-1), {
      kind: "speech",
      clientGeneration: generation,
      type: "stopped",
      utterance,
      durationMs: 120,
    });
  } finally {
    await controller.stop();
  }
});

test("a full utterance plays through the player and completes only after every chunk played", async () => {
  const transport = new SpeechTransport();
  const controller = new VisualController(transport, agentId, "electron");
  const engine = new InstantEngine();
  const player = new SpeechPlayer({
    createEngine: () => engine,
    releaseEngine: () => undefined,
    schedule: (run) => {
      run();
      return () => undefined;
    },
  });
  controller.attachSpeech(player);
  controller.start();
  try {
    const audio = btoa("\u0001\u0002".repeat(2400));
    const format = "audio/pcm;rate=24000;bits=16";
    transport.emit({
      kind: "speech",
      speech: { type: "audio", utterance, index: 0, format, audio },
    });
    transport.emit({
      kind: "speech",
      speech: { type: "audio", utterance, index: 1, format, audio },
    });
    transport.emit({ kind: "speech", speech: { type: "end", utterance, chunks: 2 } });
    await flush();
    assert.deepEqual(engine.played, [format, format]);
    assert.deepEqual(transport.receipts.at(-1), {
      kind: "speech",
      clientGeneration: generation,
      type: "completed",
      utterance,
      durationMs: 1000,
    });
    assert.equal(player.getSnapshot().utterance, null);
  } finally {
    await controller.stop();
  }
});

test("speech for an observation without a player is reported as an error, never played", async () => {
  const transport = new SpeechTransport();
  const controller = new VisualController(transport, agentId, "electron");
  controller.start();
  try {
    transport.emit({ kind: "speech", speech: { type: "cancel", utterance } });
    assert.match(controller.getSnapshot().error ?? "", /without a player/);
    assert.deepEqual(transport.receipts, []);
  } finally {
    await controller.stop();
  }
});
