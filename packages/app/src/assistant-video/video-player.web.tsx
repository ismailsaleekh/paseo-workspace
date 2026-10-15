import type { CSSProperties } from "react";
import type { VideoPlayerProps } from "./types";

const VIDEO_STYLE: CSSProperties = {
  display: "block",
  width: "100%",
  maxHeight: 480,
  backgroundColor: "#000",
  borderRadius: 8,
};

/** The browser's own player: the file exactly as it is, with its controls and full screen. */
export function VideoPlayer({ uri, autoPlay, accessibilityLabel }: VideoPlayerProps) {
  return (
    <video
      src={uri}
      controls
      autoPlay={autoPlay}
      playsInline
      preload="metadata"
      aria-label={accessibilityLabel}
      data-testid="assistant-video-player"
      style={VIDEO_STYLE}
    />
  );
}
