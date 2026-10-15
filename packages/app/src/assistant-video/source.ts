// Video files the chat plays when an assistant reply embeds them like an image: ![title](path).
const VIDEO_MIME_TYPES = new Map([
  // Chromium demuxes QuickTime and M4V files as MP4; native players sniff the container themselves.
  [".mp4", "video/mp4"],
  [".m4v", "video/mp4"],
  [".mov", "video/mp4"],
  [".webm", "video/webm"],
]);

/** The extension and MIME type to play `source` with, or null when it is not a video file. */
export function assistantVideoType(source: string): { extension: string; mime: string } | null {
  const path = source.trim().replace(/[?#].*$/, "");
  const dot = path.lastIndexOf(".");
  if (dot <= path.lastIndexOf("/")) return null;
  const extension = path.slice(dot).toLowerCase();
  const mime = VIDEO_MIME_TYPES.get(extension);
  return mime ? { extension, mime } : null;
}
