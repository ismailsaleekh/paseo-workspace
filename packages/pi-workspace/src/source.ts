import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { resolve } from "node:path";
import {
  VisualFailure,
  VISUAL_SOURCE_BYTES,
  validateVisualHtml,
} from "@getpaseo/protocol/pi-workspace/contracts";

export type VisualSource = { html: string; file?: never } | { file: string; html?: never };
export interface ReadVisualSourceInput {
  source: VisualSource;
  cwd: string;
  signal?: AbortSignal;
}

export function assertVisualNotAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new VisualFailure("CANCELLED", "Visual operation was cancelled");
}

export async function readVisualSource(input: ReadVisualSourceInput): Promise<string> {
  assertVisualNotAborted(input.signal);
  if (input.source.html !== undefined) return validateVisualHtml(input.source.html);
  if (input.source.file.trim().length === 0) {
    throw new VisualFailure("INVALID_SOURCE", "Visual file path must not be empty");
  }
  const filename = resolve(input.cwd, input.source.file);
  try {
    // Nonblocking open prevents a named pipe from hanging before fstat can refuse it.
    const file = await open(
      filename,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const before = await file.stat();
      if (!before.isFile())
        throw new VisualFailure("INVALID_SOURCE", "Visual source must be a regular file");
      if (before.size > VISUAL_SOURCE_BYTES) {
        throw new VisualFailure(
          "SOURCE_TOO_LARGE",
          `Visual file exceeds ${VISUAL_SOURCE_BYTES} bytes`,
        );
      }
      const bytes = Buffer.alloc(VISUAL_SOURCE_BYTES + 1);
      let length = 0;
      while (length < bytes.byteLength) {
        assertVisualNotAborted(input.signal);
        const { bytesRead } = await file.read(bytes, length, bytes.byteLength - length, length);
        if (bytesRead === 0) break;
        length += bytesRead;
      }
      assertVisualNotAborted(input.signal);
      if (length > VISUAL_SOURCE_BYTES) {
        throw new VisualFailure(
          "SOURCE_TOO_LARGE",
          `Visual file exceeds ${VISUAL_SOURCE_BYTES} bytes`,
        );
      }
      const after = await file.stat();
      if (
        before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs ||
        before.ctimeMs !== after.ctimeMs
      ) {
        throw new VisualFailure(
          "SOURCE_CHANGED",
          "Visual file changed while being read; retry with a prepared file",
        );
      }
      let html: string;
      try {
        html = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
          bytes.subarray(0, length),
        );
      } catch (error) {
        if (!(error instanceof TypeError)) throw error;
        throw new VisualFailure("INVALID_SOURCE", "Visual file must contain valid UTF-8");
      }
      return validateVisualHtml(html);
    } finally {
      await file.close();
    }
  } catch (error) {
    if (error instanceof VisualFailure) throw error;
    if (error instanceof Error && "code" in error) {
      throw new VisualFailure(
        "SOURCE_UNAVAILABLE",
        `Cannot read the prepared visual file (${String(error.code)})`,
      );
    }
    throw error;
  }
}
