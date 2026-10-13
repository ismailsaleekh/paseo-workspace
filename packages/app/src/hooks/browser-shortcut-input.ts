import { useKeyboardShortcutsStore } from "@/stores/keyboard-shortcuts-store";
import { hasActiveWebOverlay } from "@/lib/overlay-root";
import { parseBrowserShortcutInput, type BrowserShortcutInput } from "@/desktop/browser/shortcuts";

export interface BrowserShortcutInputHost {
  active(): boolean;
  visible(): boolean;
  perform(input: BrowserShortcutInput): void;
}

/** The actual IPC consumer rechecks host policy when a previously queued trusted key is delivered. */
export function createBrowserShortcutInputHandler(
  host: BrowserShortcutInputHost,
): (payload: unknown) => void {
  return (payload) => {
    if (!host.active() || !host.visible()) return;
    if (useKeyboardShortcutsStore.getState().capturingShortcut || hasActiveWebOverlay()) return;
    const input = parseBrowserShortcutInput(payload);
    if (!input) return;
    host.perform(input);
  };
}
