import { useVideoPlayer, VideoView, type VideoViewProps } from "expo-video";
import { StyleSheet } from "react-native-unistyles";
import type { VideoPlayerProps } from "./types";

const FULLSCREEN: VideoViewProps["fullscreenOptions"] = { enable: true };

/** The platform player (ExoPlayer on Android): the file exactly as it is, with native controls. */
export function VideoPlayer({ uri, autoPlay, accessibilityLabel }: VideoPlayerProps) {
  const player = useVideoPlayer(uri, (instance) => {
    if (autoPlay) instance.play();
  });
  return (
    <VideoView
      player={player}
      nativeControls
      contentFit="contain"
      fullscreenOptions={FULLSCREEN}
      accessibilityLabel={accessibilityLabel}
      testID="assistant-video-player"
      style={styles.video}
    />
  );
}

const styles = StyleSheet.create((theme) => ({
  video: {
    width: "100%",
    aspectRatio: 16 / 9,
    backgroundColor: "#000",
    borderRadius: theme.borderRadius.lg,
    overflow: "hidden",
  },
}));
