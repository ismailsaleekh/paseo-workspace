import { useEffect, useSyncExternalStore } from "react";
import { Platform } from "react-native";
import {
  speechReceipt,
  type SpeechClientSignal,
  type SpeechDevice,
  type SpeechVoice,
} from "@getpaseo/protocol/pi-workspace/speech";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { createAudioEngine } from "@/voice/audio-engine";
import type { AudioEngine } from "@/voice/audio-engine-types";
import { SpeechPlayer, type SpeechOrigin, type SpeechPlayerOptions } from "./speech-player";
import { outputDrained, subscribeStopSpeechRequests, useBackgroundSpeech } from "./native-host";

/** The kind of device this app plays speech on. */
export const SPEECH_DEVICE: SpeechDevice = Platform.OS === "web" ? "computer" : "phone";

const SILENT_CAPTURE_CALLBACKS = {
  onCaptureData: () => undefined,
  onVolumeLevel: () => undefined,
};

function releaseSpeechEngine(engine: AudioEngine): void {
  engine.clearQueue();
  engine.stop();
  // The web engine owns a private AudioContext. The native engine shares the platform audio
  // session with dictation, so it is only stopped, never torn down.
  if (Platform.OS === "web")
    void engine.destroy().catch((error: unknown) => {
      console.warn("Speech playback engine release failed", error);
    });
}

/** Speech playback through this platform's audio engine. */
export const PLATFORM_SPEECH_OPTIONS: SpeechPlayerOptions = {
  createEngine: () => createAudioEngine(SILENT_CAPTURE_CALLBACKS, { traceLabel: "pi-speech" }),
  releaseEngine: releaseSpeechEngine,
  ...(outputDrained ? { outputDrained } : {}),
};

export type AppSpeechClient = Pick<
  DaemonClient,
  "observePiSpeech" | "sendPiWorkspaceReceipt" | "subscribeConnectionStatus"
>;

export type AppSpeechStatus = "connecting" | "ready" | "unavailable";

/**
 * The agent speech of one host connection: one subscription plays the speech of every
 * conversation, whatever the app displays. Reports go back on the subscription the utterance
 * arrived on; a lost subscription silences its audio without reporting.
 */
export class AppSpeech {
  readonly player: SpeechPlayer;
  private generation: string | null = null;
  private readonly origins = new Map<string, SpeechOrigin>();
  private status: AppSpeechStatus = "connecting";

  constructor(
    private readonly client: AppSpeechClient,
    private readonly background: boolean,
    options: SpeechPlayerOptions = PLATFORM_SPEECH_OPTIONS,
  ) {
    this.player = new SpeechPlayer(options);
  }

  getStatus(): AppSpeechStatus {
    return this.status;
  }

  /** Starts playing this connection's speech; returns the teardown. */
  start(): () => void {
    const observation = this.client.observePiSpeech(SPEECH_DEVICE, this.background);
    const unsubscribe = observation.subscribe({
      snapshot: (payload) => {
        if (payload.generation === this.generation) return;
        this.silence();
        this.generation = payload.generation;
        this.setStatus("ready");
      },
      update: (message) => {
        if (message.type !== "pi_workspace.speech.update") return;
        const { agentId, voice, speech } = message.payload;
        this.player.accept(speech, this.origin(agentId), voice);
      },
      error: () => this.setStatus("unavailable"),
    });
    const disconnect = this.client.subscribeConnectionStatus((state) => {
      if (state.status === "connected") return;
      this.silence();
      this.setStatus("connecting");
    });
    const stopRequests = subscribeStopSpeechRequests(() => this.player.stop());
    const unpublish = this.player.subscribe(publish);
    connections.add(this);
    publish();
    return () => {
      connections.delete(this);
      unpublish();
      stopRequests();
      disconnect();
      unsubscribe();
      this.silence();
      publish();
      void observation.release().catch((error: unknown) => {
        console.warn("Speech subscription release failed", error);
      });
    };
  }

  /** What the current subscription delivered can no longer report: stop it silently. */
  private silence(): void {
    this.generation = null;
    this.origins.clear();
    this.player.dispose();
  }

  private origin(agentId: string): SpeechOrigin {
    const existing = this.origins.get(agentId);
    if (existing) return existing;
    const generation = this.generation;
    const origin: SpeechOrigin = {
      report: (report) => {
        if (generation !== null && generation === this.generation)
          this.send(agentId, generation, report);
      },
    };
    this.origins.set(agentId, origin);
    return origin;
  }

  private send(agentId: string, generation: string, signal: SpeechClientSignal): void {
    void this.client
      .sendPiWorkspaceReceipt(agentId, speechReceipt(generation, signal))
      .catch((error: unknown) => {
        console.warn("Speech playback report failed", error);
      });
  }

  private setStatus(status: AppSpeechStatus): void {
    if (this.status === status) return;
    this.status = status;
    publish();
  }
}

/** What the app's speech is doing, across its host connections. */
export interface AppSpeechSnapshot {
  /** "none" while no host connection plays speech. */
  status: AppSpeechStatus | "none";
  /** The utterance playing now: its voice and its Stop. */
  speaking: { voice: SpeechVoice | null; stop: () => void } | null;
}

const STATUS_RANK: Record<AppSpeechSnapshot["status"], number> = {
  none: 0,
  unavailable: 1,
  connecting: 2,
  ready: 3,
};
const connections = new Set<AppSpeech>();
const listeners = new Set<() => void>();
let snapshot: AppSpeechSnapshot = { status: "none", speaking: null };

function publish(): void {
  let status: AppSpeechSnapshot["status"] = "none";
  let speaking: AppSpeechSnapshot["speaking"] = null;
  for (const speech of connections) {
    const current = speech.getStatus();
    if (STATUS_RANK[current] > STATUS_RANK[status]) status = current;
    const playing = speech.player.getSnapshot();
    if (!speaking && playing.utterance !== null) {
      const player = speech.player;
      speaking = { voice: playing.voice, stop: () => player.stop() };
    }
  }
  snapshot = { status, speaking };
  for (const listener of listeners) listener();
}

function subscribeSnapshot(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export const getAppSpeechSnapshot = (): AppSpeechSnapshot => snapshot;

export function useAppSpeech(): AppSpeechSnapshot {
  return useSyncExternalStore(subscribeSnapshot, getAppSpeechSnapshot, getAppSpeechSnapshot);
}

/** Plays the agent speech of one host connection for as long as it is mounted. */
export function AppSpeechHost({ client }: { client: AppSpeechClient }): null {
  const { enabled } = useBackgroundSpeech();
  useEffect(() => new AppSpeech(client, enabled).start(), [client, enabled]);
  return null;
}
