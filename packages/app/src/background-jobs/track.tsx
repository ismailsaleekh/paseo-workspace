import { memo, useCallback, useMemo, type ReactElement } from "react";
import { View, useWindowDimensions } from "react-native";
import { BottomSheetScrollView } from "@gorhom/bottom-sheet";
import { FloatingScrollView } from "@/components/ui/floating";
import { useMenuContext } from "@/components/ui/menu";
import { ComposerTrackPill } from "@/composer/tracks";
import type { BackgroundJobsHandle } from "./use-background-jobs";
import { BackgroundJobDetail } from "./job-detail";
import { BackgroundJobList } from "./job-list";
import { jobsPanelViewport, pillAccessibilityLabel, pillSegments } from "./view-model";

/**
 * The background jobs pill above the composer. It opens the shared track panel: a popover on wide
 * layouts and a sheet on compact ones. Jobs stay separate from todos and provider subagents.
 */
export const BackgroundJobsTrack = memo(function BackgroundJobsTrack({
  handle,
}: {
  handle: BackgroundJobsHandle;
}): ReactElement | null {
  const { controller, snapshot, visible } = handle;
  const segments = useMemo(() => pillSegments(snapshot.state), [snapshot.state]);
  const accessibilityLabel = useMemo(
    () => pillAccessibilityLabel(snapshot.state),
    [snapshot.state],
  );
  const handleOpenChange = useCallback(
    (open: boolean) => controller.setDisplayed(open),
    [controller],
  );
  if (!visible) return null;
  return (
    <ComposerTrackPill
      testID="bg-jobs-trigger"
      panelTestID="bg-jobs-surface"
      panelScrollable={false}
      panelTitle="Background jobs"
      segments={segments}
      accessibilityLabel={accessibilityLabel}
      onOpenChange={handleOpenChange}
    >
      <BackgroundJobsPanel handle={handle} />
    </ComposerTrackPill>
  );
});

/**
 * Own the actual content container, not the menu's platform-specific test ID forwarding (the
 * compact surface appends '-content'). List/detail share one fixed viewport; only their contents
 * scroll. Native compact uses the sheet-aware scroll primitive, desktop uses the floating one.
 */
function BackgroundJobsPanel({ handle }: { handle: BackgroundJobsHandle }): ReactElement {
  const { controller, snapshot } = handle;
  const { presentation } = useMenuContext("BackgroundJobsPanel");
  const { width, height } = useWindowDimensions();
  const viewport = useMemo(() => jobsPanelViewport(width, height), [width, height]);
  const scrollStyle = useMemo(() => ({ height: viewport.height }), [viewport.height]);
  const content = snapshot.selectedTaskId ? (
    <BackgroundJobDetail controller={controller} snapshot={snapshot} />
  ) : (
    <BackgroundJobList controller={controller} snapshot={snapshot} />
  );
  return (
    <View collapsable={false} testID="bg-jobs-panel" style={viewport}>
      {presentation === "sheet" ? (
        <BottomSheetScrollView style={scrollStyle} keyboardShouldPersistTaps="handled">
          {content}
        </BottomSheetScrollView>
      ) : (
        <FloatingScrollView
          style={scrollStyle}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator
        >
          {content}
        </FloatingScrollView>
      )}
    </View>
  );
}
