import { memo, useCallback, type ReactNode } from "react";
import { ScrollView, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import type { VisualDocument } from "@getpaseo/protocol/pi-workspace/contracts";
import type { VisualController, VisualLibraryState } from "./controller";
import { visualHistoryLabel } from "./library";
import { VISUAL_SIDEBAR_WIDE_LAYOUT } from "./sidebar-layout";

interface VisualSidebarProps {
  controller: VisualController;
  library: VisualLibraryState;
  current: VisualDocument | null;
  compact: boolean;
  children: ReactNode;
}
interface DrawingRowProps {
  controller: VisualController;
  id: string;
  title: string;
  pending: boolean;
}
const DrawingRow = memo(function DrawingRow({ controller, id, title, pending }: DrawingRowProps) {
  const select = useCallback(() => {
    void controller.selectVisual(id);
  }, [controller, id]);
  return (
    <Button
      variant="ghost"
      size="sm"
      disabled={pending}
      testID={`pi-visual-library-item-${id}`}
      onPress={select}
    >
      {title}
    </Button>
  );
});
interface VersionRowProps {
  controller: VisualController;
  id: string;
  revision: number;
  pending: boolean;
}
const VersionRow = memo(function VersionRow({
  controller,
  id,
  revision,
  pending,
}: VersionRowProps) {
  const select = useCallback(() => {
    void controller.selectVisual(id, revision);
  }, [controller, id, revision]);
  return (
    <Button
      variant="ghost"
      size="sm"
      disabled={pending}
      testID={`pi-visual-version-${revision}`}
      onPress={select}
    >
      Version {revision}
    </Button>
  );
});
interface DrawingVersionsProps {
  controller: VisualController;
  library: VisualLibraryState;
  current: VisualDocument;
}
function DrawingVersions({ controller, library, current }: DrawingVersionsProps) {
  const id = current.id;
  const pending = library.status === "loading";
  const history = visualHistoryLabel(current);
  const versions = useCallback(() => {
    void controller.loadVersions(id);
  }, [controller, id]);
  const latest = useCallback(() => {
    void controller.selectVisual(id);
  }, [controller, id]);
  const more = useCallback(() => {
    void controller.loadVersions(id, true);
  }, [controller, id]);
  return (
    <View style={styles.versions}>
      <View style={styles.chrome}>
        <Button
          variant="ghost"
          size="sm"
          disabled={pending}
          testID="pi-visual-versions"
          onPress={versions}
        >
          Versions
        </Button>
        <Button
          variant="ghost"
          size="sm"
          disabled={pending}
          testID="pi-visual-latest"
          onPress={latest}
        >
          Latest
        </Button>
      </View>
      {history ? (
        <Text testID="pi-visual-history-status" style={styles.metadata}>
          {history}
        </Text>
      ) : null}
      {library.versionsId === id ? (
        <ScrollView horizontal contentContainerStyle={styles.versionList}>
          {library.versions.map(({ revision }) => (
            <VersionRow
              key={revision}
              controller={controller}
              id={id}
              revision={revision}
              pending={pending}
            />
          ))}
          {library.versionsCursor !== null ? (
            <Button variant="ghost" size="sm" disabled={pending} onPress={more}>
              Load more versions
            </Button>
          ) : null}
        </ScrollView>
      ) : null}
    </View>
  );
}

export function VisualSidebar({
  controller,
  library,
  current,
  compact,
  children,
}: VisualSidebarProps) {
  const pending = library.status === "loading";
  const close = useCallback(() => {
    void controller.setLibraryVisible(false);
  }, [controller]);
  const retry = useCallback(() => {
    void controller.refreshLibrary();
  }, [controller]);
  const more = useCallback(() => {
    void controller.refreshLibrary(true);
  }, [controller]);
  return (
    <View style={[styles.root, compact ? styles.compact : styles.wide]} testID="pi-visuals-sidebar">
      <View style={styles.chrome}>
        <Text style={styles.title}>Drawings</Text>
        <Button
          variant="ghost"
          size="sm"
          testID="pi-visuals-close"
          disabled={pending}
          onPress={close}
        >
          {compact ? "Back to chat" : "Close"}
        </Button>
      </View>
      {library.error ? (
        <View style={styles.notice}>
          <Text accessibilityRole="alert" style={styles.error}>
            {library.error}
          </Text>
          <Button variant="ghost" size="sm" onPress={retry}>
            Retry library
          </Button>
        </View>
      ) : null}
      {pending ? <Text style={styles.metadata}>Loading...</Text> : null}
      <ScrollView style={styles.library} contentContainerStyle={styles.list}>
        {library.items.map((item) => (
          <DrawingRow
            key={item.id}
            controller={controller}
            id={item.id}
            title={item.title}
            pending={pending}
          />
        ))}
        {library.nextCursor ? (
          <Button variant="ghost" size="sm" disabled={pending} onPress={more}>
            Load more drawings
          </Button>
        ) : null}
        {library.items.length === 0 && !pending ? (
          <Text style={styles.metadata}>No drawings yet</Text>
        ) : null}
      </ScrollView>
      {current ? (
        <DrawingVersions controller={controller} library={library} current={current} />
      ) : null}
      <View style={styles.document}>{children}</View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  root: {
    minHeight: 0,
    backgroundColor: theme.colors.surface0,
    borderLeftWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
  },
  compact: { width: "100%", flex: 1 },
  wide: VISUAL_SIDEBAR_WIDE_LAYOUT,
  chrome: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    padding: theme.spacing[2],
    borderBottomWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
  },
  title: {
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
  },
  metadata: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
    padding: theme.spacing[2],
  },
  library: { maxHeight: 160, flexGrow: 0 },
  list: { padding: theme.spacing[2] },
  versions: { flexShrink: 0 },
  versionList: { padding: theme.spacing[2] },
  document: { flex: 1, minHeight: 280 },
  notice: { padding: theme.spacing[2], gap: theme.spacing[2] },
  error: { fontSize: theme.fontSize.sm, color: theme.colors.statusDanger },
}));
