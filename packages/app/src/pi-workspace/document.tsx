import { useCallback, useEffect, useMemo, useRef } from "react";
import { WebView, type WebViewMessageEvent } from "react-native-webview";
import { htmlPreviewNavigationKind } from "../file-pane/html-preview-navigation";
import {
  visualAcknowledgementMessage,
  visualDocumentHtml,
  visualStateMessage,
  type VisualDocumentProps,
} from "./document-bridge";

const whitelist = ["*"];
const style = { flex: 1, minHeight: 280, backgroundColor: "white" } as const;

export function VisualDocument({
  current,
  restoration,
  acknowledgement,
  renderCommandId,
  command,
  receive,
  reportError,
}: VisualDocumentProps) {
  const webview = useRef<WebView>(null);
  const loaded = useRef<string | null>(null);
  const html = useMemo(
    () => visualDocumentHtml({ current, commandId: renderCommandId, platform: "native" }),
    [current, renderCommandId],
  );
  const source = useMemo(() => ({ html, baseUrl: "about:blank" }), [html]);
  const allowNavigation = useCallback(
    ({ url }: { url: string }) => {
      const kind = htmlPreviewNavigationKind(url);
      if (kind === "fragment") return true;
      if (kind === "blocked" || loaded.current === html) return false;
      loaded.current = html;
      return true;
    },
    [html],
  );
  const message = useCallback(
    (event: WebViewMessageEvent) => {
      try {
        const value: unknown = JSON.parse(event.nativeEvent.data);
        receive(value);
      } catch (error) {
        reportError(error);
      }
    },
    [receive, reportError],
  );
  useEffect(() => {
    if (!restoration) return;
    if (!webview.current) {
      reportError(new Error("Visual document is not mounted for restoration"));
      return;
    }
    const data = JSON.stringify(visualStateMessage(restoration)).replace(/</g, "\\u003c");
    webview.current.injectJavaScript(
      `window.dispatchEvent(new MessageEvent('message',{data:${data}}));true;`,
    );
  }, [restoration, reportError]);
  useEffect(() => {
    if (!acknowledgement) return;
    if (!webview.current) {
      reportError(new Error("Visual document is not mounted for acknowledgement"));
      return;
    }
    const data = JSON.stringify(visualAcknowledgementMessage(acknowledgement)).replace(
      /</g,
      "\\u003c",
    );
    webview.current.injectJavaScript(
      `window.dispatchEvent(new MessageEvent('message',{data:${data}}));true;`,
    );
  }, [acknowledgement, reportError]);
  useEffect(() => {
    if (!command) return;
    if (!webview.current) {
      reportError(new Error("Visual document is not mounted"));
      return;
    }
    const data = JSON.stringify({ type: "paseo-visual-command", command }).replace(/</g, "\\u003c");
    webview.current.injectJavaScript(
      `window.dispatchEvent(new MessageEvent('message',{data:${data}}));true;`,
    );
  }, [command, reportError]);
  return (
    <WebView
      ref={webview}
      testID="pi-workspace-document"
      style={style}
      source={source}
      originWhitelist={whitelist}
      onShouldStartLoadWithRequest={allowNavigation}
      onMessage={message}
      setSupportMultipleWindows={false}
      javaScriptCanOpenWindowsAutomatically={false}
      domStorageEnabled={false}
      thirdPartyCookiesEnabled={false}
      cacheEnabled={false}
      incognito
    />
  );
}
