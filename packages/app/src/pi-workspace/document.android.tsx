import { useCallback, useEffect, useMemo, useState } from "react";
import { Text, View, type ViewStyle } from "react-native";
import { requireNativeView, requireOptionalNativeModule } from "expo";
import type { VisualError } from "@getpaseo/protocol/pi-workspace/contracts";
import { AndroidVisualAdapter, type AndroidVisualNative } from "./android-visual-host";
import { type VisualDocumentProps } from "./document-bridge";

interface NativeVisualHostProps {
  session: string;
  onHostEvent(event: { nativeEvent: unknown }): void;
  style: ViewStyle;
  testID: string;
}

// The generated document renders only in the companion visual host app (its own UID, without
// the INTERNET permission). This view embeds that app's surface; there is no in-app WebView.
const nativeModule = requireOptionalNativeModule<AndroidVisualNative>("PaseoVisualHost");
const NativeVisualHost = nativeModule
  ? requireNativeView<NativeVisualHostProps>("PaseoVisualHost")
  : null;

const surfaceStyle: ViewStyle = { flex: 1, minHeight: 280, backgroundColor: "white" };
const noticeStyle: ViewStyle = { flex: 1, minHeight: 280, padding: 12, justifyContent: "center" };

function explanation(error: VisualError): string {
  if (error.code === "RENDERER_UNAVAILABLE")
    return `Visuals on this device need the Paseo visual host app. ${error.message}`;
  if (error.code === "DOCUMENT_UNRESPONSIVE")
    return "The visual stopped responding and was closed. Ask the agent to reopen it.";
  return `The visual could not be displayed (${error.code}). ${error.message}`;
}

export function VisualDocument({
  current,
  restoration,
  renderCommandId,
  command,
  receive,
  hostEvent,
  reportError,
}: VisualDocumentProps) {
  const [failure, setFailure] = useState<VisualError | null>(null);
  const adapter = useMemo(
    () =>
      new AndroidVisualAdapter({
        current,
        renderCommandId,
        native: nativeModule,
        receive,
        ...(hostEvent ? { hostEvent } : {}),
        reportError,
        onFailure: setFailure,
      }),
    [current, renderCommandId, receive, hostEvent, reportError],
  );
  useEffect(() => {
    adapter.mount();
    return () => adapter.dispose();
  }, [adapter]);
  useEffect(() => {
    if (restoration) adapter.restore(restoration);
  }, [adapter, restoration]);
  useEffect(() => {
    if (command) adapter.command(command);
  }, [adapter, command]);
  const onHostEvent = useCallback(
    (event: { nativeEvent: unknown }) => adapter.hostEvent(event.nativeEvent),
    [adapter],
  );
  if (failure || !NativeVisualHost) {
    return (
      <View style={noticeStyle} testID="pi-workspace-document-unavailable">
        <Text accessibilityRole="alert">
          {explanation(
            failure ?? {
              code: "RENDERER_UNAVAILABLE",
              message: "This Paseo build does not include the Android visual host module",
            },
          )}
        </Text>
      </View>
    );
  }
  return (
    <NativeVisualHost
      session={adapter.session}
      onHostEvent={onHostEvent}
      style={surfaceStyle}
      testID="pi-workspace-document"
    />
  );
}
