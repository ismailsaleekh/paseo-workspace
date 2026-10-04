import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import { Text, View } from "react-native";
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

function ConnectedVisualHost({ client, agentId }: ConnectedVisualHostProps) {
  const active = useRetainedPanelActive();
  const controller = useMemo(() => new VisualController(client, agentId), [client, agentId]);
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
          renderCommandId={state.renderCommandId}
          command={state.command}
          receive={controller.receive}
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
