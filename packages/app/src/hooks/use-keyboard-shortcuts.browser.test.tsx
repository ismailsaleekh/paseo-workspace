import React, { useEffect, useRef } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test } from "vitest";
import { createBrowserShortcutInputHandler } from "./browser-shortcut-input";
import { useKeyboardShortcutsStore } from "@/stores/keyboard-shortcuts-store";
import { hasActiveWebOverlay, useWebOverlayRegistration } from "@/lib/overlay-root";
import { buildEffectiveBindings, resolveKeyboardShortcut } from "@/keyboard/keyboard-shortcuts";
import type { BrowserShortcutInput } from "@/desktop/browser/shortcuts";

class NativeDeliveryPort {
  visible = true;
  private listener: ((payload: unknown) => void) | null = null;
  readonly actions: string[] = [];
  readonly bindings = buildEffectiveBindings({});
  attach(listener: (payload: unknown) => void): () => void {
    this.listener = listener;
    return () => {
      this.listener = null;
    };
  }
  queue(payload: unknown): () => void {
    const listener = this.listener;
    if (!listener) throw new Error("Actual production IPC consumer is not mounted");
    return () => listener(payload);
  }
  perform = (input: BrowserShortcutInput): void => {
    const result = resolveKeyboardShortcut({
      event: input,
      context: {
        isMac: true,
        isDesktop: true,
        focusScope: "browser",
        commandCenterOpen: useKeyboardShortcutsStore.getState().commandCenterOpen,
      },
      chordState: { candidateIndices: [], step: 0, timeoutId: null },
      onChordReset: () => {},
      bindings: this.bindings,
    });
    if (!result.match) return;
    this.actions.push(result.match.action);
    if (result.match.action === "command-center.toggle")
      useKeyboardShortcutsStore
        .getState()
        .setCommandCenterOpen(!useKeyboardShortcutsStore.getState().commandCenterOpen);
  };
}
function Consumer({ port }: { port: NativeDeliveryPort }) {
  const active = useRef(false);
  useEffect(() => {
    active.current = true;
    const dispose = port.attach(
      createBrowserShortcutInputHandler({
        active: () => active.current,
        visible: () => port.visible,
        perform: port.perform,
      }),
    );
    return () => {
      active.current = false;
      dispose();
    };
  }, [port]);
  return <div data-testid="native-key-consumer" />;
}
const leaveKeyToOverlay = () => false;
function Overlay({ active }: { active: boolean }) {
  const ref = useWebOverlayRegistration({ active, layer: 20, onKeyDown: leaveKeyToOverlay });
  return active ? (
    <div ref={ref} role="dialog" tabIndex={-1}>
      <input aria-label="Overlay field" />
    </div>
  ) : null;
}
const commandKey = {
  browserId: "paseo-visual:owned-nonce",
  key: "k",
  code: "KeyK",
  alt: false,
  control: false,
  meta: true,
  shift: false,
  repeat: false,
};
const otherPublishedKey = { ...commandKey, key: "b", code: "KeyB" };
let root: Root;
let container: HTMLDivElement;
function render(port: NativeDeliveryPort, overlay = false, mounted = true) {
  flushSync(() =>
    root.render(
      <>
        {mounted ? <Consumer port={port} /> : null}
        <Overlay active={overlay} />
      </>,
    ),
  );
}
beforeEach(() => {
  useKeyboardShortcutsStore.getState().setCommandCenterOpen(false);
  useKeyboardShortcutsStore.getState().setCapturingShortcut(false);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  flushSync(() => root.unmount());
  container.remove();
  useKeyboardShortcutsStore.getState().setCapturingShortcut(false);
  useKeyboardShortcutsStore.getState().setCommandCenterOpen(false);
});

test("the actual production IPC callback follows published bindings on an active visible unoccluded host", () => {
  const port = new NativeDeliveryPort();
  render(port);
  port.queue(commandKey)();
  expect(port.actions).toEqual(["command-center.toggle"]);
  expect(useKeyboardShortcutsStore.getState().commandCenterOpen).toBe(true);
  useKeyboardShortcutsStore.getState().setCommandCenterOpen(false);
  port.queue(otherPublishedKey)();
  expect(port.actions).toEqual(["command-center.toggle", "sidebar.toggle.left"]);
});

test("a trusted native input queued before a real central overlay opens cannot dispatch underneath it", () => {
  const port = new NativeDeliveryPort();
  render(port);
  const queued = port.queue(commandKey);
  render(port, true);
  expect(hasActiveWebOverlay()).toBe(true);
  queued();
  expect(port.actions).toEqual([]);
  expect(useKeyboardShortcutsStore.getState().commandCenterOpen).toBe(false);
  render(port, false);
  expect(hasActiveWebOverlay()).toBe(false);
  port.queue(commandKey)();
  expect(port.actions).toEqual(["command-center.toggle"]);
});

test("current capture mode, host visibility and mounted lifetime are checked at delivery, not enqueue time", () => {
  const port = new NativeDeliveryPort();
  render(port);
  const captured = port.queue(commandKey);
  useKeyboardShortcutsStore.getState().setCapturingShortcut(true);
  captured();
  expect(port.actions).toEqual([]);
  useKeyboardShortcutsStore.getState().setCapturingShortcut(false);
  const hidden = port.queue(commandKey);
  // Controlled host visibility port; production reads document.visibilityState at this same boundary.
  port.visible = false;
  hidden();
  expect(port.actions).toEqual([]);
  port.visible = true;
  const obsolete = port.queue(commandKey);
  render(port, false, false);
  obsolete();
  expect(port.actions).toEqual([]);
  expect(useKeyboardShortcutsStore.getState().commandCenterOpen).toBe(false);
});

test("malformed or non-binding input is refused without privileged action dispatch", () => {
  const port = new NativeDeliveryPort();
  render(port);
  port.queue({ ...commandKey, meta: "true" })();
  port.queue({ ...commandKey, browserId: "" })();
  port.queue({ ...commandKey, meta: false, key: "q", code: "KeyQ" })();
  expect(port.actions).toEqual([]);
});
