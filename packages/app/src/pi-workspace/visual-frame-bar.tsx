import type { ReactNode } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { Button } from "@/components/ui/button";

export interface VisualFrameProps {
  /** Show only the drawing: over the whole app on desktop and web, over the whole pane on phones. */
  fullscreen: boolean;
  title: string;
  onExit(): void;
  /** Controls for the full-screen bar where it covers the app header (desktop and web). */
  accessory?: ReactNode;
  /** The drawing surface. It stays mounted when full screen changes. */
  children: ReactNode;
}

interface VisualFullscreenBarProps {
  title: string;
  onExit(): void;
  accessory?: ReactNode;
}

/** The full-screen header: the drawing's title, optional controls and the way back. */
export function VisualFullscreenBar({ title, onExit, accessory }: VisualFullscreenBarProps) {
  return (
    <View style={styles.bar} testID="pi-visual-fullscreen-bar">
      <Text style={styles.title} numberOfLines={1}>
        {title}
      </Text>
      {accessory}
      <Button
        size="sm"
        variant="secondary"
        testID="pi-visual-exit-fullscreen"
        accessibilityLabel="Exit full screen"
        onPress={onExit}
      >
        Exit full screen
      </Button>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  bar: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    borderBottomWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface0,
  },
  title: {
    flex: 1,
    minWidth: 0,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
  },
}));
