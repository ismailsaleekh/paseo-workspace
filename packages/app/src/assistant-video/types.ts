/** A video being written as it arrives, on the device's own storage. */
export interface VideoFile {
  write(chunk: Uint8Array): void;
  /** Completes the file and returns a URI the player can open. */
  finish(): string;
  /** Removes an unfinished file. */
  discard(): void;
}

export interface VideoFileInput {
  /** What the player should treat the bytes as (web). */
  mime: string;
  /** The source file's extension, kept so native players see a familiar file name. */
  extension: string;
}

export interface VideoPlayerProps {
  uri: string;
  /** Starts playing at once: only right after the user asked for this video. */
  autoPlay: boolean;
  accessibilityLabel: string;
}
