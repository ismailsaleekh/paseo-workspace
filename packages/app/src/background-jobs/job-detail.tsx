import { memo, useCallback, useEffect, useState, type ReactElement } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { BackgroundJobView } from "@getpaseo/protocol/pi-background-jobs/rpc-schemas";
import { Button } from "@/components/ui/button";
import type { BackgroundJobsController, BackgroundJobsSnapshot } from "./controller";
import {
  jobRows,
  jobTitle,
  logWindowLabel,
  plainLogText,
  presentResult,
  telemetryRows,
  type DetailRow,
  type ResultPresentation,
} from "./view-model";

interface DetailError {
  message: string;
  retry: () => void;
}

/** One visible failure at a time, with the retry that recovers that read. */
function currentError(
  snapshot: BackgroundJobsSnapshot,
  controller: BackgroundJobsController,
): DetailError | null {
  if (snapshot.result.error)
    return { message: snapshot.result.error, retry: () => controller.openResult() };
  if (snapshot.logs.error)
    return { message: snapshot.logs.error, retry: () => controller.retryLogs() };
  if (snapshot.detail.error)
    return { message: snapshot.detail.error, retry: () => controller.retryDetail() };
  return null;
}

function useNow(ticking: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!ticking) return undefined;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [ticking]);
  return now;
}

export const BackgroundJobDetail = memo(function BackgroundJobDetail({
  controller,
  snapshot,
}: {
  controller: BackgroundJobsController;
  snapshot: BackgroundJobsSnapshot;
}): ReactElement {
  const back = useCallback(() => controller.back(), [controller]);
  const view = snapshot.detail.view;
  const error = currentError(snapshot, controller);
  const retry = useCallback(() => error?.retry(), [error]);
  return (
    <View style={styles.root} testID="bg-job-detail">
      <View style={styles.header}>
        <Button size="sm" variant="ghost" onPress={back} testID="bg-job-back">
          Back
        </Button>
        <Text style={styles.title} numberOfLines={2}>
          {view ? jobTitle(view.task) : (snapshot.selectedTaskId ?? "")}
        </Text>
      </View>
      {view ? <JobControls view={view} controller={controller} snapshot={snapshot} /> : null}
      {snapshot.action.status !== "idle" && snapshot.action.status !== "pending" ? (
        <Text style={styles.status} testID="bg-job-action" accessibilityRole="alert">
          {snapshot.action.message}
        </Text>
      ) : null}
      {error ? (
        <View style={styles.error} testID="bg-job-error">
          <Text style={styles.errorText} accessibilityRole="alert">
            {error.message}
          </Text>
          <Button size="sm" variant="secondary" onPress={retry} testID="bg-job-retry">
            Retry
          </Button>
        </View>
      ) : null}
      <JobResult controller={controller} snapshot={snapshot} />
      {view ? (
        <JobFacts view={view} />
      ) : (
        <Text style={styles.muted}>{snapshot.detail.status === "loading" ? "Loading…" : ""}</Text>
      )}
      {view ? <JobLogs controller={controller} snapshot={snapshot} view={view} /> : null}
    </View>
  );
});

const JobFacts = memo(function JobFacts({ view }: { view: BackgroundJobView }): ReactElement {
  const now = useNow(view.task.status === "running");
  const rows = jobRows(view.task, view.kind, now);
  const telemetry = telemetryRows(view.task);
  return (
    <View style={styles.section}>
      <Text style={styles.command} selectable>
        {view.task.command}
      </Text>
      {view.truncatedFields.length > 0 ? (
        <Text style={styles.muted}>{`Shortened: ${view.truncatedFields.join(", ")}`}</Text>
      ) : null}
      {rows.map((row) => (
        <FactRow key={row.key} row={row} />
      ))}
      <Text style={styles.sectionTitle}>Telemetry</Text>
      {telemetry.map((row) => (
        <FactRow key={row.key} row={row} />
      ))}
    </View>
  );
});

function FactRow({ row }: { row: DetailRow }): ReactElement {
  return (
    <View style={styles.fact}>
      <Text style={styles.factLabel}>{row.label}</Text>
      <Text style={styles.factValue} selectable>
        {row.value}
      </Text>
    </View>
  );
}

const JobControls = memo(function JobControls({
  view,
  controller,
  snapshot,
}: {
  view: BackgroundJobView;
  controller: BackgroundJobsController;
  snapshot: BackgroundJobsSnapshot;
}): ReactElement {
  const pending = snapshot.action.status === "pending";
  const pendingKind = snapshot.action.status === "pending" ? snapshot.action.kind : null;
  const outputPath = view.task.outputPath;
  const stop = useCallback(() => {
    void controller.stopJob();
  }, [controller]);
  const rerun = useCallback(() => {
    void controller.rerunJob();
  }, [controller]);
  const copyOutput = useCallback(() => {
    void controller.copy(outputPath, "output path");
  }, [controller, outputPath]);
  const openResult = useCallback(() => controller.openResult(), [controller]);
  const running = view.task.status === "running";
  return (
    <View style={styles.controls}>
      {running ? (
        <Button
          size="sm"
          variant="destructive"
          onPress={stop}
          disabled={pending}
          loading={pendingKind === "stop"}
          testID="bg-job-stop"
        >
          Stop
        </Button>
      ) : null}
      {view.canRerun ? (
        <Button
          size="sm"
          variant="secondary"
          onPress={rerun}
          disabled={pending}
          loading={pendingKind === "rerun"}
          testID="bg-job-rerun"
        >
          Rerun
        </Button>
      ) : null}
      {view.canReadResult ? (
        <Button
          size="sm"
          variant="secondary"
          onPress={openResult}
          loading={snapshot.result.status === "loading"}
          testID="bg-job-result-open"
        >
          Verified result
        </Button>
      ) : null}
      <Button size="sm" variant="ghost" onPress={copyOutput} testID="bg-job-copy-output">
        Copy output path
      </Button>
    </View>
  );
});

function copyTarget(
  presentation: ResultPresentation | null,
): { value: string; label: string; button: string } | null {
  if (presentation?.kind === "inline")
    return { value: presentation.text, label: "result", button: "Copy result" };
  if (presentation?.kind === "artifact")
    return { value: presentation.path, label: "artifact path", button: "Copy artifact path" };
  return null;
}

const JobResult = memo(function JobResult({
  controller,
  snapshot,
}: {
  controller: BackgroundJobsController;
  snapshot: BackgroundJobsSnapshot;
}): ReactElement | null {
  const view = snapshot.result.view;
  const presentation: ResultPresentation | null = view ? presentResult(view) : null;
  const target = copyTarget(presentation);
  const copyValue = target?.value ?? null;
  const copyLabel = target?.label ?? "result";
  const copy = useCallback(() => {
    if (copyValue !== null) void controller.copy(copyValue, copyLabel);
  }, [controller, copyLabel, copyValue]);
  if (!presentation) return null;
  return (
    <View style={styles.section} testID="bg-job-result-panel">
      <Text style={styles.sectionTitle}>Verified result</Text>
      {presentation.kind === "inline" ? (
        <>
          <Text style={styles.muted}>{presentation.summary}</Text>
          <Text style={styles.result} selectable testID="bg-job-result">
            {presentation.text}
          </Text>
        </>
      ) : null}
      {presentation.kind === "artifact" ? (
        <>
          <Text style={styles.muted}>{`${presentation.summary} · too large to show inline`}</Text>
          <Text style={styles.command} selectable testID="bg-job-result-artifact">
            {presentation.path}
          </Text>
        </>
      ) : null}
      {presentation.kind === "running" || presentation.kind === "no_answer" ? (
        <Text style={styles.muted} testID="bg-job-result-state">
          {presentation.message}
        </Text>
      ) : null}
      {target ? (
        <Button size="sm" variant="ghost" onPress={copy} testID="bg-job-result-copy">
          {target.button}
        </Button>
      ) : null}
    </View>
  );
});

const JobLogs = memo(function JobLogs({
  controller,
  snapshot,
  view,
}: {
  controller: BackgroundJobsController;
  snapshot: BackgroundJobsSnapshot;
  view: BackgroundJobView;
}): ReactElement {
  const pause = useCallback(() => controller.pause(), [controller]);
  const follow = useCallback(() => controller.follow(), [controller]);
  const logs = snapshot.logs;
  const running = view.task.status === "running";
  const text = logs.result ? plainLogText(logs.result.text) : "";
  return (
    <View style={styles.section}>
      <View style={styles.logsHeader}>
        <Text style={styles.sectionTitle}>Output</Text>
        {running && logs.following ? (
          <Button size="xs" variant="ghost" onPress={pause} testID="bg-job-pause">
            Pause
          </Button>
        ) : null}
        {running && !logs.following ? (
          <Button size="xs" variant="ghost" onPress={follow} testID="bg-job-follow">
            Follow
          </Button>
        ) : null}
      </View>
      {logs.result ? <Text style={styles.muted}>{logWindowLabel(logs.result)}</Text> : null}
      {logs.status === "loading" && !logs.result ? (
        <Text style={styles.muted}>Loading…</Text>
      ) : null}
      <Text style={styles.logs} selectable testID="bg-job-logs">
        {text}
      </Text>
    </View>
  );
});

const styles = StyleSheet.create((theme) => ({
  root: {
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    gap: theme.spacing[3],
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  title: {
    flexShrink: 1,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foreground,
  },
  section: {
    gap: theme.spacing[1],
  },
  sectionTitle: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foreground,
  },
  fact: {
    flexDirection: "row",
    gap: theme.spacing[2],
  },
  factLabel: {
    width: 88,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  factValue: {
    flex: 1,
    minWidth: 0,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
  },
  command: {
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.code,
    color: theme.colors.foreground,
  },
  controls: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[2],
  },
  status: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  error: {
    gap: theme.spacing[2],
    padding: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    borderColor: theme.colors.destructive,
    alignItems: "flex-start",
  },
  errorText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
  },
  muted: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  result: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
  },
  logsHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  logs: {
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.code,
    color: theme.colors.foreground,
    backgroundColor: theme.colors.surface2,
    borderRadius: theme.borderRadius.md,
    padding: theme.spacing[2],
    minHeight: 48,
  },
}));
