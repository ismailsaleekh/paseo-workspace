import assert from "node:assert/strict";
import { test } from "vitest";
import type { SpeechEvent } from "@getpaseo/protocol/pi-workspace/speech";
import type { AudioEngine, AudioPlaybackSource } from "@/audio/audio-engine-types";
import {
  SPEECH_DRAIN_LIMIT_MS,
  SPEECH_DRAIN_POLL_MS,
  SPEECH_TAIL_MS,
  SpeechPlayer,
  type SpeechReport,
} from "./speech-player";
import type { SpeechOrigin } from "./speech-player";

const utterance = "2b3c4d5e-1c1a-4a8e-9f3c-6f1f6d2f0a01";
const next = "3c4d5e6f-1c1a-4a8e-9f3c-6f1f6d2f0a01";
const format = "audio/pcm;rate=24000;bits=16";
const audio = btoa("\u0000\u0001".repeat(240));

/** Engine whose chunks finish only when the test says so, recording stop order. */
class ManualEngine implements AudioEngine {
  readonly calls: string[] = [];
  readonly started: AudioPlaybackSource[] = [];
  private readonly pending: Array<{
    audio: AudioPlaybackSource;
    resolve: (seconds: number) => void;
    reject: (error: Error) => void;
  }> = [];
  async initialize(): Promise<void> {}
  async destroy(): Promise<void> {
    this.calls.push("destroy");
  }
  async startCapture(): Promise<void> {
    throw new Error("Speech playback never captures audio");
  }
  async stopCapture(): Promise<void> {
    throw new Error("Speech playback never touches capture");
  }
  toggleMute(): boolean {
    throw new Error("Speech playback never touches the microphone");
  }
  isMuted(): boolean {
    return false;
  }
  play(source: AudioPlaybackSource): Promise<number> {
    this.calls.push("play");
    return new Promise((resolve, reject) => this.pending.push({ audio: source, resolve, reject }));
  }
  /** Finishes the oldest chunk the way an engine does: read bytes, play, report its duration. */
  async finishNext(seconds = 0.5): Promise<void> {
    const item = this.pending.shift();
    if (!item) throw new Error("No chunk is playing");
    try {
      await item.audio.arrayBuffer();
      this.started.push(item.audio);
      item.resolve(seconds);
    } catch (error) {
      item.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }
  stop(): void {
    this.calls.push("stop");
    if (this.ignoreStop) return;
    this.pending.shift()?.reject(new Error("Playback stopped"));
  }
  /** Models an engine that already dequeued the next chunk when stop() ran. */
  ignoreStop = false;
  clearQueue(): void {
    this.calls.push("clearQueue");
    for (const item of this.pending.splice(1)) item.reject(new Error("Playback stopped"));
  }
  isPlaying(): boolean {
    return this.pending.length > 0;
  }
}

function setup() {
  const engine = new ManualEngine();
  const reports: SpeechReport[] = [];
  let created = 0;
  const released: AudioEngine[] = [];
  const origin: SpeechOrigin = {
    report: (report) => {
      reports.push(report);
    },
  };
  const timers: Array<{ run: () => void; milliseconds: number; cancelled: boolean }> = [];
  let drained = true;
  let clock = 0;
  const speech = new SpeechPlayer({
    createEngine: () => {
      created += 1;
      return engine;
    },
    releaseEngine: (value) => {
      released.push(value);
    },
    outputDrained: () => drained,
    now: () => clock,
    schedule: (run, milliseconds) => {
      const entry = { run, milliseconds, cancelled: false };
      timers.push(entry);
      return () => {
        entry.cancelled = true;
      };
    },
  });
  /** Runs every pending scheduled check, including ones they schedule. */
  const runTimers = () => {
    for (let guard = 0; guard < 100; guard += 1) {
      const pending = timers.find((timer) => !timer.cancelled);
      if (!pending) return;
      pending.cancelled = true;
      pending.run();
    }
    throw new Error("Scheduled checks never settled");
  };
  /** The player as one observation drives it. */
  const player = {
    accept: (event: SpeechEvent) => speech.accept(event, origin),
    stop: () => speech.stop(),
    reset: () => speech.reset(origin),
    dispose: () => speech.dispose(),
    getSnapshot: () => speech.getSnapshot(),
  };
  return {
    engine,
    reports,
    player,
    speech,
    origin,
    released,
    timers,
    runTimers,
    setDrained: (value: boolean) => {
      drained = value;
    },
    advance: (milliseconds: number) => {
      clock += milliseconds;
    },
    created: () => created,
  };
}

const chunk = (index: number, id = utterance): SpeechEvent => ({
  type: "audio",
  utterance: id,
  index,
  format,
  audio,
});
const flush = async () => {
  for (let index = 0; index < 10; index += 1) await Promise.resolve();
};

test("the audio engine is created lazily on the first speech audio", () => {
  const { player, created } = setup();
  assert.equal(created(), 0);
  player.accept(chunk(0));
  assert.equal(created(), 1);
  player.accept(chunk(1));
  assert.equal(created(), 1);
});

test("completion is reported only after every delivered chunk played", async () => {
  const { engine, player, reports, runTimers } = setup();
  player.accept(chunk(0));
  player.accept(chunk(1));
  player.accept({ type: "end", utterance, chunks: 2 });
  assert.equal(player.getSnapshot().utterance, utterance);
  await engine.finishNext(1.25);
  await flush();
  runTimers();
  assert.deepEqual(reports, []);
  await engine.finishNext(0.75);
  await flush();
  runTimers();
  assert.deepEqual(reports, [{ type: "completed", utterance, durationMs: 2000 }]);
  assert.equal(player.getSnapshot().utterance, null);
  assert.equal(engine.started[0]?.type, format);
});

test("stop drops queued chunks before stopping the active one, reports stopped and ignores late frames", async () => {
  const { engine, player, reports } = setup();
  player.accept(chunk(0));
  player.accept(chunk(1));
  await engine.finishNext(0.5);
  await flush();
  player.accept(chunk(2));
  player.stop();
  assert.deepEqual(engine.calls.slice(-2), ["clearQueue", "stop"]);
  assert.deepEqual(reports, [{ type: "stopped", utterance, durationMs: 500 }]);
  assert.equal(player.getSnapshot().utterance, null);
  const callsAfterStop = engine.calls.length;
  player.accept(chunk(3));
  player.accept({ type: "end", utterance, chunks: 4 });
  await flush();
  assert.equal(
    engine.calls.length,
    callsAfterStop,
    "late frames of a stopped utterance never play",
  );
  assert.equal(reports.length, 1);
  player.stop();
  assert.equal(reports.length, 1, "stopping with nothing playing reports nothing");
});

test("a chunk the engine already dequeued cannot reach the speaker after stop", async () => {
  const { engine, player, reports } = setup();
  player.accept(chunk(0));
  engine.ignoreStop = true;
  player.stop();
  await engine.finishNext();
  await flush();
  assert.equal(engine.started.length, 0, "the stopped chunk's bytes are never handed over");
  assert.deepEqual(reports, [{ type: "stopped", utterance, durationMs: 0 }]);
});

test("cancel from the daemon and observation reset silence playback without a report", async () => {
  const { engine, player, reports } = setup();
  player.accept(chunk(0));
  player.accept({ type: "cancel", utterance });
  assert.deepEqual(engine.calls.slice(-2), ["clearQueue", "stop"]);
  player.accept(chunk(0, next));
  player.reset();
  await flush();
  assert.deepEqual(reports, []);
  assert.equal(player.getSnapshot().utterance, null);
});

test("out-of-order audio and engine failures are explicit failures", async () => {
  const { engine, player, reports } = setup();
  player.accept(chunk(1));
  assert.deepEqual(reports, [
    {
      type: "failed",
      utterance,
      error: { code: "SPEECH_SEQUENCE", message: "Speech audio arrived out of order" },
    },
  ]);
  player.accept(chunk(0, next));
  engine.stop();
  await flush();
  assert.equal(reports.at(-1)?.type, "failed");
  assert.throws(() => player.accept({ type: "audio", utterance: next, index: 1, format }));
});

test("dispose releases the engine without touching capture", () => {
  const { engine, player, released } = setup();
  player.accept(chunk(0));
  player.dispose();
  assert.deepEqual(released, [engine]);
  assert.equal(engine.calls.includes("destroy"), false);
});

test("one player serves several origins: reports go to the delivering origin, others' resets are ignored", () => {
  const { speech, origin, reports } = setup();
  const otherReports: SpeechReport[] = [];
  const other: SpeechOrigin = {
    report: (report) => {
      otherReports.push(report);
    },
  };
  speech.accept(chunk(0), other);
  assert.equal(speech.getSnapshot().utterance, utterance);
  speech.reset(origin);
  assert.equal(speech.getSnapshot().utterance, utterance, "another origin's reset is ignored");
  speech.stop();
  assert.deepEqual(otherReports, [{ type: "stopped", utterance, durationMs: 0 }]);
  assert.deepEqual(reports, []);
});

test("completion waits for the platform output to drain, stops the platform player, then reports", async () => {
  const { engine, player, reports, timers, runTimers, setDrained } = setup();
  setDrained(false);
  player.accept(chunk(0));
  player.accept({ type: "end", utterance, chunks: 1 });
  await engine.finishNext(2);
  await flush();
  assert.deepEqual(reports, [], "a chunk's timer is not the end of output");
  const poll = timers.find((timer) => !timer.cancelled);
  assert.equal(poll?.milliseconds, SPEECH_DRAIN_POLL_MS);
  if (!poll) throw new Error("No drain check was scheduled");
  poll.cancelled = true;
  poll.run();
  assert.deepEqual(reports, [], "still writing output");
  assert.equal(player.getSnapshot().utterance, utterance, "stop stays available while draining");
  setDrained(true);
  const before = engine.calls.length;
  runTimers();
  assert.equal(
    timers.some((timer) => timer.milliseconds === SPEECH_TAIL_MS),
    true,
    "the device plays out its last buffer first",
  );
  assert.deepEqual(
    engine.calls.slice(before),
    ["clearQueue", "stop"],
    "no idle player stays started",
  );
  assert.deepEqual(reports, [{ type: "completed", utterance, durationMs: 2000 }]);
  assert.equal(player.getSnapshot().utterance, null);
});

test("output that never drains within the bound is an explicit failure, never a completion", async () => {
  const { engine, player, reports, timers, setDrained, advance } = setup();
  setDrained(false);
  player.accept(chunk(0));
  player.accept({ type: "end", utterance, chunks: 1 });
  await engine.finishNext(2);
  await flush();
  const poll = () => {
    const pending = timers.find((timer) => !timer.cancelled);
    if (!pending) throw new Error("No drain check was scheduled");
    pending.cancelled = true;
    pending.run();
  };
  advance(SPEECH_DRAIN_LIMIT_MS - 1);
  poll();
  assert.deepEqual(reports, [], "still within the bound");
  advance(1);
  poll();
  assert.deepEqual(reports, [
    {
      type: "failed",
      utterance,
      error: {
        code: "PLAYBACK_DRAIN_TIMEOUT",
        message: "The device did not finish playing the speech audio in time",
      },
    },
  ]);
  assert.equal(
    timers.some((timer) => !timer.cancelled),
    false,
    "nothing completes the utterance afterwards",
  );
  assert.equal(player.getSnapshot().utterance, null);
});

test("a stop while the output drains is reported as stopped, never completed", async () => {
  const { engine, player, reports, runTimers, setDrained } = setup();
  setDrained(false);
  player.accept(chunk(0));
  player.accept({ type: "end", utterance, chunks: 1 });
  await engine.finishNext(1);
  await flush();
  player.stop();
  setDrained(true);
  runTimers();
  assert.deepEqual(reports, [{ type: "stopped", utterance, durationMs: 1000 }]);
});
