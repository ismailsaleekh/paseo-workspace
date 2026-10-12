import { memo, useCallback, type ReactElement } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { BackgroundJobView } from "@getpaseo/protocol/pi-background-jobs/rpc-schemas";
import { Button } from "@/components/ui/button";
import { ComposerTrackActions, ComposerTrackRow } from "@/composer/tracks";
import type { BackgroundJobsController, BackgroundJobsSnapshot } from "./controller";
import { jobTitle, kindLabel, stateMessage, statusLabel } from "./view-model";

export const BackgroundJobList = memo(function BackgroundJobList({
  controller,
  snapshot,
}: {
  controller: BackgroundJobsController;
  snapshot: BackgroundJobsSnapshot;
}): ReactElement {
  const state = snapshot.state;
  const list = snapshot.list;
  const stopAll = useCallback(() => {
    void controller.stopAllJobs();
  }, [controller]);
  const loadMore = useCallback(() => controller.loadMore(), [controller]);
  const retry = useCallback(() => controller.refreshList(), [controller]);
  const reconnect = useCallback(() => {
    void controller.restart();
  }, [controller]);
  if (!state || state.status !== "ready")
    return (
      <View style={styles.notice} testID="bg-jobs-state">
        <Text style={styles.noticeText}>{stateMessage(state)}</Text>
        {state?.status === "error" ? (
          <Button size="sm" variant="secondary" onPress={reconnect} testID="bg-jobs-reconnect">
            Try again
          </Button>
        ) : null}
      </View>
    );
  const action = snapshot.action;
  const pending = action.status === "pending";
  return (
    <>
      {state.counts.running > 0 ? (
        <ComposerTrackActions divided={list.jobs.length > 0}>
          <ComposerTrackRow
            accessibilityLabel="Stop all running jobs"
            testID="bg-jobs-stop-all"
            onPress={stopAll}
            closeOnSelect={false}
            disabled={pending}
          >
            <Text style={styles.actionLabel}>
              {pending && action.kind === "stop_all" ? "Stopping…" : "Stop all running"}
            </Text>
          </ComposerTrackRow>
        </ComposerTrackActions>
      ) : null}
      {action.status !== "idle" && action.status !== "pending" ? (
        <Text style={styles.status} testID="bg-jobs-action" accessibilityRole="alert">
          {action.message}
        </Text>
      ) : null}
      {list.status === "loading" && list.jobs.length === 0 ? (
        <Text style={styles.status}>Loading jobs…</Text>
      ) : null}
      {list.status === "ready" && list.jobs.length === 0 ? (
        <Text style={styles.status}>No retained jobs</Text>
      ) : null}
      {list.jobs.map((job) => (
        <BackgroundJobRow key={job.task.id} job={job} controller={controller} />
      ))}
      {list.error ? (
        <View style={styles.notice} testID="bg-jobs-list-error">
          <Text style={styles.noticeText} accessibilityRole="alert">
            {list.error}
          </Text>
          <Button size="sm" variant="secondary" onPress={retry}>
            Retry
          </Button>
        </View>
      ) : null}
      {list.nextCursor ? (
        <View style={styles.notice}>
          <Button
            size="sm"
            variant="ghost"
            onPress={loadMore}
            loading={list.loadingMore}
            testID="bg-jobs-more"
          >
            Load older jobs
          </Button>
        </View>
      ) : null}
    </>
  );
});

const BackgroundJobRow = memo(function BackgroundJobRow({
  job,
  controller,
}: {
  job: BackgroundJobView;
  controller: BackgroundJobsController;
}): ReactElement {
  const taskId = job.task.id;
  const open = useCallback(() => controller.select(taskId), [controller, taskId]);
  const title = jobTitle(job.task);
  const unseen = job.task.status !== "running" && !job.seen;
  return (
    <ComposerTrackRow
      accessibilityLabel={`${title}, ${statusLabel(job.task.status)}`}
      testID={`bg-job-${taskId}`}
      onPress={open}
      closeOnSelect={false}
    >
      <Text style={styles.rowLabel} numberOfLines={1}>
        {title}
      </Text>
      <Text style={styles.rowTrailing} numberOfLines={1}>
        {`${kindLabel(job.kind)} · ${statusLabel(job.task.status)}${unseen ? " · new" : ""}`}
      </Text>
    </ComposerTrackRow>
  );
});

const styles = StyleSheet.create((theme) => ({
  rowLabel: {
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: "auto",
    minWidth: 0,
    fontSize: theme.fontSize.base,
    color: theme.colors.foreground,
  },
  rowTrailing: {
    flexShrink: 2,
    minWidth: 0,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  actionLabel: {
    flexGrow: 1,
    fontSize: theme.fontSize.base,
    color: theme.colors.foreground,
  },
  status: {
    marginHorizontal: theme.spacing[3],
    marginVertical: theme.spacing[1],
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  notice: {
    marginHorizontal: theme.spacing[3],
    marginVertical: theme.spacing[2],
    gap: theme.spacing[2],
    alignItems: "flex-start",
  },
  noticeText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
  },
}));
