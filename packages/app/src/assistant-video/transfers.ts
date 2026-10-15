import type { FileStreamSink } from "@getpaseo/client/internal/daemon-client";
import type { VideoFile } from "./types";

export type VideoTransferState =
  | { status: "loading"; percent: number | null }
  | { status: "ready"; uri: string }
  | { status: "failed"; message: string };

export interface VideoTransferPorts {
  /** Streams the video's bytes into `sink`; rejects when the transfer fails. */
  stream(sink: FileStreamSink): Promise<unknown>;
  createFile(): VideoFile;
}

/**
 * Videos loaded during this app run, keyed by the message that shows them. A load outlives the
 * row that started it; beyond `keepReady`, the least recently used videos nobody shows are released.
 */
export class VideoTransfers {
  private readonly states = new Map<string, { state: VideoTransferState; usedAt: number }>();
  private readonly listeners = new Map<string, Set<() => void>>();
  private clock = 0;

  constructor(
    private readonly release: (uri: string) => void,
    private readonly keepReady = 4,
  ) {}

  get(key: string): VideoTransferState | null {
    return this.states.get(key)?.state ?? null;
  }

  subscribe(key: string, listener: () => void): () => void {
    const listeners = this.listeners.get(key) ?? new Set<() => void>();
    listeners.add(listener);
    this.listeners.set(key, listeners);
    const current = this.states.get(key);
    if (current) current.usedAt = ++this.clock;
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.listeners.delete(key);
    };
  }

  /** Starts loading unless this video is loading or loaded already; a failed load starts over. */
  load(key: string, ports: VideoTransferPorts): void {
    const current = this.states.get(key)?.state;
    if (current && current.status !== "failed") return;
    void this.run(key, ports);
  }

  private async run(key: string, ports: VideoTransferPorts): Promise<void> {
    this.set(key, { status: "loading", percent: null });
    let file: VideoFile | undefined;
    try {
      file = ports.createFile();
      const target = file;
      let size = 0;
      let received = 0;
      let percent = -1;
      await ports.stream({
        begin: (metadata) => {
          size = metadata.size;
        },
        write: (chunk) => {
          target.write(chunk);
          received += chunk.byteLength;
          const next = size > 0 ? Math.floor((received / size) * 100) : percent;
          if (next === percent) return;
          percent = next;
          this.set(key, { status: "loading", percent });
        },
      });
      this.set(key, { status: "ready", uri: target.finish() });
    } catch (error) {
      file?.discard();
      this.set(key, {
        status: "failed",
        message: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    this.releaseUnused();
  }

  private set(key: string, state: VideoTransferState): void {
    this.states.set(key, { state, usedAt: ++this.clock });
    for (const listener of this.listeners.get(key) ?? []) listener();
  }

  private releaseUnused(): void {
    const ready = [...this.states].filter(([, entry]) => entry.state.status === "ready");
    let excess = ready.length - this.keepReady;
    for (const [key, entry] of ready.sort((a, b) => a[1].usedAt - b[1].usedAt)) {
      if (excess <= 0) return;
      if (this.listeners.has(key) || entry.state.status !== "ready") continue;
      this.release(entry.state.uri);
      this.states.delete(key);
      excess -= 1;
    }
  }
}
