import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { visualDocumentHtml, type VisualDocumentProps } from "./document-bridge";

const frameStyle = {
  width: "100%",
  height: "100%",
  minHeight: 280,
  border: "none",
  backgroundColor: "white",
} as const;

export function VisualDocument({
  current,
  renderCommandId,
  command,
  receive,
  reportError,
}: VisualDocumentProps) {
  const frame = useRef<HTMLIFrameElement>(null);
  const html = useMemo(
    () => visualDocumentHtml({ current, commandId: renderCommandId, platform: "web" }),
    [current, renderCommandId],
  );
  useLayoutEffect(() => {
    function message(event: MessageEvent<unknown>): void {
      if (!frame.current || event.source !== frame.current.contentWindow) return;
      receive(event.data);
    }
    window.addEventListener("message", message);
    return () => window.removeEventListener("message", message);
  }, [receive]);
  useEffect(() => {
    if (!command) return;
    const target = frame.current?.contentWindow;
    if (!target) {
      reportError(new Error("Visual document is not mounted"));
      return;
    }
    target.postMessage({ type: "paseo-visual-command", command }, "*");
  }, [command, reportError]);
  return (
    <iframe
      ref={frame}
      data-testid="pi-workspace-document"
      title={current.document.title}
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      srcDoc={html}
      style={frameStyle}
    />
  );
}
