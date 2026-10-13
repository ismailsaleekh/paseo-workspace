import { DEFAULT_SPEECH_VOICE, type SpeechVoice } from "@getpaseo/protocol/pi-workspace/speech";
import type { VoiceRuntimePhase } from "@/voice/voice-runtime";
import type { AppSpeechSnapshot } from "./speech-connection";

export type SpeechOrbPhase = "speaking" | "listening" | "muted" | "waiting" | "offline" | "ready";

const VOICE_NAMES: Record<SpeechVoice, string> = { michael: "Michael", adam: "Adam" };

export interface SpeechOrbInput {
  speech: AppSpeechSnapshot;
  /** Dictation is capturing microphone audio. */
  microphone: boolean;
  voiceMode: { isVoiceMode: boolean; isMuted: boolean; phase: VoiceRuntimePhase } | null;
}

/** Only real states: actual playback, microphone capture, voice-mode phases and connection. */
export function speechOrbPhase({ speech, microphone, voiceMode }: SpeechOrbInput): SpeechOrbPhase {
  if (speech.speaking) return "speaking";
  const voice = voiceMode?.isVoiceMode ? voiceMode : null;
  if (voice?.phase === "playing") return "speaking";
  if (voice?.isMuted) return "muted";
  if (microphone || voice?.phase === "listening") return "listening";
  if (voice?.phase === "submitting" || voice?.phase === "waiting") return "waiting";
  if (speech.status !== "ready") return "offline";
  return "ready";
}

export function speechOrbLabel(phase: SpeechOrbPhase, voice: SpeechVoice | null): string {
  switch (phase) {
    case "speaking":
      return voice ? `${VOICE_NAMES[voice]} speaking` : "Speaking";
    case "listening":
      return "Listening";
    case "muted":
      return "Microphone muted";
    case "waiting":
      return "Waiting";
    case "offline":
      return "Voice offline";
    case "ready":
      return `${VOICE_NAMES[DEFAULT_SPEECH_VOICE]} ready`;
  }
}
