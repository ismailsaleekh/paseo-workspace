import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { AppState, Platform, Text, View } from "react-native";
import { requireOptionalNativeModule } from "expo";
import { getIsElectron } from "@/constants/platform";
import type { VisualPlatform } from "@getpaseo/protocol/pi-workspace/contracts";
import { StyleSheet } from "react-native-unistyles";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { useRetainedPanelActive } from "@/components/retained-panel";
import { Button } from "@/components/ui/button";
import { VisualController } from "./controller";
import { VisualDocument } from "./document";

export interface VisualHostProps {
  serverId: string;
  agentId: string;
}
interface ConnectedVisualHostProps {
  client: DaemonClient;
  agentId: string;
}

export function VisualHost({ serverId, agentId }: VisualHostProps) {
  const client = useHostRuntimeClient(serverId);
  if (!client) return null;
  return <ConnectedVisualHost client={client} agentId={agentId} />;
}

function visualPlatform(): VisualPlatform {
  if (Platform.OS === "web") return getIsElectron() ? "electron" : "web";
  if (Platform.OS === "android" || Platform.OS === "ios") return Platform.OS;
  throw new Error("Pi visual workspace is unavailable on this platform");
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

interface AndroidRendererWarmup {
  prepare(): Promise<void>;
  release(): Promise<void>;
}
// While a visual surface is active, keep the companion visual host started so a document's
// display deadline does not include the host's cold start. Rendering still needs the document
// view; this only binds and warms the host.
function useAndroidRendererWarmup(active: boolean): void {
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

function ConnectedVisualHost({ client, agentId }: ConnectedVisualHostProps) {
  const retained = useRetainedPanelActive();
  const foreground = useAndroidForeground();
  const active = retained && foreground;
  useAndroidRendererWarmup(active);
  const controller = useMemo(
    () => new VisualController(client, agentId, visualPlatform()),
    [client, agentId],
  );
  const state = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );
  const reportError = useCallback((error: unknown) => controller.reportError(error), [controller]);
  const restart = useCallback(() => {
    void controller
      .stop()
      .then(() => controller.start())
      .catch(reportError);
  }, [controller, reportError]);
  useEffect(() => {
    let cancelled = false;
    if (active) {
      void controller
        .stop()
        .then(() => {
          if (!cancelled) controller.start();
          return undefined;
        })
        .catch(reportError);
    }
    return () => {
      cancelled = true;
      void controller.stop().catch(reportError);
    };
  }, [controller, active, reportError]);
  if (!active || (!state.current && state.error === null)) return null;
  return (
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
          renderCommandId={state.renderCommandId}
          command={state.command}
          receive={controller.receive}
          hostEvent={controller.hostEvent}
          reportError={reportError}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  surface: { height: 360, minHeight: 280, width: "100%", backgroundColor: theme.colors.background },
  notice: { padding: 8, gap: 8 },
  error: { color: theme.colors.foreground },
  pending: { color: theme.colors.foregroundMuted, padding: 8 },
}));
