import { useEffect, useRef, useState } from "react";
import { getDesktopHost, type DesktopHostBridge } from "@/desktop/host";
import { hasActiveWebOverlay, subscribeWebOverlayActivity } from "@/lib/overlay-root";
import type {
  DesktopVisualBridge,
  DesktopVisualBoundsUpdate,
} from "@getpaseo/protocol/pi-workspace/rpc-schemas";
import { DesktopVisualEventSchema } from "@getpaseo/protocol/pi-workspace/rpc-schemas";
import {
  assertVisualJsonBound,
  VISUAL_FRAME_BYTES,
} from "@getpaseo/protocol/pi-workspace/contracts";
import { type VisualDocumentProps } from "./document-bridge";

const style = { width: "100%", height: "100%", minHeight: 280, backgroundColor: "white" } as const;
function bounds(element: HTMLDivElement): DesktopVisualBoundsUpdate["bounds"] {
  const rect = element.getBoundingClientRect();
  return {
    x: Math.round(rect.x),
    y: Math.round(rect.y),
    width: Math.max(0, Math.round(rect.width)),
    height: Math.max(0, Math.round(rect.height)),
  };
}

interface DesktopVisualDocumentProps extends VisualDocumentProps {
  /** Owning host's existing bridge port; defaults to the installed desktop bridge. */
  desktop?: Pick<DesktopHostBridge, "visuals" | "events"> | null;
}

export function VisualDocument({
  current,
  restoration,
  acknowledgement,
  renderCommandId,
  command,
  receive,
  hostEvent,
  reportError,
  desktop = getDesktopHost(),
}: DesktopVisualDocumentProps) {
  const surface = useRef<HTMLDivElement>(null);
  const [bridge, setBridge] = useState<DesktopVisualBridge | null>(null);
  const nonce = current.binding.nonce;
  useEffect(() => {
    const element = surface.current;
    if (!element || !desktop?.visuals || !desktop.events?.on) {
      reportError(new Error("Update the desktop app to display isolated Pi visuals"));
      return;
    }
    const visuals = desktop.visuals;
    const subscribe = desktop.events.on;
    const target = element;
    let stopped = false;
    let mounted = false;
    let mountRequested = false;
    let unsubscribe: (() => void) | null = null;
    const failure = (error: unknown) => {
      if (!stopped) reportError(error);
    };
    const resize = () => {
      if (stopped || !mounted) return;
      void visuals
        .bounds({ nonce, bounds: bounds(target), occluded: hasActiveWebOverlay() })
        .catch(failure);
    };
    const stopOverlay = subscribeWebOverlayActivity(resize);
    const observer = new ResizeObserver(resize);
    observer.observe(element);
    window.addEventListener("scroll", resize, true);
    window.addEventListener("resize", resize);
    async function mount(): Promise<void> {
      const stopEvents = await subscribe("visual", (value) => {
        if (stopped) return;
        try {
          assertVisualJsonBound(value, VISUAL_FRAME_BYTES);
          const message = DesktopVisualEventSchema.parse(value);
          if (message.type === "paseo-visual") {
            if (message.receipt.binding.nonce === nonce) receive(message);
          } else if (message.event.binding.nonce === nonce) {
            if (!hostEvent) throw new Error("Desktop visual host event channel is unavailable");
            hostEvent(message.event);
          }
        } catch (error) {
          failure(error);
        }
      });
      unsubscribe = stopEvents;
      if (stopped) {
        stopEvents();
        return;
      }
      mountRequested = true;
      await visuals.mount({
        current,
        commandId: renderCommandId,
        bounds: bounds(target),
        occluded: hasActiveWebOverlay(),
      });
      // Cleanup already cancelled/disposed this invocation before any replacement effect mounted.
      // An old successful reply must not issue another same-nonce disposal against that replacement.
      if (stopped) return;
      mounted = true;
      resize();
      setBridge(visuals);
    }
    void mount().catch(failure);
    return () => {
      stopped = true;
      stopOverlay();
      observer.disconnect();
      window.removeEventListener("scroll", resize, true);
      window.removeEventListener("resize", resize);
      if (unsubscribe) unsubscribe();
      if (mountRequested) void visuals.dispose({ nonce }).catch(reportError);
    };
  }, [current, renderCommandId, nonce, receive, hostEvent, reportError, desktop]);
  useEffect(() => {
    if (!bridge || !restoration) return;
    void bridge
      .restore({
        binding: restoration.binding,
        snapshot: restoration.document.snapshot,
        stateRevision: restoration.document.stateRevision,
      })
      .catch(reportError);
  }, [bridge, restoration, reportError]);
  useEffect(() => {
    // The guest waits for this answer before it publishes its next change or runs a command.
    if (!bridge || !acknowledgement || acknowledgement.binding.nonce !== nonce) return;
    void bridge
      .acknowledge({
        binding: acknowledgement.binding,
        sequence: acknowledgement.sequence,
        stateRevision: acknowledgement.stateRevision,
      })
      .catch(reportError);
  }, [bridge, nonce, acknowledgement, reportError]);
  useEffect(() => {
    if (!bridge || !command) return;
    void bridge.command({ nonce, command }).catch(reportError);
  }, [bridge, nonce, command, reportError]);
  return (
    <div
      ref={surface}
      data-testid="pi-workspace-document"
      aria-label={current.document.title}
      style={style}
    />
  );
}
