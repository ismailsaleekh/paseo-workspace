import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VisualFailure } from "@getpaseo/protocol/pi-workspace/contracts";
import type { SpeechResult } from "@getpaseo/protocol/pi-workspace/speech";
import { VisualConnection, type SpeakRequest, type SpeechToolConnection } from "./connection.js";
import { executeSpeakTool, speakToolResult } from "./speak.js";

const utterance = "3d4b0a52-2a0f-4f4b-9a39-2b8c3f1f0a11";
const client = "0b8f2d7e-8a7e-4f39-9d6c-1f4a8f7e2c55";

class SpeechHost implements SpeechToolConnection {
  readonly requests: SpeakRequest[] = [];
  constructor(private readonly reply: (request: SpeakRequest) => Promise<SpeechResult>) {}
  async speak(request: SpeakRequest): Promise<SpeechResult> {
    this.requests.push(request);
    return this.reply(request);
  }
}

test("speak sends the exact supplied text and reports completion only from the host's playback result", async () => {
  const text = "  The zebra counted kumquats.\nThen it whistled — quietly!  ";
  const host = new SpeechHost(async (request) => ({
    kind: "speech",
    utterance: request.utterance,
    status: "completed",
    client,
    durationMs: 4210,
  }));
  const details = await executeSpeakTool({
    input: { text },
    connection: host,
    signal: undefined,
    createUtterance: () => utterance,
  });
  assert.deepEqual(host.requests, [{ utterance, text }]);
  assert.deepEqual(details, {
    kind: "speech",
    utterance,
    status: "completed",
    client,
    durationMs: 4210,
  });
  const result = speakToolResult(details);
  assert.equal(result.isError, false);
  assert.deepEqual(result.structuredContent, details);
});

test("a user stop is a successful stopped outcome, not an error", async () => {
  const host = new SpeechHost(async (request) => ({
    kind: "speech",
    utterance: request.utterance,
    status: "stopped",
    client,
    durationMs: 1500,
  }));
  const details = await executeSpeakTool({
    input: { text: "Long text." },
    connection: host,
    signal: undefined,
    createUtterance: () => utterance,
  });
  assert.equal(details.kind, "speech");
  assert.equal(details.status, "stopped");
  assert.equal(speakToolResult(details).isError, false);
});

test("host failures are tool errors carrying status failed, the utterance and the error code", async () => {
  const host = new SpeechHost(async (request) => {
    throw new VisualFailure(
      "CLIENT_UNAVAILABLE",
      "No app is displaying this conversation",
      request.utterance,
    );
  });
  const details = await executeSpeakTool({
    input: { text: "Hello there." },
    connection: host,
    signal: undefined,
    createUtterance: () => utterance,
  });
  assert.deepEqual(details, {
    kind: "error",
    id: utterance,
    utterance,
    status: "failed",
    error: { code: "CLIENT_UNAVAILABLE", message: "No app is displaying this conversation" },
  });
  const result = speakToolResult(details);
  assert.equal(result.isError, true);
  const first = result.content[0];
  assert.equal(first?.type, "text");
  if (first?.type !== "text") throw new Error("Missing model-facing text");
  assert.deepEqual(JSON.parse(first.text), details);
});

test("blank or oversized text is rejected before reaching the host", async () => {
  for (const input of [{ text: "   \n " }, { text: "x".repeat(20_001) }, { words: "no" }]) {
    const host = new SpeechHost(async () => {
      throw new Error("must not be called");
    });
    const details = await executeSpeakTool({ input, connection: host, signal: undefined });
    assert.equal(details.kind, "error");
    assert.equal(details.kind === "error" ? details.error.code : "", "INVALID_ARGUMENT");
    assert.deepEqual(host.requests, []);
  }
});

test("a reply for another utterance is rejected as an invalid reply", async () => {
  const host = new SpeechHost(async () => ({
    kind: "speech",
    utterance: "aa4b0a52-2a0f-4f4b-9a39-2b8c3f1f0a11",
    status: "completed",
    client,
    durationMs: 10,
  }));
  const details = await executeSpeakTool({
    input: { text: "Hi." },
    connection: host,
    signal: undefined,
    createUtterance: () => utterance,
  });
  assert.equal(details.kind === "error" ? details.error.code : "", "INVALID_REPLY");
});

test("without an attached Paseo host speak fails with HOST_UNAVAILABLE", async () => {
  const connection = new VisualConnection(null);
  connection.bind("session-1");
  const details = await executeSpeakTool({
    input: { text: "Exact supplied words." },
    connection,
    signal: undefined,
  });
  assert.equal(details.kind, "error");
  assert.equal(details.kind === "error" ? details.error.code : "", "HOST_UNAVAILABLE");
  assert.equal(typeof details.utterance, "string");
});

test("the private connection carries speak frames and resolves with the host's speech frame", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pw-speak-"));
  const socketPath = join(directory, "host.sock");
  const capability = "a".repeat(64);
  const frames: unknown[] = [];
  const server = createServer((socket) => {
    let buffered = "";
    socket.on("data", (bytes: Buffer) => {
      buffered += bytes.toString("utf8");
      let end = buffered.indexOf("\n");
      while (end !== -1) {
        const frame: unknown = JSON.parse(buffered.slice(0, end));
        buffered = buffered.slice(end + 1);
        frames.push(frame);
        if (typeof frame === "object" && frame !== null && "kind" in frame) {
          if (frame.kind === "attach")
            socket.write(
              `${JSON.stringify({ kind: "attached", protocol: 1, sessionId: "session-1", generation: client })}\n`,
            );
          if (frame.kind === "speak" && "requestId" in frame && "utterance" in frame)
            socket.write(
              `${JSON.stringify({
                kind: "speech",
                requestId: frame.requestId,
                result: {
                  kind: "speech",
                  utterance: frame.utterance,
                  status: "completed",
                  client,
                  durationMs: 900,
                },
              })}\n`,
            );
        }
        end = buffered.indexOf("\n");
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  const connection = new VisualConnection({ socketPath, capability });
  connection.bind("session-1");
  try {
    const details = await executeSpeakTool({
      input: { text: "Exact words." },
      connection,
      signal: undefined,
      createUtterance: () => utterance,
    });
    assert.deepEqual(details, {
      kind: "speech",
      utterance,
      status: "completed",
      client,
      durationMs: 900,
    });
    const speak = frames.find(
      (frame) =>
        typeof frame === "object" && frame !== null && "kind" in frame && frame.kind === "speak",
    );
    assert.ok(speak && typeof speak === "object");
    assert.equal("text" in speak ? speak.text : null, "Exact words.");
    assert.equal("utterance" in speak ? speak.utterance : null, utterance);
  } finally {
    connection.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

test("speak passes a named voice and a requested device, and refuses unknown voices", async () => {
  const host = new SpeechHost(async (request) => ({
    kind: "speech",
    utterance: request.utterance,
    status: "completed",
    client,
    durationMs: 1,
  }));
  const details = await executeSpeakTool({
    input: { text: "Adam explains.", voice: "adam", device: "phone" },
    connection: host,
    signal: undefined,
    createUtterance: () => utterance,
  });
  assert.equal(details.kind, "speech");
  assert.deepEqual(host.requests, [
    { utterance, text: "Adam explains.", voice: "adam", device: "phone" },
  ]);
  const unknown = await executeSpeakTool({
    input: { text: "Who?", voice: "george" },
    connection: host,
    signal: undefined,
    createUtterance: () => utterance,
  });
  assert.equal(unknown.kind === "error" ? unknown.error.code : "", "INVALID_ARGUMENT");
  assert.equal(host.requests.length, 1, "an unknown voice is never substituted");
});
