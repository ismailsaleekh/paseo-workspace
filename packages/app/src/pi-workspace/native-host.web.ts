/** Web and Electron have no companion visual host to warm. */
export function useAndroidRendererWarmup(): void {}

/** Web playback completion is reported by the audio engine itself. */
export const outputDrained: (() => boolean) | undefined = undefined;

/** User-enabled background speech exists only on Android; desktop keeps playing while hidden. */
export interface BackgroundSpeechState {
  available: boolean;
  enabled: boolean;
}
const NO_BACKGROUND_SPEECH: BackgroundSpeechState = { available: false, enabled: false };

export function useBackgroundSpeech(): BackgroundSpeechState {
  return NO_BACKGROUND_SPEECH;
}

export function setBackgroundSpeech(enabled: boolean): Promise<void> {
  return Promise.reject(
    new Error(`Background speech cannot be turned ${enabled ? "on" : "off"}: it is Android-only`),
  );
}

export function subscribeStopSpeechRequests(): () => void {
  return () => undefined;
}
