import { describe, expect, test } from "vitest";
import { PaseoBrowserWebviewRegistry } from "../browser-webviews/registry.js";
import { BrowserKeyboard } from "./index.js";

interface SentMessage {
  channel: string;
  payload: unknown;
}

class FakeBrowserContents {
  public readonly mainFrame = {
    framesInSubtree: [
      {
        detached: false,
        send: (channel: string, payload: unknown) => this.send(channel, payload),
      },
    ],
  };
  public readonly ignoredMenuShortcuts: boolean[] = [];
  public readonly reloads: string[] = [];
  public readonly sent: SentMessage[] = [];
  private destroyed = false;
  public focused = true;
  private readonly destroyedListeners: Array<() => void> = [];
  private readonly domReadyListeners: Array<() => void> = [];
  private finishLoadListener: (() => void) | null = null;
  private readonly inputListeners: Array<
    (event: { preventDefault(): void }, input: Electron.Input) => void
  > = [];

  public constructor(private readonly webContentsId: number) {}

  public get id(): number {
    if (this.destroyed) {
      throw new TypeError("Object has been destroyed");
    }
    return this.webContentsId;
  }

  public isDestroyed(): boolean {
    return this.destroyed;
  }

  public isFocused(): boolean {
    return this.focused && !this.destroyed;
  }

  public isLoadingMainFrame(): boolean {
    return false;
  }

  public once(event: "destroyed", listener: () => void): void {
    expect(event).toBe("destroyed");
    this.destroyedListeners.push(listener);
  }

  public on(event: "did-finish-load", listener: () => void): void;
  public on(event: "dom-ready", listener: () => void): void;
  public on(
    event: "before-input-event",
    listener: (event: { preventDefault(): void }, input: Electron.Input) => void,
  ): void;
  public on(
    event: "did-finish-load" | "dom-ready" | "before-input-event",
    listener: (() => void) | ((event: { preventDefault(): void }, input: Electron.Input) => void),
  ): void {
    if (event === "did-finish-load") {
      this.finishLoadListener = listener as () => void;
      return;
    }
    if (event === "dom-ready") {
      this.domReadyListeners.push(listener as () => void);
      return;
    }
    this.inputListeners.push(
      listener as (event: { preventDefault(): void }, input: Electron.Input) => void,
    );
  }

  public send(channel: string, payload: unknown): void {
    this.sent.push({ channel, payload });
  }

  public setIgnoreMenuShortcuts(ignore: boolean): void {
    this.ignoredMenuShortcuts.push(ignore);
  }

  public stop(): void {
    this.reloads.push("stop");
  }

  public reload(): void {
    this.reloads.push("reload");
  }

  public reloadIgnoringCache(): void {
    this.reloads.push("force-reload");
  }

  public destroy(): void {
    this.destroyed = true;
    for (const listener of this.destroyedListeners) {
      listener();
    }
  }

  public finishLoad(): void {
    this.finishLoadListener?.();
  }

  public domReady(): void {
    for (const listener of this.domReadyListeners) {
      listener();
    }
  }

  public input(input: Electron.Input): boolean {
    let wasPrevented = false;
    for (const listener of this.inputListeners) {
      listener(
        {
          preventDefault: () => {
            wasPrevented = true;
          },
        },
        input,
      );
    }
    return wasPrevented;
  }
}

function electronInput(input: Partial<Electron.Input>): Electron.Input {
  return {
    alt: false,
    code: "",
    control: false,
    isAutoRepeat: false,
    isComposing: false,
    key: "",
    location: 0,
    meta: false,
    modifiers: [],
    shift: false,
    type: "keyDown",
    ...input,
  };
}

function createBrowserKeyboard() {
  const registry = new PaseoBrowserWebviewRegistry();
  const keyboard = new BrowserKeyboard(registry);

  function attach(input: {
    browserId: string;
    contents: FakeBrowserContents;
    hostContents: FakeBrowserContents;
  }): void {
    const webContentsId = input.contents.id;
    registry.registerWebContents({
      browserId: input.browserId,
      hostWebContentsId: input.hostContents.id,
      webContentsId,
    });
    input.contents.once("destroyed", () => registry.unregisterWebContents(webContentsId));
    keyboard.attach(input);
  }

  return { attach, keyboard };
}

describe("BrowserKeyboard", () => {
  test("main-owned native input reuses policy without creating a browser target or trusting guest IPC", () => {
    const registry = new PaseoBrowserWebviewRegistry();
    const keyboard = new BrowserKeyboard(registry);
    const visual = new FakeBrowserContents(201);
    const host = new FakeBrowserContents(202);
    const sourceId = "paseo-visual:document-nonce";
    const prefix = {
      alt: false,
      code: "KeyJ",
      control: true,
      key: "j",
      meta: false,
      repeat: false as const,
      shift: false,
    };
    keyboard.publish(host.id, { menuPrefixes: [prefix], prefixes: [prefix] });
    const forwarded = {
      browserId: sourceId,
      alt: false,
      code: "KeyJ",
      control: true,
      key: "j",
      meta: false,
      repeat: false,
      shift: false,
    };
    keyboard.forwardShortcutInput(visual, forwarded);
    expect(host.sent).toEqual([]);
    expect(visual.sent).toEqual([]);
    let prevented = 0;
    expect(
      keyboard.handleTrustedNativeInput({
        contents: visual,
        hostContents: host,
        sourceId,
        event: {
          preventDefault: () => {
            prevented++;
          },
        },
        input: electronInput({ control: true, code: "KeyJ", key: "j" }),
      }),
    ).toBe(true);
    expect(prevented).toBe(1);
    expect(host.sent).toEqual([
      { channel: "paseo:event:browser-shortcut-input", payload: forwarded },
    ]);
    expect(visual.ignoredMenuShortcuts).toEqual([true]);
    expect(registry.getRegistrationForWebContents(visual.id)).toBeNull();
    expect(visual.sent).toEqual([]);
  });

  test("native forwarding follows rebinding and chord policy while preserving Enter, IME, repeat and editable exclusions", () => {
    const keyboard = new BrowserKeyboard(new PaseoBrowserWebviewRegistry());
    const visual = new FakeBrowserContents(211);
    const host = new FakeBrowserContents(212);
    const sourceId = "paseo-visual:isolated";
    let prevented = 0;
    const dispatch = (input: Partial<Electron.Input>) =>
      keyboard.handleTrustedNativeInput({
        contents: visual,
        hostContents: host,
        sourceId,
        event: {
          preventDefault: () => {
            prevented++;
          },
        },
        input: electronInput(input),
      });
    const idle = {
      alt: false,
      code: "KeyJ",
      control: true,
      key: "j",
      meta: false,
      repeat: false as const,
      shift: false,
    };
    const next = { ...idle, code: "F11", key: "F11" };
    keyboard.publish(host.id, { menuPrefixes: [idle], prefixes: [next] });
    expect(dispatch({ control: true, code: "KeyJ", key: "j" })).toBe(false);
    expect(visual.ignoredMenuShortcuts).toEqual([true]);
    expect(dispatch({ control: true, code: "F11", key: "F11" })).toBe(true);
    expect(host.sent).toHaveLength(1);
    const refusedInputs: Partial<Electron.Input>[] = [
      { control: true, code: "F11", key: "F11", isComposing: true },
      { control: true, code: "F11", key: "Process" },
      { control: true, code: "F11", key: "F11", type: "keyUp" },
      { control: true, code: "F11", key: "F11", isAutoRepeat: true },
      { code: "Enter", key: "Enter" },
    ];
    for (const input of refusedInputs) expect(dispatch(input)).toBe(false);
    keyboard.publish(host.id, { menuPrefixes: [next], prefixes: [{ ...next, editable: false }] });
    expect(dispatch({ control: true, code: "F11", key: "F11" })).toBe(false);
    keyboard.publish(host.id, { menuPrefixes: [], prefixes: [] });
    expect(dispatch({ control: true, code: "F11", key: "F11" })).toBe(false);
    expect(prevented).toBe(1);
    expect(host.sent).toHaveLength(1);
  });

  test("native input cannot cross an unfocused, destroyed or different host policy boundary", () => {
    const keyboard = new BrowserKeyboard(new PaseoBrowserWebviewRegistry());
    const visual = new FakeBrowserContents(221);
    const host = new FakeBrowserContents(222);
    const otherHost = new FakeBrowserContents(223);
    const prefix = { alt: false, code: "KeyJ", control: true, meta: false, shift: false };
    keyboard.publish(host.id, { menuPrefixes: [prefix], prefixes: [prefix] });
    const input = electronInput({ control: true, code: "KeyJ", key: "j" });
    const event = {
      preventDefault: () => {
        throw new Error("Refused input must not be consumed");
      },
    };
    expect(
      keyboard.handleTrustedNativeInput({
        contents: visual,
        hostContents: otherHost,
        sourceId: "paseo-visual:owned",
        event,
        input,
      }),
    ).toBe(false);
    visual.focused = false;
    expect(
      keyboard.handleTrustedNativeInput({
        contents: visual,
        hostContents: host,
        sourceId: "paseo-visual:owned",
        event,
        input,
      }),
    ).toBe(false);
    visual.focused = true;
    keyboard.detachHost(host.id);
    expect(
      keyboard.handleTrustedNativeInput({
        contents: visual,
        hostContents: host,
        sourceId: "paseo-visual:owned",
        event,
        input,
      }),
    ).toBe(false);
    host.destroy();
    expect(
      keyboard.handleTrustedNativeInput({
        contents: visual,
        hostContents: host,
        sourceId: "paseo-visual:owned",
        event,
        input,
      }),
    ).toBe(false);
    visual.destroy();
    expect(
      keyboard.handleTrustedNativeInput({
        contents: visual,
        hostContents: otherHost,
        sourceId: "paseo-visual:owned",
        event,
        input,
      }),
    ).toBe(false);
    expect(host.sent).toEqual([]);
    expect(otherHost.sent).toEqual([]);
  });

  test("native policy consumption does not change registered browser forwarding or page first refusal", () => {
    const { attach, keyboard } = createBrowserKeyboard();
    const browser = new FakeBrowserContents(231);
    const visual = new FakeBrowserContents(232);
    const host = new FakeBrowserContents(233);
    const prefix = { alt: false, code: "KeyJ", control: true, key: "j", meta: false, shift: false };
    keyboard.publish(host.id, { menuPrefixes: [prefix], prefixes: [prefix] });
    attach({ browserId: "real-browser", contents: browser, hostContents: host });
    const input = electronInput({ control: true, code: "KeyJ", key: "j" });
    expect(browser.input(input)).toBe(false);
    expect(
      keyboard.handleTrustedNativeInput({
        contents: visual,
        hostContents: host,
        sourceId: "paseo-visual:owned",
        event: { preventDefault: () => {} },
        input,
      }),
    ).toBe(true);
    keyboard.forwardShortcutInput(browser, { ...prefix, browserId: "real-browser", repeat: false });
    expect(host.sent.map((message) => message.payload)).toEqual([
      { ...prefix, browserId: "paseo-visual:owned", repeat: false },
      { ...prefix, browserId: "real-browser", repeat: false },
    ]);
    expect(browser.ignoredMenuShortcuts).toEqual([true]);
    expect(browser.sent).toEqual([
      {
        channel: "paseo:browser-keyboard-policy",
        payload: { browserId: "real-browser", menuPrefixes: [prefix], prefixes: [prefix] },
      },
    ]);
  });

  test("forwards a validated guest shortcut to its host", () => {
    const { attach, keyboard } = createBrowserKeyboard();
    const guest = new FakeBrowserContents(51);
    const host = new FakeBrowserContents(52);
    attach({ browserId: "browser-a", contents: guest, hostContents: host });

    keyboard.forwardShortcutInput(guest, {
      alt: false,
      browserId: "browser-a",
      code: "KeyB",
      control: true,
      key: "b",
      meta: false,
      repeat: false,
      shift: false,
    });

    expect(host.sent).toEqual([
      {
        channel: "paseo:event:browser-shortcut-input",
        payload: {
          alt: false,
          browserId: "browser-a",
          code: "KeyB",
          control: true,
          key: "b",
          meta: false,
          repeat: false,
          shift: false,
        },
      },
    ]);
  });

  test("handles a reserved shortcut once when the same guest attaches again", () => {
    const { attach } = createBrowserKeyboard();
    const guest = new FakeBrowserContents(53);
    const host = new FakeBrowserContents(54);
    attach({ browserId: "browser-a", contents: guest, hostContents: host });
    attach({ browserId: "browser-a", contents: guest, hostContents: host });
    const command = process.platform === "darwin" ? { meta: true } : { control: true };

    const wasPrevented = guest.input(electronInput({ ...command, code: "KeyR", key: "r" }));

    expect(wasPrevented).toBe(true);
    expect(guest.reloads).toEqual(["reload"]);
  });

  test("republishes the latest shortcut policy when the next guest document is ready", () => {
    const { attach, keyboard } = createBrowserKeyboard();
    const guest = new FakeBrowserContents(61);
    const host = new FakeBrowserContents(62);
    const initialPolicy = {
      menuPrefixes: [
        {
          alt: false,
          code: "KeyB",
          control: true,
          meta: false,
          repeat: false as const,
          shift: false,
        },
      ],
      prefixes: [
        {
          alt: false,
          code: "KeyB",
          control: true,
          meta: false,
          repeat: false as const,
          shift: false,
        },
      ],
    };
    const latestPolicy = { menuPrefixes: [], prefixes: [] };
    keyboard.publish(host.id, initialPolicy);
    attach({ browserId: "browser-a", contents: guest, hostContents: host });
    keyboard.publish(host.id, latestPolicy);

    guest.domReady();

    expect(guest.sent).toEqual([
      {
        channel: "paseo:browser-keyboard-policy",
        payload: { ...initialPolicy, browserId: "browser-a" },
      },
      {
        channel: "paseo:browser-keyboard-policy",
        payload: { ...latestPolicy, browserId: "browser-a" },
      },
      {
        channel: "paseo:browser-keyboard-policy",
        payload: { ...latestPolicy, browserId: "browser-a" },
      },
    ]);

    guest.finishLoad();
    expect(guest.sent).toHaveLength(3);
  });

  test("ignores guest lifecycle events after the host is destroyed", () => {
    const { attach, keyboard } = createBrowserKeyboard();
    const guest = new FakeBrowserContents(71);
    const host = new FakeBrowserContents(72);
    attach({ browserId: "browser-a", contents: guest, hostContents: host });
    keyboard.publish(host.id, { menuPrefixes: [], prefixes: [] });

    host.destroy();
    guest.domReady();

    expect(guest.sent).toEqual([
      {
        channel: "paseo:browser-keyboard-policy",
        payload: { browserId: "browser-a", menuPrefixes: [], prefixes: [] },
      },
    ]);
  });

  test("owns browser chrome shortcuts and leaves customizable shortcuts to policy", () => {
    const { attach } = createBrowserKeyboard();
    const guest = new FakeBrowserContents(81);
    const host = new FakeBrowserContents(82);
    attach({ browserId: "browser-a", contents: guest, hostContents: host });
    const command = process.platform === "darwin" ? { meta: true } : { control: true };

    const reservedWasPrevented = guest.input(electronInput({ ...command, code: "KeyL", key: "l" }));
    const customizableWasPrevented = guest.input(
      electronInput({ ...command, code: "KeyT", key: "t" }),
    );
    const enterWasPrevented = guest.input(electronInput({ code: "Enter", key: "Enter" }));

    expect(reservedWasPrevented).toBe(true);
    expect(customizableWasPrevented).toBe(false);
    expect(enterWasPrevented).toBe(false);
    expect(guest.ignoredMenuShortcuts).toEqual([false, false, true]);
    expect(host.sent).toEqual([
      {
        channel: "paseo:event:browser-shortcut",
        payload: { action: "focus-url", browserId: "browser-a" },
      },
    ]);
  });

  test("keeps policy-owned shortcuts out of the application menu without preempting the page", () => {
    const { attach, keyboard } = createBrowserKeyboard();
    const guest = new FakeBrowserContents(91);
    const host = new FakeBrowserContents(92);
    keyboard.publish(host.id, {
      menuPrefixes: [
        { alt: false, code: "KeyW", control: true, meta: false, repeat: false, shift: false },
      ],
      prefixes: [
        { alt: false, code: "KeyW", control: true, meta: false, repeat: false, shift: false },
      ],
    });
    attach({ browserId: "browser-a", contents: guest, hostContents: host });

    const wasPrevented = guest.input(electronInput({ code: "KeyW", control: true, key: "w" }));

    expect(wasPrevented).toBe(false);
    expect(guest.ignoredMenuShortcuts).toEqual([true]);
  });

  test("keeps idle policy shortcuts out of the application menu while a chord is pending", () => {
    const { attach, keyboard } = createBrowserKeyboard();
    const guest = new FakeBrowserContents(101);
    const host = new FakeBrowserContents(102);
    keyboard.publish(host.id, {
      menuPrefixes: [
        { alt: false, code: "KeyW", control: true, meta: false, repeat: false, shift: false },
      ],
      prefixes: [
        { alt: false, code: "F11", control: true, meta: false, repeat: false, shift: false },
      ],
    });
    attach({ browserId: "browser-a", contents: guest, hostContents: host });

    const wasPrevented = guest.input(electronInput({ code: "KeyW", control: true, key: "w" }));

    expect(wasPrevented).toBe(false);
    expect(guest.ignoredMenuShortcuts).toEqual([true]);
  });
});
