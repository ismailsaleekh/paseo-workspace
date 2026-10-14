import { useCallback, useLayoutEffect, useRef, type CSSProperties } from "react";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import {
  isOccludedByWebOverlay,
  subscribeWebOverlayActivity,
  useGlobalWebOverlayLayer,
  useWebOverlayRegistration,
} from "@/lib/overlay-root";
import { VisualFullscreenBar, type VisualFrameProps } from "./visual-frame-bar";

// One element in both modes, so the drawing (iframe or native view) is never remounted. In full
// screen it is shown as a popover: the browser's top layer, above all app chrome, without moving it.
const INLINE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  flexGrow: 1,
  flexShrink: 1,
  flexBasis: 0,
  minHeight: 0,
  minWidth: 0,
  position: "relative",
  inset: "auto",
  width: "auto",
  height: "auto",
  maxWidth: "none",
  maxHeight: "none",
  margin: 0,
  padding: 0,
  border: 0,
  overflow: "visible",
  background: "transparent",
  color: "inherit",
};
const FULLSCREEN: CSSProperties = {
  ...INLINE,
  position: "fixed",
  inset: 0,
  width: "100vw",
  height: "100vh",
  overflow: "hidden",
};

/**
 * Desktop and web: full screen covers the whole app like an image viewer. It registers as a modal
 * overlay, so Escape reaches it before app shortcuts; any other overlay opening ends it, because
 * that overlay would paint below the top layer.
 */
export function VisualFrame({ fullscreen, title, onExit, accessory, children }: VisualFrameProps) {
  const frame = useRef<HTMLDivElement | null>(null);
  const layer = useGlobalWebOverlayLayer("modal", fullscreen);
  const handleKeyDown = useCallback(
    (event: KeyboardEvent) => {
      if (event.key !== "Escape") return false;
      event.preventDefault();
      onExit();
      return true;
    },
    [onExit],
  );
  const setScope = useWebOverlayRegistration({
    active: fullscreen,
    layer,
    onKeyDown: handleKeyDown,
  });
  const setFrame = useCallback(
    (node: HTMLDivElement | null) => {
      frame.current = node;
      setScope(node);
    },
    [setScope],
  );
  useLayoutEffect(() => {
    const element = frame.current;
    if (!element) return;
    const open = element.matches(":popover-open");
    if (fullscreen && !open) element.showPopover();
    if (!fullscreen && open) element.hidePopover();
  }, [fullscreen]);
  useLayoutEffect(() => {
    if (!fullscreen) return undefined;
    let left = false;
    return subscribeWebOverlayActivity(() => {
      const element = frame.current;
      if (left || !element || !isOccludedByWebOverlay(element)) return;
      left = true;
      onExit();
    });
  }, [fullscreen, onExit]);
  return (
    <div
      ref={setFrame}
      popover="manual"
      data-testid="pi-visual-frame"
      style={fullscreen ? FULLSCREEN : INLINE}
    >
      <View style={styles.content}>
        {fullscreen ? (
          <VisualFullscreenBar title={title} onExit={onExit} accessory={accessory} />
        ) : null}
        {children}
      </View>
    </div>
  );
}

const styles = StyleSheet.create((theme) => ({
  content: { flex: 1, minHeight: 0, backgroundColor: theme.colors.surface0 },
}));
