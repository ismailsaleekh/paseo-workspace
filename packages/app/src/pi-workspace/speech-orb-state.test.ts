import assert from "node:assert/strict";
import { test } from "vitest";
import { speechOrbLabel, speechOrbPhase, type SpeechOrbInput } from "./speech-orb-state";

const idle: SpeechOrbInput = {
  speech: { status: "ready", speaking: null },
  microphone: false,
  voiceMode: null,
};
const stop = () => undefined;

test("the orb shows only real states, playback first", () => {
  assert.equal(speechOrbPhase(idle), "ready");
  assert.equal(speechOrbLabel("ready", null), "Michael ready");
  const speaking = {
    ...idle,
    speech: { status: "ready" as const, speaking: { voice: "adam" as const, stop } },
  };
  assert.equal(speechOrbPhase({ ...speaking, microphone: true }), "speaking");
  assert.equal(speechOrbLabel("speaking", "adam"), "Adam speaking");
  assert.equal(speechOrbPhase({ ...idle, microphone: true }), "listening");
  const muted = { isVoiceMode: true, isMuted: true, phase: "listening" as const };
  assert.equal(speechOrbPhase({ ...idle, voiceMode: muted }), "muted");
  const waiting = { isVoiceMode: true, isMuted: false, phase: "waiting" as const };
  assert.equal(speechOrbPhase({ ...idle, voiceMode: waiting }), "waiting");
  const disabled = { isVoiceMode: false, isMuted: true, phase: "disabled" as const };
  assert.equal(
    speechOrbPhase({ ...idle, voiceMode: disabled }),
    "ready",
    "voice mode off is ignored",
  );
  assert.equal(
    speechOrbPhase({ ...idle, speech: { status: "connecting", speaking: null } }),
    "offline",
  );
  assert.equal(speechOrbLabel("offline", null), "Voice offline");
});
