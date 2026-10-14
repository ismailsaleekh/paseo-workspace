import "@/styles/unistyles";
import React, { useCallback, useState } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test } from "vitest";
import { page, userEvent } from "vitest/browser";
import type { DesktopHostBridge } from "@/desktop/host";
import {
  dispatchTopWebOverlayKeyDown,
  useGlobalWebOverlayLayer,
  useWebOverlayRegistration,
} from "@/lib/overlay-root";
import type {
  DesktopVisualAddress,
  DesktopVisualBridge,
  DesktopVisualMount,
  VisualRenderDocument,
} from "@getpaseo/protocol/pi-workspace/rpc-schemas";
import { VisualFrame } from "./visual-frame";
import { VisualDocument as DesktopVisualDocument } from "./document.electron";

let root: Root;
let container: HTMLDivElement;
beforeEach(async () => {
  await page.viewport(1000, 700);
  container = document.createElement("div");
  container.style.width = "320px";
  container.style.height = "240px";
  container.style.display = "flex";
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  flushSync(() => root.unmount());
  container.remove();
});

const leaveKeys = () => false;
function OtherOverlay({ active }: { active: boolean }) {
  const layer = useGlobalWebOverlayLayer("modal", active);
  const ref = useWebOverlayRegistration({ active, layer, onKeyDown: leaveKeys });
  return active ? <div ref={ref} role="dialog" tabIndex={-1} /> : null;
}

class HarnessControls {
  readonly exits: string[] = [];
  setFullscreen: (value: boolean) => void = () => {
    throw new Error("Harness is not mounted");
  };
  setOverlay: (value: boolean) => void = () => {
    throw new Error("Harness is not mounted");
  };
}
function Harness({ controls }: { controls: HarnessControls }) {
  const [fullscreen, setFullscreen] = useState(false);
  const [overlay, setOverlay] = useState(false);
  controls.setFullscreen = setFullscreen;
  controls.setOverlay = setOverlay;
  const exit = useCallback(() => {
    controls.exits.push("exit");
    setFullscreen(false);
  }, [controls]);
  return (
    <>
      <VisualFrame fullscreen={fullscreen} title="Power explorer" onExit={exit}>
        <iframe
          title="drawing"
          data-testid="drawing"
          sandbox="allow-same-origin"
          srcDoc="<p>drawing</p>"
        />
      </VisualFrame>
      <OtherOverlay active={overlay} />
    </>
  );
}

function rect(element: Element) {
  const { x, y, width, height } = element.getBoundingClientRect();
  return {
    x: Math.round(x),
    y: Math.round(y),
    width: Math.round(width),
    height: Math.round(height),
  };
}

test("full screen covers the whole window like an image viewer without remounting the drawing", async () => {
  const controls = new HarnessControls();
  const exits = controls.exits;
  flushSync(() => root.render(<Harness controls={controls} />));
  const drawing = document.querySelector('[data-testid="drawing"]');
  if (!(drawing instanceof HTMLIFrameElement)) throw new Error("Drawing frame is missing");
  await expect.poll(() => drawing.contentDocument?.body?.textContent).toBe("drawing");
  const loadedDocument = drawing.contentDocument;
  const frame = document.querySelector('[data-testid="pi-visual-frame"]');
  if (!(frame instanceof HTMLDivElement)) throw new Error("Visual frame is missing");
  expect(rect(frame).width).toBeLessThanOrEqual(320);
  await expect.element(page.getByTestId("pi-visual-fullscreen-bar")).not.toBeInTheDocument();

  flushSync(() => controls.setFullscreen(true));
  expect(frame.matches(":popover-open")).toBe(true);
  expect(rect(frame)).toEqual({ x: 0, y: 0, width: window.innerWidth, height: window.innerHeight });
  await expect.element(page.getByTestId("pi-visual-fullscreen-bar")).toBeVisible();
  await expect.element(page.getByText("Power explorer")).toBeVisible();
  expect(document.querySelector('[data-testid="drawing"]')).toBe(drawing);
  expect(drawing.contentDocument).toBe(loadedDocument);

  await userEvent.click(page.getByTestId("pi-visual-exit-fullscreen"));
  expect(exits).toEqual(["exit"]);
  expect(frame.matches(":popover-open")).toBe(false);
  expect(rect(frame).width).toBeLessThanOrEqual(320);
  expect(document.querySelector('[data-testid="drawing"]')).toBe(drawing);
  expect(drawing.contentDocument).toBe(loadedDocument);
});

test("Escape leaves full screen before app shortcuts, and another overlay ends it", async () => {
  const controls = new HarnessControls();
  const exits = controls.exits;
  const reachedApp: string[] = [];
  // The app's shortcut listener: window capture, registered at startup, overlays first.
  const appShortcut = (event: KeyboardEvent) => {
    if (dispatchTopWebOverlayKeyDown(event)) return;
    reachedApp.push(event.key);
  };
  window.addEventListener("keydown", appShortcut, true);
  try {
    flushSync(() => root.render(<Harness controls={controls} />));
    flushSync(() => controls.setFullscreen(true));
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", cancelable: true }));
    expect(exits).toEqual(["exit"]);
    expect(reachedApp).toEqual([]);

    flushSync(() => controls.setFullscreen(true));
    flushSync(() => controls.setOverlay(true));
    await expect.poll(() => exits).toEqual(["exit", "exit"]);
    const frame = document.querySelector('[data-testid="pi-visual-frame"]');
    expect(frame?.matches(":popover-open")).toBe(false);
  } finally {
    window.removeEventListener("keydown", appShortcut, true);
  }
});

function desktopDocument(): VisualRenderDocument {
  const id = crypto.randomUUID();
  return {
    binding: { id, nonce: crypto.randomUUID(), revision: 1, clientGeneration: crypto.randomUUID() },
    document: {
      id,
      title: "Native drawing",
      revision: 1,
      stateRevision: 1,
      html: "<p>Native</p>",
      snapshot: { state: null, selection: null },
    },
  };
}

class NativeViewPort implements DesktopVisualBridge {
  readonly mounts: DesktopVisualMount[] = [];
  readonly disposals: DesktopVisualAddress[] = [];
  readonly occlusion: boolean[] = [];
  private listener: ((value: unknown) => void) | null = null;
  readonly desktop: Pick<DesktopHostBridge, "visuals" | "events"> = {
    visuals: this,
    events: {
      on: (event, listener) => {
        if (event !== "visual") throw new Error("Unexpected desktop event channel");
        this.listener = listener;
        return () => {
          this.listener = null;
        };
      },
    },
  };
  async mount(input: DesktopVisualMount): Promise<void> {
    this.mounts.push(input);
  }
  async dispose(input: DesktopVisualAddress): Promise<void> {
    this.disposals.push(input);
  }
  async bounds(input: { occluded?: boolean }): Promise<void> {
    this.occlusion.push(input.occluded === true);
  }
  async command(): Promise<void> {}
  async restore(): Promise<void> {}
  async acknowledge(): Promise<void> {}
  escape(nonce: string): void {
    if (!this.listener) throw new Error("Native view events are not subscribed");
    this.listener({ type: "paseo-visual-escape", nonce });
  }
}
const ignoreDocumentMessage = () => {};
const failOnError = (error: unknown) => {
  throw error;
};

test("Escape inside the native drawing view reaches only its document, without remounting it", async () => {
  const port = new NativeViewPort();
  const current = desktopDocument();
  const escapes: string[] = [];
  const first = () => escapes.push("first");
  const second = () => escapes.push("second");
  const render = (onEscape: () => void) =>
    flushSync(() =>
      root.render(
        <VisualFrame fullscreen title="Native drawing" onExit={ignoreDocumentMessage}>
          <DesktopVisualDocument
            current={current}
            desktop={port.desktop}
            renderCommandId={null}
            command={null}
            receive={ignoreDocumentMessage}
            onEscape={onEscape}
            reportError={failOnError}
          />
        </VisualFrame>,
      ),
    );
  render(first);
  await expect.poll(() => port.mounts.length).toBe(1);
  port.escape(crypto.randomUUID());
  port.escape(current.binding.nonce);
  expect(escapes).toEqual(["first"]);
  render(second);
  port.escape(current.binding.nonce);
  expect(escapes).toEqual(["first", "second"]);
  expect(port.mounts).toHaveLength(1);
  expect(port.disposals).toEqual([]);
  // Its own full-screen frame is an overlay that contains the view, so it never hides it.
  await expect.poll(() => port.occlusion.length).toBeGreaterThan(0);
  expect(port.occlusion.every((occluded) => !occluded)).toBe(true);
});
