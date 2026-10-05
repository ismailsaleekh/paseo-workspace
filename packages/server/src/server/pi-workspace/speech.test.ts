import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { test } from "vitest";
import { VisualFailure } from "@getpaseo/protocol/pi-workspace/contracts";
import type { SpeechPlayback } from "@getpaseo/protocol/pi-workspace/speech";
import type { SpeechStreamResult, TextToSpeechProvider } from "../speech/speech-provider.js";
import {
  SpeechUtterances,
  chunkPcm,
  pcmSampleRate,
  segmentSpeechText,
  type ScheduleSpeechDeadline,
} from "./speech.js";

const utterance = "5b0b4c5e-1c1a-4a8e-9f3c-6f1f6d2f0a01";
const client = "client-generation-1";

class FakeTts implements TextToSpeechProvider {
  readonly texts: string[] = [];
  private readonly gates: Array<() => void> = [];
  constructor(private readonly options: { gated?: boolean; fail?: string } = {}) {}
  async synthesizeSpeech(text: string): Promise<SpeechStreamResult> {
    this.texts.push(text);
    if (this.options.fail) throw new Error(this.options.fail);
    if (this.options.gated) await new Promise<void>((resolve) => this.gates.push(resolve));
    // 0.1 s of 24 kHz PCM16 per segment, split in two stream parts.
    const pcm = Buffer.alloc(4800, 1);
    return {
      stream: Readable.from([pcm.subarray(0, 2400), pcm.subarray(2400)]),
      format: "pcm;rate=24000",
    };
  }
  release(): void {
    this.gates.shift()?.();
  }
  get waiting(): number {
    return this.gates.length;
  }
}

class Target {
  readonly client = client;
  readonly sent: SpeechPlayback[] = [];
  send = (playback: SpeechPlayback): void => {
    this.sent.push(playback);
  };
}

const manualDeadlines = () => {
  const deadlines: Array<{ expire: () => void; milliseconds: number; cancelled: boolean }> = [];
  const schedule: ScheduleSpeechDeadline = (expire, milliseconds) => {
    const entry = { expire, milliseconds, cancelled: false };
    deadlines.push(entry);
    return () => {
      entry.cancelled = true;
    };
  };
  return { deadlines, schedule };
};

const settle = async () => {
  for (let index = 0; index < 20; index += 1) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
};

test("segmentation keeps the exact text: joined segments equal the input and words are never rewritten", () => {
  const text =
    "Forty two blue cubes, no wait, forty three. Is it?  Yes!\nNew line… “Quoted.” Then the end";
  const segments = segmentSpeechText(text);
  assert.equal(segments.join(""), text);
  assert.deepEqual(segments, [
    "Forty two blue cubes, no wait, forty three. ",
    "Is it?  ",
    "Yes!\n",
    "New line… ",
    "“Quoted.” ",
    "Then the end",
  ]);
  const long = Array.from({ length: 120 }, (_, index) => `word${index}`).join(" ");
  const parts = segmentSpeechText(long);
  assert.equal(parts.join(""), long);
  assert.ok(parts.length > 1);
  for (const part of parts) assert.ok(part.length <= 280);
});

test("PCM formats and chunking follow the engine's sample rate", () => {
  assert.equal(pcmSampleRate("pcm;rate=24000"), 24000);
  assert.equal(pcmSampleRate("audio/pcm;rate=16000;bits=16"), 16000);
  assert.equal(pcmSampleRate("mp3"), null);
  const chunks = chunkPcm(Buffer.alloc(24000 * 2 * 25 + 1), 24000);
  assert.deepEqual(
    chunks.map((chunk) => chunk.length),
    [480000, 480000, 240000],
  );
});

test("each sentence is synthesized and sent in order; the result waits for the client's playback report", async () => {
  const tts = new FakeTts();
  const target = new Target();
  const { deadlines, schedule } = manualDeadlines();
  const utterances = new SpeechUtterances(schedule);
  let resolved = false;
  const speaking = utterances
    .speak({
      utterance,
      text: "First sentence. Second sentence.",
      target,
      tts,
      signal: new AbortController().signal,
    })
    .then((result) => {
      resolved = true;
      return result;
    });
  await settle();
  assert.deepEqual(tts.texts, ["First sentence. ", "Second sentence."]);
  assert.deepEqual(
    target.sent.map((playback) => [playback.type, "index" in playback ? playback.index : null]),
    [
      ["audio", 0],
      ["audio", 1],
      ["end", null],
    ],
  );
  const first = target.sent[0];
  assert.equal(first?.type === "audio" ? first.format : "", "audio/pcm;rate=24000;bits=16");
  assert.equal(resolved, false, "delivery is never reported as completion");
  assert.equal(deadlines.length, 1);
  utterances.receive(client, { type: "completed", utterance, durationMs: 200 });
  assert.deepEqual(await speaking, {
    kind: "speech",
    utterance,
    status: "completed",
    client,
    durationMs: 200,
  });
  assert.equal(deadlines[0]?.cancelled, true);
  assert.equal(utterances.isActive(utterance), false);
});

test("the first sentence is sent before later sentences are synthesized", async () => {
  const tts = new FakeTts({ gated: true });
  const target = new Target();
  const utterances = new SpeechUtterances(manualDeadlines().schedule);
  const speaking = utterances.speak({
    utterance,
    text: "One. Two. Three.",
    target,
    tts,
    signal: new AbortController().signal,
  });
  await settle();
  assert.equal(tts.waiting, 1);
  tts.release();
  await settle();
  assert.deepEqual(
    target.sent.map((playback) => playback.type),
    ["audio"],
  );
  assert.deepEqual(tts.texts, ["One. ", "Two. "]);
  utterances.receive(client, { type: "stopped", utterance, durationMs: 50 });
  const result = await speaking;
  assert.equal(result.status, "stopped");
  tts.release();
  await settle();
  assert.deepEqual(tts.texts, ["One. ", "Two. "], "a stop cancels the remaining synthesis");
  assert.deepEqual(
    target.sent.map((playback) => playback.type),
    ["audio"],
    "late audio of a stopped utterance is never sent",
  );
});

test("completion before all audio was delivered is refused", async () => {
  const tts = new FakeTts({ gated: true });
  const utterances = new SpeechUtterances(manualDeadlines().schedule);
  const speaking = utterances.speak({
    utterance,
    text: "Only one.",
    target: new Target(),
    tts,
    signal: new AbortController().signal,
  });
  await settle();
  assert.throws(
    () => utterances.receive(client, { type: "completed", utterance, durationMs: 1 }),
    (error: unknown) => error instanceof VisualFailure && error.code === "INVALID_SPEECH_REPORT",
  );
  assert.throws(
    () => utterances.receive("other-client", { type: "stopped", utterance, durationMs: 1 }),
    (error: unknown) => error instanceof VisualFailure && error.code === "STALE_UTTERANCE",
  );
  utterances.release(client);
  await assert.rejects(
    speaking,
    (error: unknown) => error instanceof VisualFailure && error.code === "CLIENT_DISCONNECTED",
  );
});

test("tool cancellation tells the client to cancel; synthesis failures and silent engines fail explicitly", async () => {
  const target = new Target();
  const utterances = new SpeechUtterances(manualDeadlines().schedule);
  const controller = new AbortController();
  const speaking = utterances.speak({
    utterance,
    text: "Cancel me.",
    target,
    tts: new FakeTts({ gated: true }),
    signal: controller.signal,
  });
  controller.abort();
  await assert.rejects(
    speaking,
    (error: unknown) => error instanceof VisualFailure && error.code === "CANCELLED",
  );
  assert.deepEqual(target.sent, [{ type: "cancel", utterance }]);

  await assert.rejects(
    utterances.speak({
      utterance,
      text: "Broken.",
      target: new Target(),
      tts: new FakeTts({ fail: "model missing" }),
      signal: new AbortController().signal,
    }),
    (error: unknown) =>
      error instanceof VisualFailure &&
      error.code === "TTS_FAILED" &&
      error.message.includes("model missing") &&
      error.artifactId === utterance,
  );

  await assert.rejects(
    utterances.speak({
      utterance,
      text: "   ",
      target: new Target(),
      tts: new FakeTts(),
      signal: new AbortController().signal,
    }),
    (error: unknown) => error instanceof VisualFailure && error.code === "TTS_FAILED",
  );
});

test("a client that never reports the end of playback times out explicitly", async () => {
  const target = new Target();
  const { deadlines, schedule } = manualDeadlines();
  const utterances = new SpeechUtterances(schedule);
  const speaking = utterances.speak({
    utterance,
    text: "Hello.",
    target,
    tts: new FakeTts(),
    signal: new AbortController().signal,
  });
  await settle();
  const deadline = deadlines[0];
  if (!deadline) throw new Error("No completion deadline was scheduled");
  assert.ok(deadline.milliseconds >= 30_000);
  deadline.expire();
  await assert.rejects(
    speaking,
    (error: unknown) => error instanceof VisualFailure && error.code === "SPEECH_TIMEOUT",
  );
  assert.equal(target.sent.at(-1)?.type, "cancel");
});
