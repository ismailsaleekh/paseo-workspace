import type { AudioEngine, AudioPlaybackSource } from "@/voice/audio-engine-types";
import { parseSpeechEvent, type SpeechEvent } from "@getpaseo/protocol/pi-workspace/speech";
import type { SpeechOrigin, SpeechReport, SpeechSink } from "./controller";

export type { SpeechReport } from "./controller";
export interface SpeechPlayerState {
  /** The utterance currently playing; the stop control is shown while this is set. */
  utterance: string | null;
  /** The panel that shows the stop control: the most recently mounted holder of the player. */
  holder: object | null;
}
export interface SpeechPlayerOptions {
  /** Created lazily on the first audio so an idle app holds no audio session or player. */
  createEngine(): AudioEngine;
  /** Gives the engine back when the player is disposed (never tears down shared capture). */
  releaseEngine(engine: AudioEngine): void;
  /**
   * Whether the platform output has written all queued audio. Engines time a chunk by its
   * duration while the device may still be writing it, so completion also waits for this.
   * Absent where the engine's chunk end is the real end of output (web audio).
   */
  outputDrained?: () => boolean;
  /** Schedules completion checks; defaults to a timer. */
  schedule?: (run: () => void, milliseconds: number) => () => void;
  /** Clock for the drain bound; defaults to Date.now. */
  now?: () => number;
}

/** Interval at which completion re-checks that the platform output drained. */
export const SPEECH_DRAIN_POLL_MS = 50;
/**
 * Upper bound on waiting for the platform output to drain after the last chunk's timer ended.
 * Measured on the judge emulator: the native output stayed active about 1.5 s after the engine's
 * duration timers ended (pr-000009 run 2 AudioService log: timers ended by 41.4 s, output active
 * until 42.9 s); 10 s allows roughly six times that. Exceeding it is a playback failure.
 */
export const SPEECH_DRAIN_LIMIT_MS = 10_000;
/** Lets the device play out its final output buffer before the player is released. */
export const SPEECH_TAIL_MS = 150;
function scheduleTimer(run: () => void, milliseconds: number): () => void {
  const timer = setTimeout(run, milliseconds);
  return () => clearTimeout(timer);
}
interface Utterance {
  id: string;
  origin: SpeechOrigin;
  received: number;
  played: number;
  playedMs: number;
  expected: number | null;
  ended: boolean;
  /** All chunks reported their end; completion waits for the output to drain. */
  draining: boolean;
}

/** Utterances that ended locally; their late frames are dropped. Bounded memory. */
const ENDED_UTTERANCES = 64;

function decodeBase64(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const buffer = new ArrayBuffer(binary.length);
  const bytes = new Uint8Array(buffer);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return buffer;
}

/**
 * Plays agent speech for one conversation through the platform audio engine. Stop is local and
 * immediate: queued chunks are dropped before the active one is stopped, and every later frame of
 * the stopped utterance is ignored. Completion is reported only after every chunk played, to the
 * observation the utterance arrived on. Playback never touches the microphone, the composer or
 * the agent run.
 */
export class SpeechPlayer implements SpeechSink {
  private engine: AudioEngine | null = null;
  private current: Utterance | null = null;
  private readonly ended: string[] = [];
  private readonly holders: object[] = [];
  private state: SpeechPlayerState = { utterance: null, holder: null };
  private readonly listeners = new Set<() => void>();
  private cancelDrain: (() => void) | null = null;

  constructor(private readonly options: SpeechPlayerOptions) {}

  getSnapshot = (): SpeechPlayerState => this.state;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  accept(event: SpeechEvent, origin: SpeechOrigin): void {
    const playback = parseSpeechEvent(event);
    if (!playback) throw new Error("Malformed speech event");
    if (this.ended.includes(playback.utterance)) return;
    switch (playback.type) {
      case "audio": {
        let entry = this.current;
        if (!entry || entry.id !== playback.utterance) {
          if (entry) this.silence(entry);
          entry = {
            id: playback.utterance,
            origin,
            received: 0,
            played: 0,
            playedMs: 0,
            expected: null,
            ended: false,
            draining: false,
          };
          this.current = entry;
          this.publish();
        }
        if (playback.index !== entry.received) {
          this.fail(entry, "SPEECH_SEQUENCE", "Speech audio arrived out of order");
          return;
        }
        entry.received += 1;
        this.play(entry, playback.format, decodeBase64(playback.audio));
        return;
      }
      case "end": {
        const entry = this.current;
        if (!entry || entry.id !== playback.utterance) {
          this.endUtterance(playback.utterance);
          origin.report({
            type: "failed",
            utterance: playback.utterance,
            error: { code: "PLAYBACK_FAILED", message: "No audio of this utterance was received" },
          });
          return;
        }
        if (playback.chunks !== entry.received) {
          this.fail(entry, "SPEECH_SEQUENCE", "Speech audio is incomplete");
          return;
        }
        entry.expected = playback.chunks;
        this.maybeComplete(entry);
        return;
      }
      case "cancel": {
        const entry = this.current;
        if (entry && entry.id === playback.utterance) this.silence(entry);
        else this.endUtterance(playback.utterance);
        return;
      }
    }
  }

  /**
   * Registers a mounted panel of this conversation. The latest holder shows the stop control;
   * when the last holder leaves, playback stops and the audio engine is released.
   */
  hold(): { holder: object; release(): void } {
    const holder = {};
    this.holders.push(holder);
    this.publish();
    let held = true;
    return {
      holder,
      release: () => {
        if (!held) return;
        held = false;
        const index = this.holders.indexOf(holder);
        if (index !== -1) this.holders.splice(index, 1);
        if (this.holders.length === 0) this.dispose();
        this.publish();
      },
    };
  }

  /** The user's stop control: silent at once, reported as stopped. */
  stop(): void {
    const entry = this.current;
    if (!entry) return;
    this.silence(entry);
    entry.origin.report({
      type: "stopped",
      utterance: entry.id,
      durationMs: Math.round(entry.playedMs),
    });
  }

  /** The origin's observation ended: silence what it delivered, without a report. */
  reset(origin: SpeechOrigin): void {
    const entry = this.current;
    if (entry && entry.origin === origin) this.silence(entry);
  }

  dispose(): void {
    const entry = this.current;
    if (entry) this.silence(entry);
    const engine = this.engine;
    this.engine = null;
    if (engine) this.options.releaseEngine(engine);
  }

  private play(entry: Utterance, format: string, buffer: ArrayBuffer): void {
    const engine = this.engine ?? this.options.createEngine();
    this.engine = engine;
    const source: AudioPlaybackSource = {
      size: buffer.byteLength,
      type: format,
      // The engine reads the bytes right before it starts the chunk; a stopped utterance never
      // reaches the speaker even if the engine had already dequeued this chunk.
      arrayBuffer: async () => {
        if (entry.ended) throw new Error("Speech was stopped");
        return buffer;
      },
    };
    void engine.play(source).then(
      (seconds) => {
        if (entry.ended) return undefined;
        entry.played += 1;
        entry.playedMs += seconds * 1000;
        this.maybeComplete(entry);
        return undefined;
      },
      (error: unknown) => {
        if (entry.ended) return;
        this.fail(
          entry,
          "PLAYBACK_FAILED",
          error instanceof Error ? error.message : "Speech playback failed",
        );
      },
    );
  }

  /**
   * Completion follows the end of real output: after every chunk reported its end, wait until the
   * platform output drained and played its last buffer, then stop the platform player (no idle
   * player stays started) and only then report the utterance as completed. A user stop while
   * draining is still a stop.
   */
  private maybeComplete(entry: Utterance): void {
    if (entry.ended || entry.draining) return;
    if (entry.expected === null || entry.played !== entry.expected) return;
    entry.draining = true;
    const schedule = this.options.schedule ?? scheduleTimer;
    const drained = this.options.outputDrained ?? (() => true);
    const now = this.options.now ?? (() => Date.now());
    const startedAt = now();
    const check = () => {
      this.cancelDrain = null;
      if (entry.ended) return;
      if (!drained()) {
        if (now() - startedAt >= SPEECH_DRAIN_LIMIT_MS) {
          // Never claim completion for audio the device has not played.
          this.fail(
            entry,
            "PLAYBACK_DRAIN_TIMEOUT",
            "The device did not finish playing the speech audio in time",
          );
          return;
        }
        this.cancelDrain = schedule(check, SPEECH_DRAIN_POLL_MS);
        return;
      }
      this.cancelDrain = schedule(() => this.complete(entry), SPEECH_TAIL_MS);
    };
    check();
  }

  private complete(entry: Utterance): void {
    this.cancelDrain = null;
    if (entry.ended) return;
    this.finish(entry);
    const engine = this.engine;
    if (engine) {
      engine.clearQueue();
      engine.stop();
    }
    entry.origin.report({
      type: "completed",
      utterance: entry.id,
      durationMs: Math.round(entry.playedMs),
    });
  }

  private fail(entry: Utterance, code: string, message: string): void {
    this.silence(entry);
    entry.origin.report({ type: "failed", utterance: entry.id, error: { code, message } });
  }

  /** Stops the audio of an utterance without reporting. */
  private silence(entry: Utterance): void {
    if (entry.ended) return;
    this.finish(entry);
    const engine = this.engine;
    if (engine) {
      // Drop queued chunks first so stopping the active chunk cannot start the next one.
      engine.clearQueue();
      engine.stop();
    }
  }

  private finish(entry: Utterance): void {
    entry.ended = true;
    this.cancelDrain?.();
    this.cancelDrain = null;
    this.endUtterance(entry.id);
    if (this.current === entry) {
      this.current = null;
      this.publish();
    }
  }

  private endUtterance(id: string): void {
    if (this.ended.includes(id)) return;
    this.ended.push(id);
    if (this.ended.length > ENDED_UTTERANCES) this.ended.shift();
  }

  private publish(): void {
    this.state = {
      utterance: this.current?.id ?? null,
      holder: this.holders.at(-1) ?? null,
    };
    for (const listener of this.listeners) listener();
  }
}

const sharedPlayers = new WeakMap<object, Map<string, SpeechPlayer>>();

/**
 * One player per app connection and agent. An app may keep several panels of one conversation
 * mounted (for example a stacked screen below the visible one); the daemon may route an
 * utterance to any of their observations, so they share the player and the most recently
 * mounted panel shows its stop control.
 */
export function sharedSpeechPlayer(
  connection: object,
  agentId: string,
  options: SpeechPlayerOptions,
): SpeechPlayer {
  let players = sharedPlayers.get(connection);
  if (!players) {
    players = new Map();
    sharedPlayers.set(connection, players);
  }
  let player = players.get(agentId);
  if (!player) {
    player = new SpeechPlayer(options);
    players.set(agentId, player);
  }
  return player;
}
