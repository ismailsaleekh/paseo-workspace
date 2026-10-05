// Judge-owned reference speech recogniser for S1 (independent of the product's dictation path).
// Usage: node stt-reference.cjs <wav> | node stt-reference.cjs --pcm <sampleRate> <base64 Float32 LE file>
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const sherpa = require("sherpa-onnx-node");

const models = path.join(
  process.env.HOME_CACHE ?? path.join(require("node:os").homedir(), ".cache", "pi-paseo-workspace"),
  "speech-models/local-speech/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8",
);
const recognizer = new sherpa.OfflineRecognizer({
  featConfig: { sampleRate: 16000, featureDim: 80 },
  modelConfig: {
    transducer: {
      encoder: path.join(models, "encoder.int8.onnx"),
      decoder: path.join(models, "decoder.int8.onnx"),
      joiner: path.join(models, "joiner.int8.onnx"),
    },
    tokens: path.join(models, "tokens.txt"),
    numThreads: 2,
    provider: "cpu",
    modelType: "nemo_transducer",
  },
});

function transcribe(samples, sampleRate) {
  // Decode in ~25 s windows so long recordings stay within the model's comfortable range.
  const window = sampleRate * 25;
  const parts = [];
  for (let offset = 0; offset < samples.length; offset += window) {
    const stream = recognizer.createStream();
    stream.acceptWaveform({ sampleRate, samples: samples.subarray(offset, offset + window) });
    recognizer.decode(stream);
    parts.push(recognizer.getResult(stream).text.trim());
  }
  return parts.filter(Boolean).join(" ");
}

const args = process.argv.slice(2);
let text;
if (args[0] === "--pcm") {
  const sampleRate = Number(args[1]);
  const bytes = Buffer.from(fs.readFileSync(args[2], "utf8"), "base64");
  const samples = new Float32Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.length / 4));
  text = transcribe(Float32Array.from(samples), sampleRate);
} else {
  const wave = sherpa.readWave(args[0]);
  text = transcribe(wave.samples, wave.sampleRate);
}
process.stdout.write(`${JSON.stringify({ text })}\n`);
