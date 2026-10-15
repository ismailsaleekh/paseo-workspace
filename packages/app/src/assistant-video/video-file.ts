import { Directory, File, Paths } from "expo-file-system";
import type { VideoFile, VideoFileInput } from "./types";

// Videos are kept for one app run: the previous run's files are removed before the first new one.
const directory = new Directory(Paths.cache, "assistant-videos");
let previousRunCleared = false;
let created = 0;

function prepareDirectory(): void {
  if (!previousRunCleared) {
    if (directory.exists) directory.delete();
    previousRunCleared = true;
  }
  if (!directory.exists) directory.create({ intermediates: true });
}

export function createVideoFile({ extension }: VideoFileInput): VideoFile {
  prepareDirectory();
  created += 1;
  const file = new File(directory, `${Date.now()}-${created}${extension}`);
  file.create();
  const handle = file.open();
  return {
    write(chunk) {
      handle.writeBytes(chunk);
    },
    finish() {
      handle.close();
      return file.uri;
    },
    discard() {
      handle.close();
      if (file.exists) file.delete();
    },
  };
}

export function releaseVideoUri(uri: string): void {
  const file = new File(uri);
  if (file.exists) file.delete();
}
