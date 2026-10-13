import { useEffect, useSyncExternalStore } from "react";

let recording = 0;
const listeners = new Set<() => void>();

function publish(): void {
  for (const listener of listeners) listener();
}

/** Reports that this component captures microphone audio while `active`. */
export function useReportMicrophoneActivity(active: boolean): void {
  useEffect(() => {
    if (!active) return undefined;
    recording += 1;
    publish();
    return () => {
      recording -= 1;
      publish();
    };
  }, [active]);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const isRecording = (): boolean => recording > 0;
const notRecording = (): boolean => false;

/** Whether any dictation is capturing microphone audio. */
export function useMicrophoneActive(): boolean {
  return useSyncExternalStore(subscribe, isRecording, notRecording);
}
