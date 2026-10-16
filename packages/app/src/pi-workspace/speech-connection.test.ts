import assert from "node:assert/strict";
import { test } from "vitest";
import type { ConnectionState } from "@getpaseo/client/internal/daemon-client";
import type { VisualClientReceipt } from "@getpaseo/protocol/pi-workspace/rpc-schemas";
import type { SpeechEvent, SpeechVoice } from "@getpaseo/protocol/pi-workspace/speech";
import type { AudioEngine, AudioPlaybackSource } from "@/audio/audio-engine-types";
import { AppSpeech, getAppSpeechSnapshot, type AppSpeechClient } from "./speech-connection";

type Observation = ReturnType<AppSpeechClient["observePiSpeech"]>;
type Observer = Parameters<Observation["subscribe"]>[0];
type ReceiptAck = Awaited<ReturnType<AppSpeechClient["sendPiWorkspaceReceipt"]>>;

const firstGeneration = "4f0c2f5e-9d8a-4c47-9f2e-1d2b3c4d5e01";
const utterance = (index: number) => `9a1b2c3d-4e5f-4a6b-8c7d-${String(index).padStart(12, "0")}`;

class SpeechClient implements AppSpeechClient {
  observer: Observer | null = null;
  readonly requests: Array<{ device: string; background: boolean }> = [];
  readonly receipts: Array<{ agentId: string; receipt: VisualClientReceipt }> = [];
  released = 0;
  private status: ((state: ConnectionState) => void) | null = null;
  observePiSpeech(
    device: Parameters<AppSpeechClient["observePiSpeech"]>[0],
    background: boolean,
  ): Observation {
    this.requests.push({ device, background });
    return {
      subscriptionId: "speech",
      ready: new Promise(() => undefined),
      subscribe: (observer) => {
        this.observer = observer;
        return () => {
          this.observer = null;
        };
      },
      release: async () => {
        this.released += 1;
      },
    };
  }
  async sendPiWorkspaceReceipt(agentId: string, receipt: VisualClientReceipt): Promise<ReceiptAck> {
    this.receipts.push({ agentId, receipt });
    return { requestId: "receipt", agentId, stateRevision: this.receipts.length };
  }
  subscribeConnectionStatus(listener: (state: ConnectionState) => void): () => void {
    this.status = listener;
    listener({ status: "connected" });
    return () => {
      this.status = null;
    };
  }
  snapshot(generation: string): void {
    if (!this.observer) throw new Error("Speech is not subscribed");
    this.observer.snapshot({ requestId: "observe", subscriptionId: "speech", generation });
  }
  speak(agentId: string, voice: SpeechVoice, speech: SpeechEvent): void {
    if (!this.observer) throw new Error("Speech is not subscribed");
    this.observer.update({
      type: "pi_workspace.speech.update",
      payload: { subscriptionId: "speech", agentId, voice, speech },
    });
  }
  disconnect(): void {
    this.status?.({ status: "disconnected" });
  }
}

class Engine implements AudioEngine {
  readonly calls: string[] = [];
  async initialize(): Promise<void> {}
  async destroy(): Promise<void> {}
  async startCapture(): Promise<void> {
    throw new Error("Speech playback never starts the microphone");
  }
  async stopCapture(): Promise<void> {
    throw new Error("Speech playback never stops the microphone");
  }
  toggleMute(): boolean {
    throw new Error("Speech playback never changes microphone mute");
  }
  isMuted(): boolean {
    return false;
  }
  async play(audio: AudioPlaybackSource): Promise<number> {
    await audio.arrayBuffer();
    this.calls.push("play");
    return 0.25;
  }
  clearQueue(): void {
    this.calls.push("clearQueue");
  }
  stop(): void {
    this.calls.push("stop");
  }
  isPlaying(): boolean {
    return false;
  }
}

const flush = async () => {
  for (let index = 0; index < 20; index += 1) await Promise.resolve();
};
const audio = (id: string): SpeechEvent => ({
  type: "audio",
  utterance: id,
  index: 0,
  format: "audio/pcm;rate=24000;bits=16",
  audio: "AAAA",
});

test("one app subscription plays every conversation's speech and reports on its generation", async () => {
  const client = new SpeechClient();
  const engine = new Engine();
  const speech = new AppSpeech(client, false, {
    createEngine: () => engine,
    releaseEngine: () => undefined,
    schedule: (run) => {
      run();
      return () => undefined;
    },
  });
  const stop = speech.start();
  assert.deepEqual(client.requests, [{ device: "computer", background: false }]);
  assert.equal(getAppSpeechSnapshot().status, "connecting");
  client.snapshot(firstGeneration);
  assert.equal(getAppSpeechSnapshot().status, "ready");

  client.speak("agent-a", "adam", audio(utterance(1)));
  await flush();
  assert.equal(getAppSpeechSnapshot().speaking?.voice, "adam", "the orb names the speaking voice");
  client.speak("agent-a", "adam", { type: "end", utterance: utterance(1), chunks: 1 });
  await flush();
  assert.deepEqual(client.receipts, [
    {
      agentId: "agent-a",
      receipt: {
        kind: "speech",
        clientGeneration: firstGeneration,
        type: "completed",
        utterance: utterance(1),
        durationMs: 250,
      },
    },
  ]);
  assert.equal(getAppSpeechSnapshot().speaking, null);

  client.speak("agent-b", "michael", audio(utterance(2)));
  await flush();
  const speaking = getAppSpeechSnapshot().speaking;
  if (!speaking) throw new Error("Speech is not playing");
  speaking.stop();
  assert.deepEqual(client.receipts.at(-1), {
    agentId: "agent-b",
    receipt: {
      kind: "speech",
      clientGeneration: firstGeneration,
      type: "stopped",
      utterance: utterance(2),
      durationMs: 250,
    },
  });

  client.speak("agent-a", "michael", audio(utterance(3)));
  await flush();
  const reports = client.receipts.length;
  client.disconnect();
  assert.equal(getAppSpeechSnapshot().speaking, null, "a lost connection silences its speech");
  assert.equal(getAppSpeechSnapshot().status, "connecting");
  assert.equal(client.receipts.length, reports, "silenced speech is never reported");
  stop();
  assert.equal(client.released, 1);
  assert.equal(getAppSpeechSnapshot().status, "none");
});
