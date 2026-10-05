import assert from "node:assert/strict";
import { pino } from "pino";
import { test } from "vitest";
import type { PaseoSpeechConfig } from "../../../bootstrap.js";
import type { RequestedSpeechProviders } from "../../speech-types.js";
import { DEFAULT_LOCAL_STT_MODEL, DEFAULT_LOCAL_TTS_MODEL } from "./models.js";
import { initializeLocalSpeechServices } from "./runtime.js";

const logger = pino({ level: "silent" });

function providers(voiceModeEnabled: boolean): RequestedSpeechProviders {
  return {
    dictationStt: { provider: "local", explicit: true, enabled: true },
    voiceTurnDetection: { provider: "local", explicit: false, enabled: voiceModeEnabled },
    voiceStt: { provider: "local", explicit: false, enabled: voiceModeEnabled },
    voiceTts: { provider: "local", explicit: true, enabled: voiceModeEnabled },
  };
}

function speechConfig(voiceModeEnabled: boolean, local: boolean): PaseoSpeechConfig {
  return {
    providers: providers(voiceModeEnabled),
    sttLanguages: { dictation: "en", voice: "en" },
    ...(local
      ? {
          local: {
            modelsDir: "/nonexistent/paseo-local-speech",
            models: {
              dictationStt: DEFAULT_LOCAL_STT_MODEL,
              voiceStt: DEFAULT_LOCAL_STT_MODEL,
              voiceTts: DEFAULT_LOCAL_TTS_MODEL,
            },
          },
        }
      : {}),
  };
}

test("agent speech has a local TTS engine while realtime voice mode is disabled", async () => {
  const speech = await initializeLocalSpeechServices({
    providers: providers(false),
    speechConfig: speechConfig(false, true),
    logger,
  });
  try {
    assert.equal(speech.ttsService, null, "realtime voice stays disabled");
    assert.equal(speech.turnDetectionService, null);
    assert.notEqual(speech.agentSpeechTtsService, null);
    assert.notEqual(speech.dictationSttService, null);
  } finally {
    speech.cleanup();
  }
});

test("agent speech synthesizes in its own engine, separate from realtime voice and dictation", async () => {
  const speech = await initializeLocalSpeechServices({
    providers: providers(true),
    speechConfig: speechConfig(true, true),
    logger,
  });
  try {
    assert.notEqual(speech.agentSpeechTtsService, null);
    assert.notEqual(speech.localVoiceTtsProvider, null);
    assert.notEqual(speech.agentSpeechTtsService, speech.localVoiceTtsProvider);
  } finally {
    speech.cleanup();
  }
});

test("without a configured local provider agent speech is unavailable, never substituted", async () => {
  const speech = await initializeLocalSpeechServices({
    providers: providers(false),
    speechConfig: speechConfig(false, false),
    logger,
  });
  try {
    assert.equal(speech.agentSpeechTtsService, null);
  } finally {
    speech.cleanup();
  }
});
