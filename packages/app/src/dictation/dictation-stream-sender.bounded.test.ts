import { describe, expect, it } from "vitest";
import type { SessionOutboundMessage } from "@getpaseo/protocol/messages";
import {
  DICTATION_MAX_BUFFERED_PCM_BYTES,
  DictationBufferFullError,
  DictationStreamSender,
} from "@/dictation/dictation-stream-sender";

const FORMAT = "audio/pcm;rate=16000;bits=16";

class AckingClient {
  isConnected = true;
  chunks: { dictationId: string; seq: number; audio: string }[] = [];
  private readonly listeners = new Set<(message: SessionOutboundMessage) => void>();

  async startDictationStream(): Promise<void> {}
  sendDictationStreamChunk(dictationId: string, seq: number, audio: string): void {
    this.chunks.push({ dictationId, seq, audio });
    for (const listener of this.listeners)
      listener({ type: "dictation_stream_ack", payload: { dictationId, ackSeq: seq } });
  }
  async finishDictationStream(dictationId: string): Promise<{ dictationId: string; text: string }> {
    return { dictationId, text: `final for ${this.chunks.length} chunks` };
  }
  cancelDictationStream(): void {}
  subscribeRawMessages(handler: (message: SessionOutboundMessage) => void): () => void {
    this.listeners.add(handler);
    return () => this.listeners.delete(handler);
  }
}

/** One second of 16 kHz PCM16 silence, base64 encoded like the web capture path. */
function secondOfPcm(): string {
  return btoa("\0".repeat(32_000));
}

const tick = async () => {
  for (let index = 0; index < 4; index += 1) await Promise.resolve();
};

describe("DictationStreamSender bounded buffering", () => {
  it("retains a bound of 30 minutes, enough for multi-minute dictation", () => {
    expect(DICTATION_MAX_BUFFERED_PCM_BYTES).toBe(16_000 * 2 * 60 * 30);
    expect(DICTATION_MAX_BUFFERED_PCM_BYTES).toBeGreaterThan(16_000 * 2 * 60 * 3);
  });

  it("streams a four-minute dictation completely while counting retained bytes", async () => {
    const client = new AckingClient();
    const sender = new DictationStreamSender({
      client,
      format: FORMAT,
      createDictationId: () => "d1",
    });
    for (let second = 0; second < 240; second += 1) {
      expect(sender.enqueueSegment(secondOfPcm())).toBe(true);
      await tick();
    }
    expect(sender.getBufferedBytes()).toBe(240 * 32_000);
    const result = await sender.finish(sender.getFinalSeq());
    expect(client.chunks.map((chunk) => chunk.seq)).toEqual(
      Array.from({ length: 240 }, (_, index) => index),
    );
    expect(result.text).toBe("final for 240 chunks");
    expect(sender.isBufferFull()).toBe(false);
  });

  it("refuses audio beyond the bound explicitly, once, and keeps everything already captured", async () => {
    const client = new AckingClient();
    const failures: DictationBufferFullError[] = [];
    const sender = new DictationStreamSender({
      client,
      format: FORMAT,
      createDictationId: () => "d1",
      maxBufferedBytes: 3 * 32_000,
      onBufferFull: (error) => failures.push(error),
    });
    for (let second = 0; second < 3; second += 1)
      expect(sender.enqueueSegment(secondOfPcm())).toBe(true);
    expect(sender.enqueueSegment(secondOfPcm())).toBe(false);
    expect(sender.enqueueSegment(secondOfPcm())).toBe(false);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toBeInstanceOf(DictationBufferFullError);
    expect(sender.isBufferFull()).toBe(true);
    expect(sender.getSegmentCount()).toBe(3);
    await tick();
    await expect(sender.finish(sender.getFinalSeq())).resolves.toEqual({
      dictationId: "d1",
      text: "final for 3 chunks",
    });
  });

  it("releases the bound when the dictation is cleared", () => {
    const sender = new DictationStreamSender({
      client: null,
      format: FORMAT,
      maxBufferedBytes: 32_000,
      onBufferFull: () => undefined,
    });
    expect(sender.enqueueSegment(secondOfPcm())).toBe(true);
    expect(sender.enqueueSegment(secondOfPcm())).toBe(false);
    sender.clearAll();
    expect(sender.getBufferedBytes()).toBe(0);
    expect(sender.isBufferFull()).toBe(false);
    expect(sender.enqueueSegment(secondOfPcm())).toBe(true);
  });
});
