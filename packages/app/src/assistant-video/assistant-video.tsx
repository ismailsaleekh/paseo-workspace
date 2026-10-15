import { useCallback, useMemo, useState, useSyncExternalStore } from "react";
import { Pressable, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { Play } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { getFileNameFromPath } from "@/attachments/utils";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { resolveAssistantImageSource } from "@/utils/assistant-image-source";
import { assistantVideoType } from "./source";
import { VideoTransfers, type VideoTransferState } from "./transfers";
import { createVideoFile, releaseVideoUri } from "./video-file";
import { VideoPlayer } from "./video-player";

const transfers = new VideoTransfers(releaseVideoUri);

export type AssistantVideoClient = Pick<DaemonClient, "streamFile">;

export interface AssistantMarkdownVideoProps {
  /** The embedded path or URL; its extension makes it a video (see `assistantVideoType`). */
  source: string;
  occurrenceKey: string;
  alt?: string;
  hasLeadingContent: boolean;
  client?: AssistantVideoClient | null;
  workspaceRoot?: string;
  serverId?: string;
}

type VideoState =
  | { kind: "player"; uri: string; autoPlay: boolean }
  | { kind: "unavailable" }
  | { kind: "card"; transfer: VideoTransferState | null };

function useAssistantVideo({
  source,
  occurrenceKey,
  client,
  workspaceRoot,
  serverId,
}: AssistantMarkdownVideoProps): { video: VideoState; load(): void; path: string | null } {
  const type = assistantVideoType(source);
  const resolution = useMemo(
    () => resolveAssistantImageSource({ source, workspaceRoot }),
    [source, workspaceRoot],
  );
  const key = `${serverId ?? ""}:${occurrenceKey}`;
  const subscribe = useCallback(
    (listener: () => void) => transfers.subscribe(key, listener),
    [key],
  );
  const snapshot = useCallback(() => transfers.get(key), [key]);
  const transfer = useSyncExternalStore(subscribe, snapshot, snapshot);
  // Only the row the user tapped starts playing by itself, not one scrolled back into view.
  const [requested, setRequested] = useState(false);
  const file = resolution?.kind === "file_rpc" ? resolution : null;
  const load = useCallback(() => {
    if (!file || !client || !type) return;
    setRequested(true);
    transfers.load(key, {
      stream: (sink) => client.streamFile(file.cwd, file.path, sink),
      createFile: () => createVideoFile(type),
    });
  }, [client, file, key, type]);

  let video: VideoState = { kind: "card", transfer };
  if (resolution?.kind === "direct") {
    video = { kind: "player", uri: resolution.uri, autoPlay: false };
  } else if (transfer?.status === "ready") {
    video = { kind: "player", uri: transfer.uri, autoPlay: requested };
  } else if (!file || !client || !type) {
    video = { kind: "unavailable" };
  }
  return { video, load, path: file?.path ?? null };
}

/**
 * A video the agent embedded in its reply. A tap brings the original file from the host, as it is,
 * into this device's temporary storage and plays it; URLs play directly.
 */
export function AssistantMarkdownVideo(props: AssistantMarkdownVideoProps) {
  const { video, load, path } = useAssistantVideo(props);
  const title = props.alt?.trim() || getFileNameFromPath(path ?? props.source) || props.source;
  return (
    <View style={props.hasLeadingContent ? styles.frameAfterContent : styles.frame}>
      {video.kind === "player" ? (
        <VideoPlayer uri={video.uri} autoPlay={video.autoPlay} accessibilityLabel={title} />
      ) : (
        <VideoCard title={title} video={video} onPress={load} />
      )}
    </View>
  );
}

function VideoCard({
  title,
  video,
  onPress,
}: {
  title: string;
  video: Exclude<VideoState, { kind: "player" }>;
  onPress(): void;
}) {
  const { t } = useTranslation();
  if (video.kind === "unavailable") {
    return (
      <View style={styles.card}>
        <Text style={styles.title}>{title}</Text>
        <Text style={styles.detail}>{t("message.attachments.videoLoadFailed")}</Text>
      </View>
    );
  }
  const { transfer } = video;
  let detail = t("message.attachments.playVideo");
  if (transfer?.status === "loading") {
    detail = t("message.attachments.loadingVideo", { percent: transfer.percent ?? 0 });
  } else if (transfer?.status === "failed") {
    detail = t("message.attachments.videoLoadFailedRetry", { reason: transfer.message });
  }
  const loading = transfer?.status === "loading";
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={t("message.attachments.playVideoTitled", { title })}
      disabled={loading}
      onPress={onPress}
      style={styles.card}
      testID="assistant-video"
    >
      {loading ? <LoadingSpinner color="#fff" /> : <Play size={28} color="#fff" fill="#fff" />}
      <Text style={styles.title} numberOfLines={2}>
        {title}
      </Text>
      <Text style={styles.detail} testID="assistant-video-status">
        {detail}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create((theme) => ({
  frame: { width: "100%" },
  frameAfterContent: { width: "100%", marginTop: theme.spacing[4] },
  card: {
    width: "100%",
    aspectRatio: 16 / 9,
    maxHeight: 320,
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[4],
    backgroundColor: "#111",
    borderRadius: theme.borderRadius.lg,
  },
  title: {
    color: "#fff",
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
    textAlign: "center",
  },
  detail: {
    color: "#c8c8c8",
    fontSize: theme.fontSize.sm,
    textAlign: "center",
  },
}));
