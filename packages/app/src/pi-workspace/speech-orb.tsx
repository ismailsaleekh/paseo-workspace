import { useCallback } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import { useVoiceOptional } from "@/contexts/voice-context";
import { useMicrophoneActive } from "@/voice/microphone-activity";
import { setBackgroundSpeech, useBackgroundSpeech } from "./native-host";
import { useAppSpeech } from "./speech-connection";
import { speechOrbLabel, speechOrbPhase } from "./speech-orb-state";

/**
 * The compact voice control: who speaks and what the voice is doing, with Stop while speech
 * plays. A static phase dot, never a fake level meter. In app chrome, never floating over menus.
 */
export function SpeechOrb() {
  const speech = useAppSpeech();
  const voiceMode = useVoiceOptional();
  const microphone = useMicrophoneActive();
  const background = useBackgroundSpeech();
  const toggleBackground = useCallback(() => {
    setBackgroundSpeech(!background.enabled).catch((error: unknown) => {
      console.warn("Background speech could not be changed", error);
    });
  }, [background.enabled]);
  if (speech.status === "none") return null;
  const phase = speechOrbPhase({ speech, microphone, voiceMode });
  const label = speechOrbLabel(phase, speech.speaking?.voice ?? null);
  return (
    <View style={styles.orb} testID="speech-orb" accessibilityLabel={label}>
      <View style={styles[phase]} />
      <Text style={styles.label} numberOfLines={1}>
        {label}
      </Text>
      {speech.speaking ? (
        <Button
          size="sm"
          variant="secondary"
          testID="speech-stop"
          accessibilityLabel="Stop speech playback"
          onPress={speech.speaking.stop}
        >
          Stop
        </Button>
      ) : null}
      {background.available ? (
        <Button
          size="sm"
          variant="ghost"
          testID="speech-background"
          accessibilityLabel="Keep speaking when Paseo is in the background"
          onPress={toggleBackground}
        >
          {background.enabled ? "Background on" : "Background off"}
        </Button>
      ) : null}
    </View>
  );
}

const DOT = { width: 10, height: 10, borderRadius: 5 } as const;

const styles = StyleSheet.create((theme) => ({
  orb: { flexDirection: "row", alignItems: "center", gap: theme.spacing[1], minWidth: 0 },
  label: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm, flexShrink: 1 },
  speaking: { ...DOT, backgroundColor: theme.colors.statusSuccess },
  listening: { ...DOT, backgroundColor: theme.colors.statusDanger },
  muted: { ...DOT, borderWidth: 1, borderColor: theme.colors.statusDanger },
  waiting: { ...DOT, backgroundColor: theme.colors.statusWarning },
  offline: { ...DOT, borderWidth: 1, borderColor: theme.colors.foregroundMuted },
  ready: { ...DOT, backgroundColor: theme.colors.foregroundMuted },
}));
