import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useReducer,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { useIsCompactFormFactor } from "@/constants/layout";
import { VisualSidebar } from "./visual-sidebar";
import { visualSidebarLayout, VISUAL_CHAT_LAYOUT } from "./sidebar-layout";
import { AppState, Platform, Text, View } from "react-native";
import { useAndroidRendererWarmup } from "./native-host";
import { getIsElectron } from "@/constants/platform";
import type { VisualPlatform } from "@getpaseo/protocol/pi-workspace/contracts";
import { StyleSheet } from "react-native-unistyles";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { RetainedPanel, useRetainedPanelActive } from "@/components/retained-panel";
import { Button } from "@/components/ui/button";
import { VisualController, type VisualTransport } from "./controller";
import { VisualDocument } from "./document";

export type VisualHostClient = VisualTransport & Pick<DaemonClient, "requestVisualLibrary">;
interface ConnectedVisualHostProps {
  client: VisualHostClient;
  agentId: string;
  children: ReactNode;
  /** Extra controls next to the Drawings toggle (the speech orb in desktop focus mode). */
  chromeAccessory?: ReactNode;
  /** Controls for the full-screen drawing bar (the speech orb). */
  fullscreenAccessory?: ReactNode;
}

function visualPlatform(): VisualPlatform {
  if (Platform.OS === "web") return getIsElectron() ? "electron" : "web";
  if (Platform.OS === "android" || Platform.OS === "ios") return Platform.OS;
  throw new Error("Pi visual workspace is unavailable on this platform");
}

/**
 * Full screen belongs to the drawing it was opened on: a new drawing, a closed sidebar or an
 * inactive chat ends it. `enterFullscreen` is null while no drawing is shown.
 */
function useVisualFullscreen(nonce: string | null, open: boolean) {
  const [fullscreenNonce, setFullscreenNonce] = useState<string | null>(null);
  const enter = useCallback(() => setFullscreenNonce(nonce), [nonce]);
  const exitFullscreen = useCallback(() => setFullscreenNonce(null), []);
  return {
    fullscreen: open && nonce !== null && fullscreenNonce === nonce,
    enterFullscreen: nonce === null ? null : enter,
    exitFullscreen,
  };
}

// On Android a backgrounded app releases its display (DISPLAY_UNAVAILABLE when addressed); the
// foregrounded app observes again and remounts the stored visual with a fresh document identity.
function useAndroidForeground(): boolean {
  const [foreground, setForeground] = useState(
    () => Platform.OS !== "android" || AppState.currentState !== "background",
  );
  useEffect(() => {
    if (Platform.OS !== "android") return undefined;
    const subscription = AppState.addEventListener("change", (state) => {
      setForeground(state !== "background");
    });
    return () => subscription.remove();
  }, []);
  return foreground;
}

export function ConnectedVisualHost({
  client,
  agentId,
  children,
  chromeAccessory = null,
  fullscreenAccessory,
}: ConnectedVisualHostProps) {
  const [reconnect, restart] = useReducer((version: number) => version + 1, 0);
  const compact = useIsCompactFormFactor();
  const retained = useRetainedPanelActive();
  const foreground = useAndroidForeground();
  const active = retained && foreground;
  useAndroidRendererWarmup(active);
  const controller = useMemo(
    () => new VisualController(client, agentId, visualPlatform(), client),
    [client, agentId],
  );
  const state = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );
  const library = useSyncExternalStore(
    controller.subscribe,
    controller.getLibrarySnapshot,
    controller.getLibrarySnapshot,
  );
  const toggleLibrary = useCallback(() => {
    void controller.setLibraryVisible(!library.visible);
  }, [controller, library.visible]);
  const retryLibrary = useCallback(() => {
    void controller.refreshLibrary();
  }, [controller]);
  const open = library.visible && active;
  const nonce = state.current?.binding.nonce ?? null;
  const { fullscreen, enterFullscreen, exitFullscreen } = useVisualFullscreen(nonce, open);
  const layout = visualSidebarLayout(compact, open, fullscreen);
  const reportError = useCallback((error: unknown) => controller.reportError(error), [controller]);
  useEffect(() => {
    let cancelled = false;
    if (active) {
      void controller
        .stop()
        .then(() => {
          if (!cancelled) controller.start();
          return undefined;
        })
        .catch((error: unknown) => {
          if (!cancelled) reportError(error);
          else console.warn("Obsolete visual host release failed", error);
        });
    }
    return () => {
      cancelled = true;
      // A failure remains loud, but cannot publish into an inactive or replaced host.
      void controller
        .stop()
        .catch((error: unknown) => console.warn("Visual host teardown failed", error));
    };
  }, [controller, active, reconnect, reportError]);
  const surface =
    !state.current && state.error === null ? null : (
      <View style={styles.surface} testID="pi-workspace-surface">
        {state.error ? (
          <View style={styles.notice}>
            <Text style={styles.error} accessibilityRole="alert">
              {state.error}
            </Text>
            <Button size="sm" variant="secondary" onPress={restart}>
              Reconnect visual
            </Button>
          </View>
        ) : null}
        {state.status === "loading" ? (
          <Text style={styles.pending}>Waiting for visual display acknowledgement…</Text>
        ) : null}
        {state.current ? (
          <VisualDocument
            key={state.current.binding.nonce}
            current={state.current}
            restoration={state.restoration}
            acknowledgement={state.acknowledgement}
            renderCommandId={state.renderCommandId}
            command={state.command}
            receive={controller.receive}
            hostEvent={controller.hostEvent}
            onEscape={exitFullscreen}
            reportError={reportError}
          />
        ) : null}
      </View>
    );
  return (
    <View style={[styles.layout, { flexDirection: layout.direction }]}>
      <RetainedPanel active={layout.chatVisible} style={VISUAL_CHAT_LAYOUT}>
        <View style={styles.chrome}>
          <Button
            variant="ghost"
            size="sm"
            testID="pi-visuals-toggle"
            disabled={!active || library.status === "loading"}
            onPress={toggleLibrary}
          >
            Drawings{library.items.length ? ` (${library.items.length})` : ""}
          </Button>
          {chromeAccessory}
        </View>
        {state.error && !library.visible ? (
          <Text accessibilityRole="alert" style={styles.error}>
            {state.error}
          </Text>
        ) : null}
        {library.error && !library.visible ? (
          <View style={styles.notice}>
            <Text accessibilityRole="alert" style={styles.error}>
              {library.error}
            </Text>
            <Button variant="ghost" size="sm" onPress={retryLibrary}>
              Retry library
            </Button>
          </View>
        ) : null}
        {children}
      </RetainedPanel>
      {layout.sidebarVisible ? (
        <VisualSidebar
          controller={controller}
          library={library}
          current={state.current?.document ?? null}
          compact={compact}
          fullscreen={fullscreen}
          onFullscreen={enterFullscreen}
          onExitFullscreen={exitFullscreen}
          fullscreenAccessory={fullscreenAccessory}
        >
          {surface}
        </VisualSidebar>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  layout: { flex: 1, minHeight: 0, minWidth: 0, width: "100%" },
  chrome: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  surface: { flex: 1, minHeight: 280, width: "100%", backgroundColor: theme.colors.background },
  notice: { padding: theme.spacing[2], gap: theme.spacing[2] },
  error: { color: theme.colors.foreground },
  pending: { color: theme.colors.foregroundMuted, padding: theme.spacing[2] },
}));
