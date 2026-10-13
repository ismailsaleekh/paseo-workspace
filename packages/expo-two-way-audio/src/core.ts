import { type PermissionResponse } from "expo-modules-core";
import { AppRegistry } from "react-native";
import ExpoTwoWayAudioModule from "./ExpoTwoWayAudioModule";

/** Headless task of the background playback service (Android). */
export const BACKGROUND_PLAYBACK_TASK = "ExpoTwoWayAudioBackgroundPlayback";
let finishBackgroundTask: (() => void) | null = null;
// While background playback is enabled this task keeps JS timers running in the background;
// it finishes when background playback is disabled, which stops its service.
AppRegistry.registerHeadlessTask(
  BACKGROUND_PLAYBACK_TASK,
  () => () =>
    new Promise<void>((resolve) => {
      finishBackgroundTask = resolve;
    }),
);

/** Whether this binary can keep speech playing in the background (Android). */
export function supportsBackgroundPlayback(): boolean {
  // COMPAT(backgroundPlayback): added in v0.10.4. An OTA JS update can land on an older binary
  // without the native function. Drop the guard once the binary floor is >= v0.10.4.
  return typeof ExpoTwoWayAudioModule.setBackgroundPlayback === "function";
}

/** Starts (from the foreground) or stops the background playback service. */
export function setBackgroundPlayback(enabled: boolean): void {
  if (!enabled) {
    finishBackgroundTask?.();
    finishBackgroundTask = null;
  }
  ExpoTwoWayAudioModule.setBackgroundPlayback(enabled);
}

export async function initialize() {
  return await ExpoTwoWayAudioModule.initialize();
}

export function playPCMData(audioData: Uint8Array) {
  return ExpoTwoWayAudioModule.playPCMData(audioData);
}

export function bypassVoiceProcessing(bypass: boolean) {
  return ExpoTwoWayAudioModule.bypassVoiceProcessing(bypass);
}

export function toggleRecording(val: boolean): boolean {
  return ExpoTwoWayAudioModule.toggleRecording(val);
}

export function isRecording(): boolean {
  return ExpoTwoWayAudioModule.isRecording();
}

/**
 * Hand the OS audio session / audio focus back once nothing is being captured or played,
 * so other apps' audio can resume. Safe to call when already released.
 */
export function releaseAudioSession() {
  // COMPAT(releaseAudioSession): added in v0.2.6. An OTA JS update can land on an older
  // binary whose native module lacks this function, so probe the native object rather than
  // this wrapper (which always exists). Drop the guard once the binary floor is >= v0.2.6.
  if (typeof ExpoTwoWayAudioModule.releaseAudioSession !== "function") {
    return;
  }
  return ExpoTwoWayAudioModule.releaseAudioSession();
}

export function tearDown() {
  return ExpoTwoWayAudioModule.tearDown();
}

export function restart() {
  return ExpoTwoWayAudioModule.restart();
}

export async function getMicrophonePermissionsAsync(): Promise<PermissionResponse> {
  return ExpoTwoWayAudioModule.getMicrophonePermissionsAsync();
}

export async function requestMicrophonePermissionsAsync(): Promise<PermissionResponse> {
  return ExpoTwoWayAudioModule.requestMicrophonePermissionsAsync();
}

export function getMicrophoneModeIOS() {
  return ExpoTwoWayAudioModule.getMicrophoneModeIOS();
}

export function setMicrophoneModeIOS() {
  return ExpoTwoWayAudioModule.setMicrophoneModeIOS();
}

export function isPlaying(): boolean {
  return ExpoTwoWayAudioModule.isPlaying();
}

export function stopPlayback() {
  return ExpoTwoWayAudioModule.stopPlayback();
}

export function pausePlayback() {
  return ExpoTwoWayAudioModule.pausePlayback();
}

export function resumePlayback() {
  return ExpoTwoWayAudioModule.resumePlayback();
}
