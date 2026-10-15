import { describe, expect, it } from "vitest";
import type { FileStreamSink } from "@getpaseo/client/internal/daemon-client";
import { VideoTransfers, type VideoTransferState } from "./transfers";
import type { VideoFile } from "./types";

class RecordedFile implements VideoFile {
  readonly chunks: string[] = [];
  outcome: "open" | "finished" | "discarded" = "open";
  constructor(private readonly uri: string) {}
  write(chunk: Uint8Array): void {
    this.chunks.push(new TextDecoder().decode(chunk));
  }
  finish(): string {
    this.outcome = "finished";
    return this.uri;
  }
  discard(): void {
    this.outcome = "discarded";
  }
}

/** A transfer the test drives by hand: begin, chunks, then end or fail. */
class ManualStream {
  sink: FileStreamSink | null = null;
  private settle: { resolve(): void; reject(error: Error): void } | null = null;
  readonly stream = (sink: FileStreamSink) =>
    new Promise<void>((resolve, reject) => {
      this.sink = sink;
      this.settle = { resolve, reject };
    });
  send(size: number, chunks: string[]): void {
    if (!this.sink) throw new Error("Transfer not started");
    this.sink.begin({ mime: "application/octet-stream", size });
    for (const chunk of chunks) this.sink.write(new TextEncoder().encode(chunk));
  }
  end(): Promise<void> {
    this.settle?.resolve();
    return flush();
  }
  fail(message: string): Promise<void> {
    this.settle?.reject(new Error(message));
    return flush();
  }
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function observe(transfers: VideoTransfers, key: string): VideoTransferState[] {
  const seen: VideoTransferState[] = [];
  transfers.subscribe(key, () => {
    const state = transfers.get(key);
    if (state) seen.push(state);
  });
  return seen;
}

describe("VideoTransfers", () => {
  it("streams one load into one file with progress, and later loads reuse it", async () => {
    const released: string[] = [];
    const transfers = new VideoTransfers((uri) => released.push(uri));
    const stream = new ManualStream();
    const file = new RecordedFile("blob:video-1");
    let filesCreated = 0;
    const ports = {
      stream: stream.stream,
      createFile: () => {
        filesCreated += 1;
        return file;
      },
    };
    const seen = observe(transfers, "message-1");

    transfers.load("message-1", ports);
    transfers.load("message-1", ports);
    stream.send(4, ["vi", "de"]);
    await stream.end();
    transfers.load("message-1", ports);

    expect(file.chunks).toEqual(["vi", "de"]);
    expect(seen).toEqual([
      { status: "loading", percent: null },
      { status: "loading", percent: 50 },
      { status: "loading", percent: 100 },
      { status: "ready", uri: "blob:video-1" },
    ]);
    expect({ filesCreated, outcome: file.outcome, released }).toEqual({
      filesCreated: 1,
      outcome: "finished",
      released: [],
    });
  });

  it("discards a failed transfer's partial file, reports the error, and retries on the next load", async () => {
    const transfers = new VideoTransfers(() => {});
    const files: RecordedFile[] = [];
    const streams: ManualStream[] = [];
    const ports = {
      stream: (sink: FileStreamSink) => {
        const stream = new ManualStream();
        streams.push(stream);
        return stream.stream(sink);
      },
      createFile: () => {
        const file = new RecordedFile(`blob:attempt-${files.length + 1}`);
        files.push(file);
        return file;
      },
    };

    transfers.load("message-1", ports);
    streams[0]?.send(10, ["part"]);
    await streams[0]?.fail("File changed during transfer");
    expect(transfers.get("message-1")).toEqual({
      status: "failed",
      message: "File changed during transfer",
    });
    expect(files[0]?.outcome).toBe("discarded");

    transfers.load("message-1", ports);
    streams[1]?.send(4, ["full"]);
    await streams[1]?.end();
    expect(transfers.get("message-1")).toEqual({ status: "ready", uri: "blob:attempt-2" });
  });

  it("releases the least recently used ready videos beyond the limit, never one on screen", async () => {
    const released: string[] = [];
    const transfers = new VideoTransfers((uri) => released.push(uri), 2);
    const load = async (key: string) => {
      const stream = new ManualStream();
      transfers.load(key, {
        stream: stream.stream,
        createFile: () => new RecordedFile(`blob:${key}`),
      });
      stream.send(1, ["x"]);
      await stream.end();
    };
    const unsubscribeShown = transfers.subscribe("shown", () => {});

    await load("shown");
    await load("second");
    await load("third");
    expect(released).toEqual(["blob:second"]);
    expect(transfers.get("shown")).toEqual({ status: "ready", uri: "blob:shown" });
    expect(transfers.get("second")).toBeNull();

    unsubscribeShown();
    await load("fourth");
    expect(released).toEqual(["blob:second", "blob:shown"]);
  });
});
