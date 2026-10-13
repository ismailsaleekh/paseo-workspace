import { VisualFailure } from "@getpaseo/protocol/pi-workspace/contracts";
import {
  SPEECH_CHUNK_SECONDS,
  pcmFormat,
  type SpeechClientSignal,
  type SpeechPlayback,
  type SpeechResult,
  type SpeechVoice,
} from "@getpaseo/protocol/pi-workspace/speech";
import type { TextToSpeechProvider } from "../speech/speech-provider.js";

/** Kokoro English v0.19 speakers of the named agent voices (am_michael, am_adam). */
export const SPEECH_VOICE_SPEAKERS: Record<SpeechVoice, number> = { michael: 6, adam: 5 };
/** Segments longer than this are split at a word boundary so synthesis stays incremental. */
export const SPEECH_SEGMENT_CHARS = 280;
/** Extra time a client gets beyond the delivered audio to report the end of playback. */
export const SPEECH_COMPLETION_GRACE_MS = 30_000;

export type ScheduleSpeechDeadline = (expire: () => void, milliseconds: number) => () => void;
function scheduleSpeechDeadline(expire: () => void, milliseconds: number): () => void {
  const timer = setTimeout(expire, milliseconds);
  return () => clearTimeout(timer);
}

/**
 * Splits text into sentence-sized segments without changing it: joining the segments yields the
 * input exactly. Breaks follow sentence punctuation or line breaks; an overlong sentence is split
 * at whitespace. Words are never rewritten, reordered or dropped.
 */
export function segmentSpeechText(text: string): string[] {
  const segments: string[] = [];
  let start = 0;
  const boundary = /[.!?…]+["'”’)\]]*\s+|\n+/g;
  for (let match = boundary.exec(text); match !== null; match = boundary.exec(text)) {
    const end = match.index + match[0].length;
    pushBounded(segments, text.slice(start, end));
    start = end;
  }
  if (start < text.length) pushBounded(segments, text.slice(start));
  return segments;
}

function pushBounded(segments: string[], segment: string): void {
  let rest = segment;
  while (rest.length > SPEECH_SEGMENT_CHARS) {
    const window = rest.slice(0, SPEECH_SEGMENT_CHARS);
    const space = Math.max(window.lastIndexOf(" "), window.lastIndexOf("\t"));
    const cut = space > 0 ? space + 1 : SPEECH_SEGMENT_CHARS;
    segments.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest.length > 0) segments.push(rest);
}

/** Sample rate of the 16-bit PCM a local TTS engine returned, or null for another format. */
export function pcmSampleRate(format: string): number | null {
  const match = /^(?:audio\/)?pcm;rate=(\d{4,6})(?:;bits=16)?$/i.exec(format.trim());
  if (!match) return null;
  const rate = Number(match[1]);
  return Number.isInteger(rate) && rate > 0 ? rate : null;
}

/** Splits PCM16 audio into whole-sample chunks of at most {@link SPEECH_CHUNK_SECONDS}. */
export function chunkPcm(pcm: Buffer, sampleRate: number): Buffer[] {
  const chunkBytes = sampleRate * 2 * SPEECH_CHUNK_SECONDS;
  const usable = pcm.length - (pcm.length % 2);
  const chunks: Buffer[] = [];
  for (let offset = 0; offset < usable; offset += chunkBytes)
    chunks.push(pcm.subarray(offset, Math.min(usable, offset + chunkBytes)));
  return chunks;
}

/** The one playback client an utterance was routed to. */
export interface SpeechTarget {
  readonly client: string;
  send(playback: SpeechPlayback): void;
}
export interface SpeakInput {
  utterance: string;
  text: string;
  target: SpeechTarget;
  tts: TextToSpeechProvider;
  signal: AbortSignal;
  /** Model speaker of the requested voice; the engine default when absent. */
  speakerId?: number;
}
interface ActiveUtterance {
  utterance: string;
  target: SpeechTarget;
  /** Aborts synthesis; set when the utterance reaches a terminal state. */
  synthesis: AbortController;
  delivered: boolean;
  settled: boolean;
  cancelDeadline: (() => void) | null;
  resolve(result: SpeechResult): void;
  reject(error: VisualFailure): void;
}

/**
 * Utterance lifecycle: sentence-by-sentence synthesis streamed to one client, completion only from
 * the client's playback report, user stop, cancellation and disconnection. No session input lock
 * is held; each utterance only owns its synthesis loop and its pending tool result.
 */
export class SpeechUtterances {
  private readonly active = new Map<string, ActiveUtterance>();

  constructor(private readonly scheduleDeadline: ScheduleSpeechDeadline = scheduleSpeechDeadline) {}

  speak(input: SpeakInput): Promise<SpeechResult> {
    if (this.active.has(input.utterance))
      return Promise.reject(
        new VisualFailure(
          "DUPLICATE_UTTERANCE",
          "Utterance identity is already in use",
          input.utterance,
        ),
      );
    if (input.signal.aborted)
      return Promise.reject(
        new VisualFailure("CANCELLED", "Speech was cancelled", input.utterance),
      );
    return new Promise<SpeechResult>((resolve, reject) => {
      const entry: ActiveUtterance = {
        utterance: input.utterance,
        target: input.target,
        synthesis: new AbortController(),
        delivered: false,
        settled: false,
        cancelDeadline: null,
        resolve,
        reject,
      };
      this.active.set(input.utterance, entry);
      const abort = () => {
        this.fail(entry, new VisualFailure("CANCELLED", "Speech was cancelled", input.utterance));
        this.sendCancel(entry);
      };
      input.signal.addEventListener("abort", abort, { once: true });
      entry.synthesis.signal.addEventListener(
        "abort",
        () => input.signal.removeEventListener("abort", abort),
        { once: true },
      );
      void this.synthesize(entry, input.text, input.tts, input.speakerId).catch(
        (error: unknown) => {
          const failure =
            error instanceof VisualFailure
              ? error
              : new VisualFailure(
                  "TTS_FAILED",
                  `Local speech synthesis failed: ${error instanceof Error ? error.message : String(error)}`,
                  input.utterance,
                );
          if (this.fail(entry, failure)) this.sendCancel(entry);
        },
      );
    });
  }

  private async synthesize(
    entry: ActiveUtterance,
    text: string,
    tts: TextToSpeechProvider,
    speakerId: number | undefined,
  ) {
    const signal = entry.synthesis.signal;
    let index = 0;
    let audioMs = 0;
    for (const segment of segmentSpeechText(text)) {
      if (segment.trim().length === 0) continue;
      const result = await tts.synthesizeSpeech(segment, { speakerId });
      const parts: Buffer[] = [];
      for await (const part of result.stream) {
        if (!Buffer.isBuffer(part))
          throw new VisualFailure(
            "TTS_FAILED",
            "Local speech engine returned non-binary audio",
            entry.utterance,
          );
        parts.push(part);
      }
      // A stop or cancellation during synthesis discards the late audio; nothing more is sent.
      if (signal.aborted) return;
      const sampleRate = pcmSampleRate(result.format);
      if (sampleRate === null)
        throw new VisualFailure(
          "TTS_FAILED",
          `Local speech engine returned unsupported audio (${result.format})`,
          entry.utterance,
        );
      for (const chunk of chunkPcm(Buffer.concat(parts), sampleRate)) {
        entry.target.send({
          type: "audio",
          utterance: entry.utterance,
          index,
          format: pcmFormat(sampleRate),
          sampleRate,
          audio: chunk.toString("base64"),
        });
        index += 1;
        audioMs += (chunk.length / 2 / sampleRate) * 1000;
      }
    }
    if (signal.aborted) return;
    if (index === 0)
      throw new VisualFailure(
        "TTS_FAILED",
        "Local speech engine produced no audio",
        entry.utterance,
      );
    entry.target.send({ type: "end", utterance: entry.utterance, chunks: index });
    entry.delivered = true;
    entry.cancelDeadline = this.scheduleDeadline(
      () => {
        if (
          this.fail(
            entry,
            new VisualFailure(
              "SPEECH_TIMEOUT",
              "The playback client did not report the end of playback",
              entry.utterance,
            ),
          )
        )
          this.sendCancel(entry);
      },
      Math.ceil(audioMs) + SPEECH_COMPLETION_GRACE_MS,
    );
  }

  /** A playback report from the client the utterance was routed to. */
  receive(client: string, signal: Exclude<SpeechClientSignal, { type: "ready" }>): void {
    const entry = this.active.get(signal.utterance);
    if (!entry || entry.target.client !== client)
      throw new VisualFailure(
        "STALE_UTTERANCE",
        "Speech report does not belong to an active utterance of this client",
        signal.utterance,
      );
    switch (signal.type) {
      case "completed":
        if (!entry.delivered)
          throw new VisualFailure(
            "INVALID_SPEECH_REPORT",
            "Playback cannot complete before all audio was delivered",
            signal.utterance,
          );
        this.succeed(entry, "completed", signal.durationMs);
        return;
      case "stopped":
        this.succeed(entry, "stopped", signal.durationMs);
        return;
      case "failed":
        this.fail(
          entry,
          new VisualFailure(signal.error.code, signal.error.message, signal.utterance),
        );
        return;
    }
  }

  /** The client stopped displaying the conversation: its utterances can no longer play. */
  release(client: string): void {
    for (const entry of this.active.values()) {
      if (entry.target.client !== client) continue;
      this.fail(
        entry,
        new VisualFailure(
          "CLIENT_DISCONNECTED",
          "The playback client stopped displaying this conversation",
          entry.utterance,
        ),
      );
    }
  }

  close(): void {
    for (const entry of this.active.values())
      this.fail(entry, new VisualFailure("HOST_STOPPED", "Speech host stopped", entry.utterance));
  }

  isActive(utterance: string): boolean {
    return this.active.has(utterance);
  }

  private finish(entry: ActiveUtterance): boolean {
    if (entry.settled) return false;
    entry.settled = true;
    this.active.delete(entry.utterance);
    entry.cancelDeadline?.();
    entry.synthesis.abort();
    return true;
  }

  private succeed(entry: ActiveUtterance, status: SpeechResult["status"], durationMs: number) {
    if (!this.finish(entry)) return;
    entry.resolve({
      kind: "speech",
      utterance: entry.utterance,
      status,
      client: entry.target.client,
      durationMs,
    });
  }

  private fail(entry: ActiveUtterance, error: VisualFailure): boolean {
    if (!this.finish(entry)) return false;
    entry.reject(error);
    return true;
  }

  private sendCancel(entry: ActiveUtterance): void {
    try {
      entry.target.send({ type: "cancel", utterance: entry.utterance });
    } catch (error) {
      // The client is gone; its release already ends playback. Other failures are bugs.
      if (!(error instanceof VisualFailure)) throw error;
    }
  }
}
