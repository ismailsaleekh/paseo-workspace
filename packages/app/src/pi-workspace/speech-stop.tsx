import { useCallback, useSyncExternalStore } from "react";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import type { SpeechPlayer } from "./speech-player";

/**
 * Visible while agent speech plays, in the conversation's most recently mounted panel; stops
 * playback only (never the agent, draft or microphone).
 */
export function SpeechStop({ player, holder }: { player: SpeechPlayer; holder: object | null }) {
  const state = useSyncExternalStore(player.subscribe, player.getSnapshot, player.getSnapshot);
  const stop = useCallback(() => player.stop(), [player]);
  if (state.utterance === null || holder === null || state.holder !== holder) return null;
  return (
    <View style={styles.bar}>
      <Button
        size="sm"
        variant="secondary"
        testID="speech-stop"
        accessibilityRole="button"
        accessibilityLabel="Stop speech playback"
        onPress={stop}
      >
        Stop speech
      </Button>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  bar: {
    flexDirection: "row",
    justifyContent: "flex-end",
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
  },
}));
