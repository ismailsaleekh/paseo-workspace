// Bound the retained chat to the space left by the dock, even with intrinsically wide message content.
export const VISUAL_CHAT_LAYOUT = {
  minWidth: 0,
  flexBasis: 0,
  flexGrow: 1,
  flexShrink: 1,
} as const;
export const VISUAL_SIDEBAR_WIDE_LAYOUT = {
  width: 400,
  flexBasis: 400,
  flexGrow: 0,
  flexShrink: 0,
  minWidth: 0,
} as const;

export function visualSidebarLayout(
  compact: boolean,
  open: boolean,
): { chatVisible: boolean; sidebarVisible: boolean; direction: "row" | "column" } {
  return {
    chatVisible: !compact || !open,
    sidebarVisible: open,
    direction: compact ? "column" : "row",
  };
}
