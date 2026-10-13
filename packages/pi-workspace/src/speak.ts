import { randomUUID } from "node:crypto";
import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { z } from "zod";
import { VisualFailure } from "@getpaseo/protocol/pi-workspace/contracts";
import {
  SPEECH_DURATION_MS_LIMIT,
  SPEECH_TEXT_CHARS,
  SpeechDeviceSchema,
  SpeechResultSchema,
  SpeechVoiceSchema,
} from "@getpaseo/protocol/pi-workspace/speech";
import type { SpeechToolConnection } from "./connection.js";

const objectOptions = { additionalProperties: false };
export const speakParameters = Type.Object(
  {
    text: Type.String({ minLength: 1, maxLength: SPEECH_TEXT_CHARS }),
    voice: Type.Optional(
      Type.Union([Type.Literal("michael"), Type.Literal("adam")], {
        description:
          "Speaking voice. Michael (the user may call him Mike) is the default; use Adam only when the user asks for Adam.",
      }),
    ),
    device: Type.Optional(
      Type.Union([Type.Literal("computer"), Type.Literal("phone")], {
        description:
          "Only when the user asks for a device. Omit to play where the user is talking from.",
      }),
    ),
  },
  objectOptions,
);
const Utterance = Type.String({ minLength: 1, maxLength: 256 });
const speakOutputSchema = Type.Union([
  Type.Object(
    {
      kind: Type.Literal("speech"),
      utterance: Utterance,
      status: Type.Union([Type.Literal("completed"), Type.Literal("stopped")]),
      client: Type.String({ minLength: 1, maxLength: 256 }),
      durationMs: Type.Integer({ minimum: 0, maximum: SPEECH_DURATION_MS_LIMIT }),
    },
    objectOptions,
  ),
  Type.Object(
    {
      kind: Type.Literal("error"),
      id: Type.Union([Utterance, Type.Null()]),
      utterance: Type.Union([Utterance, Type.Null()]),
      status: Type.Literal("failed"),
      error: Type.Object({ code: Type.String(), message: Type.String() }, objectOptions),
    },
    objectOptions,
  ),
]);

const SpeakInputSchema = z
  .object({
    text: z
      .string()
      .min(1)
      .max(SPEECH_TEXT_CHARS)
      .refine((text) => text.trim().length > 0, "Text has no words to speak"),
    voice: SpeechVoiceSchema.optional(),
    device: SpeechDeviceSchema.optional(),
  })
  .strict();

export interface SpeakSuccess {
  kind: "speech";
  utterance: string;
  status: "completed" | "stopped";
  client: string;
  durationMs: number;
}
export interface SpeakFailure {
  kind: "error";
  /** Same identity as `utterance`, in the error placement shared with the visual tools. */
  id: string | null;
  utterance: string | null;
  status: "failed";
  error: { code: string; message: string };
}
export type SpeakDetails = SpeakSuccess | SpeakFailure;
type SpeakToolResult = Awaited<
  ReturnType<ToolDefinition<typeof speakParameters, SpeakDetails>["execute"]>
>;

export interface ExecuteSpeakInput {
  input: unknown;
  connection: SpeechToolConnection;
  signal: AbortSignal | undefined;
  createUtterance?: () => string;
}

function failure(utterance: string | null, code: string, message: string): SpeakFailure {
  return { kind: "error", id: utterance, utterance, status: "failed", error: { code, message } };
}

/**
 * Sends the supplied text verbatim (no trimming, rewriting or summarising) and resolves with the
 * host's terminal playback outcome. Acceptance or enqueueing is never reported as completion.
 */
export async function executeSpeakTool(input: ExecuteSpeakInput): Promise<SpeakDetails> {
  const parsed = SpeakInputSchema.safeParse(input.input);
  if (!parsed.success)
    return failure(
      null,
      "INVALID_ARGUMENT",
      "speak needs non-blank text of 1-20000 characters, an optional voice (michael or adam) and an optional device (computer or phone)",
    );
  const utterance = (input.createUtterance ?? randomUUID)();
  try {
    if (input.signal?.aborted)
      throw new VisualFailure("CANCELLED", "Speech was cancelled", utterance);
    const { voice, device } = parsed.data;
    const received: unknown = await input.connection.speak(
      {
        utterance,
        text: parsed.data.text,
        ...(voice === undefined ? {} : { voice }),
        ...(device === undefined ? {} : { device }),
      },
      input.signal,
    );
    const result = SpeechResultSchema.safeParse(received);
    if (!result.success || result.data.utterance !== utterance)
      throw new VisualFailure("INVALID_REPLY", "Host returned an invalid speech result", utterance);
    return {
      kind: "speech",
      utterance,
      status: result.data.status,
      client: result.data.client,
      durationMs: result.data.durationMs,
    };
  } catch (error) {
    if (error instanceof VisualFailure) return failure(utterance, error.code, error.message);
    throw error;
  }
}

export function speakToolResult(details: SpeakDetails): SpeakToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(details) }],
    details,
    structuredContent: z.json().parse(details),
    isError: details.kind === "error",
  };
}

export interface SpeakToolDefinitionInput {
  connection: SpeechToolConnection;
  bind(sessionId: string): void;
}

export function createSpeakTool(
  input: SpeakToolDefinitionInput,
): ToolDefinition<typeof speakParameters, SpeakDetails, unknown> {
  return {
    name: "speak",
    label: "speak",
    description:
      "Speak your own text aloud with the user's local voice, exactly as written (never rewritten). Use the voice the user names: Michael by default (Mike is Michael) or Adam. A name only quoted or mentioned in passing is not a request to speak. Plays on one device: where the user is talking from, or the computer or phone they ask for. Resolves after playback finishes (completed) or the user stops it (stopped). After a stop, do not speak again until the user asks (SPEECH_STOPPED). DEVICE_UNAVAILABLE means that device cannot play now: tell the user rather than switching devices. Requires attached Paseo.",
    parameters: speakParameters,
    outputSchema: speakOutputSchema,
    exposure: "direct",
    // Playback can last minutes; other tools must stay responsive meanwhile.
    executionMode: "parallel",
    async execute(_id, args, signal, _onUpdate, ctx) {
      input.bind(ctx.sessionManager.getSessionId());
      const details = await executeSpeakTool({ input: args, connection: input.connection, signal });
      return speakToolResult(details);
    },
  };
}
