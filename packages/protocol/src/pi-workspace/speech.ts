import { z } from "zod";

/**
 * Agent speech (`speak`) wire shapes. Pure structural schemas shared by the Pi package, the daemon
 * and app clients. This module must not import `contracts.ts` (which imports it).
 */
export const SPEECH_TEXT_CHARS = 20_000;
/** A speak request lasts as long as its playback, so it has its own operation bound. */
export const SPEECH_OPERATION_TIMEOUT_MS = 60 * 60 * 1000;
/** Longest audio carried by one speech event. */
export const SPEECH_CHUNK_SECONDS = 10;
/** Bound on one base64 audio payload (10 s of 24 kHz PCM16 is about 640 KiB of base64). */
export const SPEECH_AUDIO_CHARS = 1024 * 1024;
export const SPEECH_DURATION_MS_LIMIT = 24 * 60 * 60 * 1000;
/** The agent's named voices. Michael is the default; the user may call him Mike. */
export const SpeechVoiceSchema = z.enum(["michael", "adam"]);
export type SpeechVoice = z.infer<typeof SpeechVoiceSchema>;
export const DEFAULT_SPEECH_VOICE: SpeechVoice = "michael";
/** The kind of app that plays speech: the desktop (or web) app or the phone app. */
export const SpeechDeviceSchema = z.enum(["computer", "phone"]);
export type SpeechDevice = z.infer<typeof SpeechDeviceSchema>;
const PCM_FORMAT = /^audio\/pcm;rate=\d{4,6};bits=16$/;

const UtteranceIdSchema = z.string().uuid();
const SpeechErrorSchema = z
  .object({
    code: z.string().min(1).max(128),
    message: z.string().min(1).max(2048),
  })
  .strict();
const DurationSchema = z.number().int().nonnegative().max(SPEECH_DURATION_MS_LIMIT);

export const SpeechStatusSchema = z.enum(["completed", "stopped"]);
/** Terminal successful outcome of one utterance. Failures travel as error frames. */
export const SpeechResultSchema = z
  .object({
    kind: z.literal("speech"),
    utterance: UtteranceIdSchema,
    status: SpeechStatusSchema,
    client: z.string().min(1).max(256),
    durationMs: DurationSchema,
  })
  .strict();
export type SpeechResult = z.infer<typeof SpeechResultSchema>;
export type SpeechStatus = z.infer<typeof SpeechStatusSchema>;

/** Daemon to the one playback client. Flat on purpose: generated outbound validators stay simple. */
export const SpeechEventSchema = z
  .object({
    type: z.enum(["audio", "end", "cancel"]),
    utterance: UtteranceIdSchema,
    index: z.number().int().nonnegative().max(1_000_000).optional(),
    format: z.string().regex(PCM_FORMAT).optional(),
    audio: z.string().min(4).max(SPEECH_AUDIO_CHARS).optional(),
    chunks: z.number().int().nonnegative().max(1_000_000).optional(),
  })
  .strict();
export type SpeechEvent = z.infer<typeof SpeechEventSchema>;

export type SpeechPlayback =
  | {
      type: "audio";
      utterance: string;
      index: number;
      format: string;
      sampleRate: number;
      audio: string;
    }
  | { type: "end"; utterance: string; chunks: number }
  | { type: "cancel"; utterance: string };

/** Typed view of a structurally valid event; null when its fields do not belong to its type. */
export function parseSpeechEvent(event: SpeechEvent): SpeechPlayback | null {
  switch (event.type) {
    case "audio": {
      if (
        event.index === undefined ||
        event.format === undefined ||
        event.audio === undefined ||
        event.chunks !== undefined
      )
        return null;
      const sampleRate = Number(/rate=(\d+)/.exec(event.format)?.[1]);
      if (!Number.isInteger(sampleRate) || sampleRate <= 0) return null;
      return {
        type: "audio",
        utterance: event.utterance,
        index: event.index,
        format: event.format,
        sampleRate,
        audio: event.audio,
      };
    }
    case "end":
      if (
        event.chunks === undefined ||
        event.index !== undefined ||
        event.format !== undefined ||
        event.audio !== undefined
      )
        return null;
      return { type: "end", utterance: event.utterance, chunks: event.chunks };
    case "cancel":
      if (
        event.chunks !== undefined ||
        event.index !== undefined ||
        event.format !== undefined ||
        event.audio !== undefined
      )
        return null;
      return { type: "cancel", utterance: event.utterance };
  }
}

export function speechEvent(playback: SpeechPlayback): SpeechEvent {
  switch (playback.type) {
    case "audio":
      return {
        type: "audio",
        utterance: playback.utterance,
        index: playback.index,
        format: playback.format,
        audio: playback.audio,
      };
    case "end":
      return { type: "end", utterance: playback.utterance, chunks: playback.chunks };
    case "cancel":
      return { type: "cancel", utterance: playback.utterance };
  }
}

export function pcmFormat(sampleRate: number): string {
  return `audio/pcm;rate=${sampleRate};bits=16`;
}

/** Playback client to the daemon, sent through the existing visual receipt request. */
export const SpeechReceiptSchema = z
  .object({
    kind: z.literal("speech"),
    clientGeneration: z.string().uuid(),
    type: z.enum(["ready", "completed", "stopped", "failed"]),
    utterance: UtteranceIdSchema.optional(),
    durationMs: DurationSchema.optional(),
    error: SpeechErrorSchema.optional(),
  })
  .strict();
export type SpeechReceipt = z.infer<typeof SpeechReceiptSchema>;

export type SpeechClientSignal =
  | { type: "ready" }
  | { type: "completed"; utterance: string; durationMs: number }
  | { type: "stopped"; utterance: string; durationMs: number }
  | { type: "failed"; utterance: string; error: { code: string; message: string } };

/** Typed view of a structurally valid receipt; null when its fields do not belong to its type. */
export function parseSpeechReceipt(receipt: SpeechReceipt): SpeechClientSignal | null {
  switch (receipt.type) {
    case "ready":
      if (
        receipt.utterance !== undefined ||
        receipt.durationMs !== undefined ||
        receipt.error !== undefined
      )
        return null;
      return { type: "ready" };
    case "completed":
    case "stopped":
      if (
        receipt.utterance === undefined ||
        receipt.durationMs === undefined ||
        receipt.error !== undefined
      )
        return null;
      return { type: receipt.type, utterance: receipt.utterance, durationMs: receipt.durationMs };
    case "failed":
      if (
        receipt.utterance === undefined ||
        receipt.error === undefined ||
        receipt.durationMs !== undefined
      )
        return null;
      return { type: "failed", utterance: receipt.utterance, error: receipt.error };
  }
}

export function speechReceipt(clientGeneration: string, signal: SpeechClientSignal): SpeechReceipt {
  return { kind: "speech", clientGeneration, ...signal };
}
