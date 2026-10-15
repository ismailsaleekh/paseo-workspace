import type { VideoFile, VideoFileInput } from "./types";

// Pending chunks are folded into the Blob every few MB: the browser keeps Blob data in its own
// storage, so a large video never sits in the JavaScript heap.
const FOLD_BYTES = 8 * 1024 * 1024;

export function createVideoFile({ mime }: VideoFileInput): VideoFile {
  let blob = new Blob([], { type: mime });
  let pending: Uint8Array<ArrayBuffer>[] = [];
  let pendingBytes = 0;
  const fold = () => {
    blob = new Blob([blob, ...pending], { type: mime });
    pending = [];
    pendingBytes = 0;
  };
  return {
    write(chunk) {
      pending.push(new Uint8Array(chunk));
      pendingBytes += chunk.byteLength;
      if (pendingBytes >= FOLD_BYTES) fold();
    },
    finish() {
      fold();
      return URL.createObjectURL(blob);
    },
    discard() {
      pending = [];
      blob = new Blob([], { type: mime });
    },
  };
}

export function releaseVideoUri(uri: string): void {
  URL.revokeObjectURL(uri);
}
