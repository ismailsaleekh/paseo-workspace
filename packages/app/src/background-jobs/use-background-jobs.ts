import { useEffect, useMemo, useSyncExternalStore } from "react";
import { AppState } from "react-native";
import * as Clipboard from "expo-clipboard";
import { useRetainedPanelActive } from "@/components/retained-panel";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import { confirmDialog } from "@/utils/confirm-dialog";
import {
  BackgroundJobsController,
  INITIAL_BACKGROUND_JOBS_SNAPSHOT,
  type BackgroundJobsSnapshot,
  type ConfirmRequest,
} from "./controller";
import { isTrackVisible } from "./view-model";

export interface BackgroundJobsHandle {
  controller: BackgroundJobsController;
  snapshot: BackgroundJobsSnapshot;
  visible: boolean;
}

const confirmJobsAction = (request: ConfirmRequest): Promise<boolean> =>
  confirmDialog({
    title: request.title,
    message: request.message,
    confirmLabel: request.confirmLabel,
    cancelLabel: "Cancel",
    destructive: request.destructive,
  });

const copyText = async (text: string): Promise<void> => {
  const copied = await Clipboard.setStringAsync(text);
  if (copied === false) throw new Error("The clipboard rejected the text");
};

const noSubscription = (): (() => void) => () => {};
const initialSnapshot = (): BackgroundJobsSnapshot => INITIAL_BACKGROUND_JOBS_SNAPSHOT;

/**
 * One observation per visible, active pane of a Pi agent. A hidden pane releases its observation;
 * a backgrounded app keeps the event-driven counts but stops log following. The host feature is
 * checked once here; downstream code reads a clean snapshot.
 */
export function useBackgroundJobs(input: {
  serverId: string;
  agentId: string;
  enabled: boolean;
}): BackgroundJobsHandle | null {
  const { serverId, agentId, enabled } = input;
  const client = useHostRuntimeClient(serverId);
  const active = useRetainedPanelActive();
  const supported = useSessionStore(
    (state) => state.sessions[serverId]?.serverInfo?.features?.piBackgroundJobs === true,
  );
  const controller = useMemo(
    () =>
      client && enabled && supported
        ? new BackgroundJobsController(client, agentId, {
            confirm: confirmJobsAction,
            copy: copyText,
          })
        : null,
    [client, agentId, enabled, supported],
  );
  const foreground = useAppForeground();
  const observing = controller !== null && active;
  useEffect(() => {
    if (!controller || !observing) return undefined;
    controller.start();
    return () => {
      void controller.stop();
    };
  }, [controller, observing]);
  useEffect(() => {
    controller?.setForeground(foreground);
  }, [controller, foreground]);
  const snapshot = useSyncExternalStore(
    controller?.subscribe ?? noSubscription,
    controller?.getSnapshot ?? initialSnapshot,
    controller?.getSnapshot ?? initialSnapshot,
  );
  const visible = observing && isTrackVisible(snapshot.state);
  return useMemo(
    () => (controller ? { controller, snapshot, visible } : null),
    [controller, snapshot, visible],
  );
}

function useAppForeground(): boolean {
  const current = useSyncExternalStore(subscribeAppState, readAppState, readAppState);
  return current !== "background" && current !== "inactive";
}

function subscribeAppState(listener: () => void): () => void {
  const subscription = AppState.addEventListener("change", listener);
  return () => subscription.remove();
}

function readAppState(): string {
  return AppState.currentState ?? "active";
}
