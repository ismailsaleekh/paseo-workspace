import { useEffect, useSyncExternalStore } from "react";
import { PermissionsAndroid, Platform } from "react-native";
import { requireOptionalNativeModule } from "expo";
import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  addExpoTwoWayAudioEventListener,
  setBackgroundPlayback,
  supportsBackgroundPlayback,
} from "@getpaseo/expo-two-way-audio";

interface AndroidRendererWarmup {
  prepare(): Promise<void>;
  release(): Promise<void>;
}
// While a visual surface is active, keep the companion visual host started so a document's
// display deadline does not include the host's cold start. Rendering still needs the document
// view; this only binds and warms the host.
export function useAndroidRendererWarmup(active: boolean): void {
  useEffect(() => {
    if (Platform.OS !== "android" || !active) return undefined;
    const host = requireOptionalNativeModule<AndroidRendererWarmup>("PaseoVisualHost");
    if (!host) return undefined;
    host.prepare().catch((error: unknown) => {
      console.warn("Android visual host warm-up failed", error);
    });
    return () => {
      host.release().catch((error: unknown) => {
        console.warn("Android visual host warm-up release failed", error);
      });
    };
  }, [active]);
}

/** The native two-way audio module reports whether it is still writing queued output. */
interface NativeAudioOutput {
  isPlaying(): boolean;
}
const nativeAudioOutput =
  Platform.OS === "web" ? null : requireOptionalNativeModule<NativeAudioOutput>("ExpoTwoWayAudio");
export const outputDrained = nativeAudioOutput ? () => !nativeAudioOutput.isPlaying() : undefined;

/** User-enabled background speech (Android): speech keeps playing while the app is hidden. */
export interface BackgroundSpeechState {
  available: boolean;
  enabled: boolean;
}
const BACKGROUND_SPEECH_KEY = "@paseo:background-speech";
let backgroundSpeech: BackgroundSpeechState = {
  available: Platform.OS === "android" && supportsBackgroundPlayback(),
  enabled: false,
};
let restoring: Promise<void> | null = null;
const backgroundListeners = new Set<() => void>();

function applyBackgroundSpeech(enabled: boolean): void {
  setBackgroundPlayback(enabled);
  backgroundSpeech = { ...backgroundSpeech, enabled };
  for (const listener of backgroundListeners) listener();
}

// The saved choice is applied when speech first mounts, in the foreground as Android requires.
function restoreBackgroundSpeech(): void {
  if (restoring || !backgroundSpeech.available) return;
  restoring = AsyncStorage.getItem(BACKGROUND_SPEECH_KEY)
    .then((saved) => {
      if (saved === "true" && !backgroundSpeech.enabled) applyBackgroundSpeech(true);
      return undefined;
    })
    .catch((error: unknown) => {
      console.warn("Background speech could not be restored", error);
    });
}

function subscribeBackgroundSpeech(listener: () => void): () => void {
  backgroundListeners.add(listener);
  restoreBackgroundSpeech();
  return () => {
    backgroundListeners.delete(listener);
  };
}

const getBackgroundSpeech = (): BackgroundSpeechState => backgroundSpeech;

export function useBackgroundSpeech(): BackgroundSpeechState {
  return useSyncExternalStore(subscribeBackgroundSpeech, getBackgroundSpeech, getBackgroundSpeech);
}

/** Turns background speech on (from the foreground) or off, and remembers the choice. */
export async function setBackgroundSpeech(enabled: boolean): Promise<void> {
  if (!backgroundSpeech.available)
    throw new Error("Background speech is only available in the Android app");
  // The playback notification carries the Stop action; Android 13+ asks before showing it.
  if (enabled && typeof Platform.Version === "number" && Platform.Version >= 33)
    await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS);
  applyBackgroundSpeech(enabled);
  await AsyncStorage.setItem(BACKGROUND_SPEECH_KEY, String(enabled));
}

/** The Stop action of the background playback notification. */
export function subscribeStopSpeechRequests(listener: () => void): () => void {
  if (!backgroundSpeech.available) return () => undefined;
  const subscription = addExpoTwoWayAudioEventListener("onStopSpeechRequest", listener);
  return () => subscription.remove();
}
