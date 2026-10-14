import { useEffect } from "react";
import { BackHandler, StatusBar, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { VisualFullscreenBar, type VisualFrameProps } from "./visual-frame-bar";

/**
 * Phones: full screen gives the drawing the whole pane and hides the status bar; the system Back
 * gesture leaves it. The workspace header (with the voice orb) stays, so no bar accessory is shown.
 */
export function VisualFrame({ fullscreen, title, onExit, children }: VisualFrameProps) {
  useEffect(() => {
    if (!fullscreen) return undefined;
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      onExit();
      return true;
    });
    return () => subscription.remove();
  }, [fullscreen, onExit]);
  return (
    <View style={styles.frame} testID="pi-visual-frame">
      {fullscreen ? (
        <>
          <StatusBar hidden />
          <VisualFullscreenBar title={title} onExit={onExit} />
        </>
      ) : null}
      {children}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  frame: { flex: 1, minHeight: 0, backgroundColor: theme.colors.surface0 },
}));
