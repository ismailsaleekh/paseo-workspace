import { randomUUID } from "node:crypto";
import type {
  BrowserWindow,
  IpcMain,
  IpcMainEvent,
  IpcMainInvokeEvent,
  Session,
  WebContentsView,
  WebPreferences,
} from "electron";
import {
  VisualFailure,
  VISUAL_FRAME_BYTES,
  VISUAL_CAPTURE_BYTES,
  VISUAL_CAPTURE_DIMENSION,
  VisualCaptureSchema,
  assertVisualJsonBound,
  validateVisualHtml,
  type VisualBinding,
  type VisualCapture,
} from "@getpaseo/protocol/pi-workspace/contracts";
import {
  DesktopVisualAcknowledgementSchema,
  DesktopVisualAddressSchema,
  DesktopVisualBoundsUpdateSchema,
  DesktopVisualCommandSchema,
  DesktopVisualMountSchema,
  DesktopVisualStateSchema,
  VisualReceiptSchema,
  type DesktopVisualMount,
  type VisualReceipt,
  type VisualCommand,
  type VisualHostSignal,
} from "@getpaseo/protocol/pi-workspace/rpc-schemas";

import type { BrowserKeyboard } from "./browser-keyboard/index.js";

export const VISUAL_SCHEME = "paseo-visual";
const DEADLINE_MS = 6000;
const GuestReceiptSchema = VisualReceiptSchema.omit({ capture: true });
// Discrete trusted interactions only; pointer motion and wheel scrolling do not claim activity.
const ACTIVITY_INPUTS: ReadonlySet<Electron.InputEvent["type"]> = new Set<
  Electron.InputEvent["type"]
>(["mouseDown", "rawKeyDown", "keyDown", "touchStart"]);
const CSP =
  "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' data: blob:; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; frame-src 'self' data: blob:; connect-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";

interface Preventable {
  preventDefault(): void;
}
interface DeniedMediaStreams {
  video?: never;
  audio?: never;
}
interface RequestAddress {
  url: string;
  method: string;
  resourceType: string;
}
export interface VisualSessionPolicy {
  setProxy(config: {
    mode: "fixed_servers";
    proxyRules: string;
    proxyBypassRules: string;
  }): Promise<void>;
  setPermissionCheckHandler(handler: () => boolean): void;
  setPermissionRequestHandler(
    handler: (contents: unknown, permission: unknown, respond: (allowed: boolean) => void) => void,
  ): void;
  setDevicePermissionHandler(handler: () => boolean): void;
  setDisplayMediaRequestHandler(
    handler: (request: unknown, respond: (streams: DeniedMediaStreams) => void) => void,
  ): void;
  webRequest: {
    onBeforeRequest(
      filter: { urls: string[] },
      listener: (request: RequestAddress, respond: (result: { cancel: boolean }) => void) => void,
    ): void;
  };
  on(event: "will-download", listener: (event: Preventable) => void): unknown;
}
export interface VisualContentsPolicy {
  setWebRTCIPHandlingPolicy(policy: "disable_non_proxied_udp"): void;
  setWindowOpenHandler(handler: () => { action: "deny" }): void;
  on(
    event: "will-navigate" | "will-frame-navigate" | "will-redirect" | "will-prevent-unload",
    listener: (event: Preventable) => void,
  ): unknown;
}
export function installVisualContentsPolicy(contents: VisualContentsPolicy): void {
  contents.setWebRTCIPHandlingPolicy("disable_non_proxied_udp");
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
  for (const event of [
    "will-navigate",
    "will-frame-navigate",
    "will-redirect",
    "will-prevent-unload",
  ] as const)
    contents.on(event, (navigation) => navigation.preventDefault());
}
export async function installVisualSessionPolicy(
  session: VisualSessionPolicy,
  documentUrl: string,
): Promise<void> {
  session.setPermissionCheckHandler(() => false);
  session.setPermissionRequestHandler((_contents, _permission, respond) => respond(false));
  session.setDevicePermissionHandler(() => false);
  session.setDisplayMediaRequestHandler((_request, respond) => respond({}));
  session.on("will-download", (event) => event.preventDefault());
  session.webRequest.onBeforeRequest({ urls: ["<all_urls>"] }, (request, respond) => {
    const document =
      request.url === documentUrl &&
      request.method === "GET" &&
      request.resourceType === "mainFrame";
    const embedded = request.url.startsWith("data:") || request.url.startsWith("blob:");
    respond({ cancel: !document && !embedded });
  });
  // Socket-level hints and WebRTC are not covered by webRequest or Chromium 152 CSP.
  // This session alone has no direct route, including Chromium's implicit loopback bypass.
  await session.setProxy({
    mode: "fixed_servers",
    proxyRules: "http://127.0.0.1:9",
    proxyBypassRules: "<-loopback>",
  });
}

export type VisualTimer = (expire: () => void, milliseconds: number) => () => void;
function timer(expire: () => void, milliseconds: number): () => void {
  const handle = setTimeout(expire, milliseconds);
  return () => clearTimeout(handle);
}
export class VisualDeadlines {
  private readonly pending = new Map<string, () => void>();
  constructor(private readonly schedule: VisualTimer = timer) {}
  arm(id: string, expire: () => void): void {
    if (this.pending.has(id))
      throw new VisualFailure("BUSY", "Visual operation is already pending");
    const cancel = this.schedule(() => {
      if (this.pending.get(id) !== cancel) return;
      this.pending.delete(id);
      expire();
    }, DEADLINE_MS);
    this.pending.set(id, cancel);
  }
  settle(id: string): void {
    const cancel = this.pending.get(id);
    this.pending.delete(id);
    if (cancel) cancel();
  }
  close(): void {
    const cancellations = [...this.pending.values()];
    this.pending.clear();
    for (const cancel of cancellations) cancel();
  }
}

export function sameVisualBinding(left: VisualBinding, right: VisualBinding): boolean {
  return (
    left.id === right.id &&
    left.revision === right.revision &&
    left.nonce === right.nonce &&
    left.clientGeneration === right.clientGeneration
  );
}
export function isVisualHostUrl(url: string, appOrigin: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "paseo:") return parsed.hostname === "app";
    return (
      (parsed.protocol === "http:" || parsed.protocol === "https:") && parsed.origin === appOrigin
    );
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    return false;
  }
}
export interface VisualFrameSource {
  debugger: {
    isAttached(): boolean;
    attach(): void;
    detach(): void;
    sendCommand(
      method: "Page.captureScreenshot",
      parameters: { format: "png"; fromSurface: true; captureBeyondViewport: false },
    ): Promise<unknown>;
  };
  getBackgroundThrottling(): boolean;
  setBackgroundThrottling(value: boolean): void;
  isDestroyed(): boolean;
}
const ScreenshotReplySchema = VisualCaptureSchema.pick({ data: true });
interface FrameCaptureInput {
  source: VisualFrameSource;
  valid(): boolean;
  signal: AbortSignal;
  schedule?: VisualTimer;
}
export function visualPngSize(png: Buffer): { width: number; height: number } {
  if (
    png.length < 24 ||
    png.length > VISUAL_CAPTURE_BYTES ||
    !png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    throw new VisualFailure("INVALID_CAPTURE", "Capture is not a bounded PNG");
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  if (
    width < 1 ||
    height < 1 ||
    width > VISUAL_CAPTURE_DIMENSION ||
    height > VISUAL_CAPTURE_DIMENSION
  )
    throw new VisualFailure("INVALID_CAPTURE", "Capture dimensions exceed their bounds");
  return { width, height };
}
export function captureDisplayedFrame({
  source,
  valid,
  signal,
  schedule = timer,
}: FrameCaptureInput): Promise<Buffer> {
  if (source.isDestroyed() || !valid() || signal.aborted)
    return Promise.reject(
      new VisualFailure("DISPLAY_UNAVAILABLE", "Capture target is not displayed"),
    );
  if (source.debugger.isAttached())
    return Promise.reject(
      new VisualFailure("BUSY", "The visual capture debugger is already owned"),
    );
  return new Promise<Buffer>((resolve, reject) => {
    const throttled = source.getBackgroundThrottling();
    let finished = false;
    let attached = false;
    let cancelDeadline: (() => void) | null = null;
    const finish = (result: { png: Buffer } | { error: unknown }) => {
      if (finished) return;
      finished = true;
      try {
        if (cancelDeadline) cancelDeadline();
        signal.removeEventListener("abort", abort);
        if (!source.isDestroyed()) {
          try {
            if (attached && source.debugger.isAttached()) source.debugger.detach();
          } finally {
            if (!source.isDestroyed()) source.setBackgroundThrottling(throttled);
          }
        }
      } catch (error) {
        reject(error);
        return;
      }
      if ("error" in result) reject(result.error);
      else resolve(result.png);
    };
    const abort = () =>
      finish({ error: new VisualFailure("STALE_DOCUMENT", "Capture target changed") });
    signal.addEventListener("abort", abort, { once: true });
    cancelDeadline = schedule(
      () =>
        finish({
          error: new VisualFailure(
            "DISPLAY_TIMEOUT",
            "No displayed frame arrived within the capture deadline",
          ),
        }),
      5000,
    );
    try {
      source.setBackgroundThrottling(false);
      source.debugger.attach();
      attached = true;
      // WebContentsView's frame subscription can deliver a surface without its displayed
      // canvas pixels. Capture this same guest's viewport through CDP, never a rerender,
      // full-document capture or a content-dependent fallback to another image source.
      void source.debugger
        .sendCommand("Page.captureScreenshot", {
          format: "png",
          fromSurface: true,
          captureBeyondViewport: false,
        })
        .then(
          (response: unknown) => {
            if (finished) return undefined;
            try {
              if (!valid() || source.isDestroyed() || signal.aborted)
                throw new VisualFailure(
                  "STALE_DOCUMENT",
                  "Capture binding changed before frame delivery",
                );
              const parsed = ScreenshotReplySchema.safeParse(response);
              if (!parsed.success)
                throw new VisualFailure(
                  "INVALID_CAPTURE",
                  "Capture response is not bounded PNG data",
                );
              const png = Buffer.from(parsed.data.data, "base64");
              visualPngSize(png);
              if (!valid() || signal.aborted)
                throw new VisualFailure(
                  "STALE_DOCUMENT",
                  "Capture binding changed during PNG decoding",
                );
              finish({ png });
            } catch (error) {
              finish({ error });
            }
            return undefined;
          },
          (error: unknown) => finish({ error }),
        );
    } catch (error) {
      finish({ error });
    }
  });
}

interface DesktopVisualDependencies {
  ipc: IpcMain;
  /** Default is the same production containment policy; a port can hold preparation before installation. */
  prepareSession?: typeof installVisualSessionPolicy;
  keyboard: Pick<BrowserKeyboard, "handleTrustedNativeInput">;
  createSession(partition: string): Session;
  createView(preferences: WebPreferences): WebContentsView;
  preloadPath: string;
  appOrigin: string;
  reportFailure(error: unknown): void;
}
interface Guest {
  host: BrowserWindow;
  view: WebContentsView;
  input: DesktopVisualMount;
  session: Session;
  deadlines: VisualDeadlines;
  sequence: number;
  terminated: boolean;
  pending: Set<string>;
  captures: Map<string, Extract<VisualCommand, { kind: "inspect" }>>;
  captureAbort: AbortController | null;
  /** The stored state revision the guest's live state is built on, from its own receipts. */
  stateRevision: number;
  /** The newest stored state revision relayed to the guest (mount, restoration, answer). */
  announced: number;
  epoch: number;
  visible: boolean;
  focusAfterOcclusion: boolean;
}

interface VisualMountReservation {
  hostId: number;
  invocation: string;
}

export class PiWorkspaceVisuals {
  private readonly windows = new Map<number, BrowserWindow>();
  private readonly guests = new Map<string, Guest>();
  private readonly reservations = new Map<string, VisualMountReservation>();
  private captures = 0;

  constructor(private readonly dependencies: DesktopVisualDependencies) {
    const ipc = dependencies.ipc;
    ipc.handle("paseo:visual:mount", (event, value: unknown) => this.mount(event, value));
    ipc.handle("paseo:visual:bounds", (event, value: unknown) => {
      const input = DesktopVisualBoundsUpdateSchema.parse(value);
      const guest = this.ownedGuest(event, input.nonce);
      const previous = guest.input.bounds;
      if (
        previous.x !== input.bounds.x ||
        previous.y !== input.bounds.y ||
        previous.width !== input.bounds.width ||
        previous.height !== input.bounds.height
      ) {
        guest.epoch += 1;
        guest.captureAbort?.abort();
      }
      const occluded = input.occluded === true;
      if (occluded && guest.input.occluded !== true)
        guest.focusAfterOcclusion = guest.view.webContents.isFocused();
      const restoreFocus = !occluded && guest.input.occluded === true && guest.focusAfterOcclusion;
      guest.input.occluded = occluded;
      guest.input.bounds = input.bounds;
      guest.view.setBounds(input.bounds);
      this.visibility(guest);
      if (occluded && guest.focusAfterOcclusion) guest.host.webContents.focus();
      if (restoreFocus) {
        guest.focusAfterOcclusion = false;
        // Restore internal first-responder ownership only while the overlay's host still owns it.
        // WebContents.focus does not activate an inactive window or steal another window's focus.
        if (guest.visible && guest.host.webContents.isFocused()) guest.view.webContents.focus();
      }
    });
    ipc.handle("paseo:visual:command", (event, value: unknown) => this.command(event, value));
    ipc.handle("paseo:visual:restore", (event, value: unknown) => {
      assertVisualJsonBound(value, 128 * 1024);
      const input = DesktopVisualStateSchema.parse(value);
      const guest = this.ownedGuest(event, input.binding.nonce);
      this.checkBinding(guest, input.binding);
      if (guest.terminated)
        throw new VisualFailure("DOCUMENT_UNRESPONSIVE", "Reopen the terminated visual");
      guest.epoch += 1;
      guest.captureAbort?.abort();
      // The guest never moves back to an older stored state (it ignores older restorations).
      guest.stateRevision = Math.max(guest.stateRevision, input.stateRevision);
      guest.announced = Math.max(guest.announced, input.stateRevision);
      guest.view.webContents.send("paseo:visual:restore", input);
    });
    ipc.handle("paseo:visual:ack", (event, value: unknown) => {
      assertVisualJsonBound(value, 4096);
      const input = DesktopVisualAcknowledgementSchema.parse(value);
      const guest = this.ownedGuest(event, input.binding.nonce);
      this.checkBinding(guest, input.binding);
      if (guest.terminated)
        throw new VisualFailure("DOCUMENT_UNRESPONSIVE", "Reopen the terminated visual");
      if (input.sequence > guest.sequence)
        throw new VisualFailure("INVALID_DATA", "Acknowledgement names an unsent visual receipt");
      // Only the guest's own next receipt shows that it continued on this base; the capture
      // check follows those receipts, not this answer.
      if (input.stateRevision !== null)
        guest.announced = Math.max(guest.announced, input.stateRevision);
      guest.view.webContents.send("paseo:visual:ack", input);
    });
    ipc.handle("paseo:visual:dispose", (event, value: unknown) => {
      const host = this.host(event);
      const input = DesktopVisualAddressSchema.parse(value);
      const reserved = this.reservations.get(input.nonce);
      if (reserved !== undefined && reserved.hostId !== host.webContents.id)
        throw new VisualFailure("UNAUTHORIZED", "Visual belongs to another window");
      this.reservations.delete(input.nonce);
      const guest = this.guests.get(input.nonce);
      if (guest) {
        if (guest.host !== host)
          throw new VisualFailure("UNAUTHORIZED", "Visual belongs to another window");
        this.dispose(guest);
      }
    });
    ipc.on("paseo:visual:configuration", (event) => {
      const guest = this.guestSender(event);
      if (!guest) {
        event.returnValue = { error: "UNAUTHORIZED_VISUAL_GUEST" };
        return;
      }
      event.returnValue = {
        binding: guest.input.current.binding,
        snapshot: guest.input.current.document.snapshot,
        stateRevision: guest.input.current.document.stateRevision,
        commandId: guest.input.commandId,
      };
    });
    ipc.on("paseo:visual:receipt", (event, value: unknown) => this.receive(event, value));
  }

  attachWindow(window: BrowserWindow): void {
    const id = window.webContents.id;
    this.windows.set(id, window);
    const visibility = () => {
      for (const guest of this.guests.values()) if (guest.host === window) this.visibility(guest);
    };
    window.on("show", visibility);
    window.on("hide", visibility);
    window.on("minimize", visibility);
    window.on("restore", visibility);
    window.on("closed", () => {
      this.releaseWindow(window, id);
      this.windows.delete(id);
    });
    window.webContents.on("did-start-navigation", (_event, _url, sameDocument, mainFrame) => {
      if (mainFrame && !sameDocument) this.releaseWindow(window, id);
    });
    // A mount request from the previous document can still be admitted between the start
    // and the commit of a navigation; nothing of the new document can have mounted yet.
    window.webContents.on("did-navigate", () => this.releaseWindow(window, id));
    window.webContents.on("render-process-gone", () => this.releaseWindow(window, id));
  }

  private host(event: IpcMainInvokeEvent): BrowserWindow {
    const window = this.windows.get(event.sender.id);
    const mainFrame = event.senderFrame === event.sender.mainFrame;
    if (
      !window ||
      window.isDestroyed() ||
      !mainFrame ||
      !isVisualHostUrl(event.sender.getURL(), this.dependencies.appOrigin)
    )
      throw new VisualFailure("UNAUTHORIZED", "Visual IPC requires the owning app window");
    return window;
  }

  private ownedGuest(event: IpcMainInvokeEvent, nonce: string): Guest {
    const window = this.host(event);
    const guest = this.guests.get(nonce);
    if (!guest || guest.host !== window || guest.view.webContents.isDestroyed())
      throw new VisualFailure(
        "DISPLAY_UNAVAILABLE",
        "Visual guest is no longer mounted in this window",
      );
    return guest;
  }

  private guestSender(event: IpcMainEvent): Guest | undefined {
    return [...this.guests.values()].find(
      (guest) =>
        !guest.terminated &&
        guest.view.webContents === event.sender &&
        event.senderFrame === event.sender.mainFrame,
    );
  }

  private checkBinding(guest: Guest, binding: VisualBinding): void {
    if (!sameVisualBinding(guest.input.current.binding, binding))
      throw new VisualFailure("STALE_DOCUMENT", "Visual message belongs to another document");
  }

  private async mount(event: IpcMainInvokeEvent, value: unknown): Promise<void> {
    const host = this.host(event);
    assertVisualJsonBound(value, VISUAL_FRAME_BYTES);
    const input = DesktopVisualMountSchema.parse(value);
    validateVisualHtml(input.current.document.html);
    const nonce = input.current.binding.nonce;
    if (this.guests.has(nonce) || this.reservations.has(nonce))
      throw new VisualFailure("BUSY", "Visual document is already mounted");
    if (this.guests.size + this.reservations.size >= 64)
      throw new VisualFailure("BUSY", "Desktop visual guest limit reached");
    const reservation: VisualMountReservation = {
      hostId: host.webContents.id,
      invocation: randomUUID(),
    };
    this.reservations.set(nonce, reservation);
    // A cancelled invocation cannot finish configuring the replacement invocation's session.
    const partition = `paseo-visual-${nonce}-${reservation.invocation}`;
    const documentUrl = `${VISUAL_SCHEME}://${nonce}/document`;
    let invocationGuest: Guest | null = null;
    try {
      const session = this.dependencies.createSession(partition);
      const prepare = this.dependencies.prepareSession ?? installVisualSessionPolicy;
      await prepare(session, documentUrl);
      if (
        host.isDestroyed() ||
        this.reservations.get(nonce) !== reservation ||
        event.senderFrame !== host.webContents.mainFrame
      )
        throw new VisualFailure("CANCELLED", "Visual was unmounted while preparing its session");
      session.protocol.handle(VISUAL_SCHEME, (request) => {
        if (request.url !== documentUrl || request.method !== "GET")
          return new Response("Denied", { status: 403 });
        return new Response(input.current.document.html, {
          headers: {
            "content-type": "text/html; charset=utf-8",
            "content-security-policy": CSP,
            "cache-control": "no-store",
          },
        });
      });
      const view = this.dependencies.createView({
        partition,
        preload: this.dependencies.preloadPath,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        nodeIntegrationInSubFrames: false,
        nodeIntegrationInWorker: false,
        webviewTag: false,
        webSecurity: true,
        allowRunningInsecureContent: false,
        spellcheck: false,
        backgroundThrottling: true,
      });
      const guest: Guest = {
        host,
        view,
        input,
        session,
        deadlines: new VisualDeadlines(),
        sequence: 0,
        terminated: false,
        pending: new Set(),
        captures: new Map(),
        captureAbort: null,
        stateRevision: input.current.document.stateRevision,
        announced: input.current.document.stateRevision,
        epoch: 0,
        visible: true,
        focusAfterOcclusion: false,
      };
      invocationGuest = guest;
      this.guests.set(nonce, guest);
      installVisualContentsPolicy(view.webContents);
      host.contentView.addChildView(view);
      view.setBounds(input.bounds);
      this.bindGuest(guest);
      this.visibility(guest);
      this.arm(guest, input.commandId);
      void view.webContents
        .loadURL(documentUrl)
        .catch((error: unknown) => this.fail(guest, "DOCUMENT_ERROR", error));
    } catch (error) {
      if (invocationGuest && this.guests.get(nonce) === invocationGuest)
        this.dispose(invocationGuest);
      throw error;
    } finally {
      if (this.reservations.get(nonce) === reservation) this.reservations.delete(nonce);
    }
  }

  private bindGuest(guest: Guest): void {
    const contents = guest.view.webContents;
    // Only the browser input pipeline reaches this event (real input or main-process
    // sendInputEvent); generated script cannot synthesize it or address another host.
    contents.on("input-event", (_event, input) => {
      if (ACTIVITY_INPUTS.has(input.type) && guest.visible && !guest.terminated)
        this.hostSignal(guest, { kind: "activity", binding: guest.input.current.binding });
    });
    contents.on("before-input-event", (event, input) => {
      if (!guest.visible || guest.terminated || guest.host.isDestroyed()) return;
      this.dependencies.keyboard.handleTrustedNativeInput({
        contents,
        hostContents: guest.host.webContents,
        sourceId: `${VISUAL_SCHEME}:${guest.input.current.binding.nonce}`,
        event,
        input,
      });
      // Lets the app leave full screen; the key is not consumed, so the drawing still sees it.
      if (input.type === "keyDown" && input.key === "Escape" && !input.isAutoRepeat)
        guest.host.webContents.send("paseo:event:visual", {
          type: "paseo-visual-escape",
          nonce: guest.input.current.binding.nonce,
        });
    });
    contents.on("unresponsive", () =>
      this.fail(guest, "DOCUMENT_UNRESPONSIVE", new Error("Visual renderer stopped responding")),
    );
    contents.on("render-process-gone", () =>
      this.fail(guest, "DOCUMENT_UNRESPONSIVE", new Error("Visual renderer terminated")),
    );
    contents.on("preload-error", (_event, _path, error) =>
      this.fail(guest, "DOCUMENT_ERROR", error),
    );
    contents.once("destroyed", () => {
      guest.deadlines.close();
      guest.captureAbort?.abort();
    });
  }

  private arm(guest: Guest, commandId: string | null): void {
    const key = commandId === null ? "mount" : commandId;
    guest.pending.add(key);
    guest.deadlines.arm(key, () =>
      this.fail(guest, "DOCUMENT_UNRESPONSIVE", new Error("Visual exceeded the host deadline")),
    );
  }

  private command(event: IpcMainInvokeEvent, value: unknown): void {
    assertVisualJsonBound(value, 128 * 1024);
    const input = DesktopVisualCommandSchema.parse(value);
    const guest = this.ownedGuest(event, input.nonce);
    if (input.command.kind === "render")
      throw new VisualFailure("INVALID_COMMAND", "Mount a new guest to render a document");
    this.checkBinding(guest, input.command.binding);
    if (guest.terminated)
      throw new VisualFailure("DOCUMENT_UNRESPONSIVE", "Reopen the terminated visual");
    if (!guest.visible)
      throw new VisualFailure(
        "DISPLAY_UNAVAILABLE",
        "Visual window is not displaying this document",
      );
    if (guest.pending.size >= 4) throw new VisualFailure("BUSY", "Visual command limit reached");
    if (input.command.kind === "inspect" && input.command.screenshot) {
      if (guest.captures.size || guest.captureAbort || this.captures >= 4)
        throw new VisualFailure("BUSY", "Capture concurrency limit reached");
      if (input.command.stateRevision === undefined)
        throw new VisualFailure("INVALID_CAPTURE", "Capture must name its stored state revision");
      guest.captures.set(input.command.commandId, input.command);
    }
    this.arm(guest, input.command.commandId);
    guest.view.webContents.send("paseo:visual:command", input.command);
  }

  private receive(event: IpcMainEvent, value: unknown): void {
    const guest = this.guestSender(event);
    if (!guest) {
      this.dependencies.reportFailure(
        new VisualFailure("UNAUTHORIZED", "Rejected visual receipt sender"),
      );
      return;
    }
    try {
      assertVisualJsonBound(value, 128 * 1024);
      const receipt = GuestReceiptSchema.parse(value);
      this.checkBinding(guest, receipt.binding);
      if (receipt.sequence <= guest.sequence)
        throw new VisualFailure("STALE_STATE", "Repeated visual receipt");
      // A guest continues only on stored states this host relayed to it; the base it names is
      // the state its display shows, which an answer can advance without a restoration.
      const base = receipt.stateRevision ?? guest.stateRevision;
      if (base > guest.announced)
        throw new VisualFailure("INVALID_DATA", "Visual receipt names an unknown stored state");
      guest.sequence = receipt.sequence;
      if (!receipt.error) guest.stateRevision = Math.max(guest.stateRevision, base);
      const key = receipt.commandId === null ? "mount" : receipt.commandId;
      const request = guest.captures.get(key);
      guest.deadlines.settle(key);
      if (request && !receipt.error) {
        void this.capture(guest, request, receipt)
          .then(
            (capture) => {
              this.completeReceipt(guest, { ...receipt, capture });
              return undefined;
            },
            (error: unknown) => {
              const code = error instanceof VisualFailure ? error.code : "CAPTURE_FAILED";
              const message = error instanceof Error ? error.message : "Displayed capture failed";
              this.completeReceipt(guest, {
                ...receipt,
                error: { code, message: message.slice(0, 2048) },
              });
            },
          )
          .catch((error: unknown) => this.dependencies.reportFailure(error));
      } else this.completeReceipt(guest, receipt);
    } catch (error) {
      this.fail(guest, "DOCUMENT_ERROR", error);
    }
  }

  private completeReceipt(guest: Guest, receipt: VisualReceipt): void {
    const key = receipt.commandId === null ? "mount" : receipt.commandId;
    guest.pending.delete(key);
    guest.captures.delete(key);
    if (guest.terminated || this.guests.get(guest.input.current.binding.nonce) !== guest) return;
    this.emit(guest, receipt);
  }

  private async capture(
    guest: Guest,
    command: Extract<VisualCommand, { kind: "inspect" }>,
    receipt: VisualReceipt,
  ): Promise<VisualCapture> {
    if (guest.captureAbort || this.captures >= 4)
      throw new VisualFailure("BUSY", "Capture concurrency limit reached");
    const viewport = guest.view.getBounds();
    if (
      viewport.width < 1 ||
      viewport.height < 1 ||
      viewport.width > VISUAL_CAPTURE_DIMENSION ||
      viewport.height > VISUAL_CAPTURE_DIMENSION
    )
      throw new VisualFailure("DISPLAY_UNAVAILABLE", "Capture viewport is not bounded and visible");
    const binding = { ...command.binding };
    const epoch = guest.epoch;
    const revision = command.stateRevision;
    if (
      revision === undefined ||
      receipt.stateRevision !== revision ||
      guest.stateRevision !== revision
    )
      throw new VisualFailure(
        "STALE_STATE",
        "Capture state revision changed before frame acquisition",
      );
    const controller = new AbortController();
    guest.captureAbort = controller;
    this.captures += 1;
    const valid = () =>
      this.guests.get(binding.nonce) === guest &&
      !guest.terminated &&
      guest.visible &&
      guest.epoch === epoch &&
      guest.sequence === receipt.sequence &&
      guest.stateRevision === revision &&
      guest.captures.get(command.commandId) === command &&
      sameVisualBinding(binding, guest.input.current.binding);
    try {
      const png = await captureDisplayedFrame({
        source: guest.view.webContents,
        valid,
        signal: controller.signal,
      });
      if (!valid())
        throw new VisualFailure(
          "STALE_DOCUMENT",
          "Capture lifetime changed after frame acquisition",
        );
      const size = visualPngSize(png);
      const pixelRatio = size.width / viewport.width;
      if (Math.abs(size.height - viewport.height * pixelRatio) > 2)
        throw new VisualFailure("INVALID_CAPTURE", "Capture viewport changed aspect ratio");
      return VisualCaptureSchema.parse({
        operationId: command.commandId,
        binding,
        data: png.toString("base64"),
        screenshot: {
          client: binding.clientGeneration,
          mimeType: "image/png",
          width: size.width,
          height: size.height,
          viewport: { width: viewport.width, height: viewport.height },
          pixelRatio,
          revision: binding.revision,
          stateRevision: revision,
        },
      });
    } finally {
      this.captures -= 1;
      if (guest.captureAbort === controller) guest.captureAbort = null;
    }
  }

  private hostSignal(guest: Guest, event: VisualHostSignal): void {
    if (!guest.host.isDestroyed())
      guest.host.webContents.send("paseo:event:visual", { type: "paseo-visual-host", event });
  }

  private visibility(guest: Guest): void {
    const visible =
      !guest.host.isDestroyed() &&
      guest.host.isVisible() &&
      !guest.host.isMinimized() &&
      guest.input.bounds.width > 0 &&
      guest.input.bounds.height > 0 &&
      !guest.terminated &&
      guest.input.occluded !== true;
    guest.view.setVisible(visible);
    if (visible === guest.visible) return;
    guest.visible = visible;
    guest.epoch += 1;
    guest.captureAbort?.abort();
    this.hostSignal(guest, { kind: "visibility", binding: guest.input.current.binding, visible });
  }

  private emit(guest: Guest, receipt: VisualReceipt): void {
    if (!guest.host.isDestroyed())
      guest.host.webContents.send("paseo:event:visual", { type: "paseo-visual", receipt });
  }

  private fail(guest: Guest, code: string, error: unknown): void {
    if (guest.terminated || this.guests.get(guest.input.current.binding.nonce) !== guest) return;
    guest.terminated = true;
    guest.captureAbort?.abort();
    guest.deadlines.close();
    const pending = guest.pending.size ? [...guest.pending] : ["mount"];
    guest.pending.clear();
    const message = error instanceof Error ? error.message : "Visual guest failed";
    for (const key of pending)
      this.emit(guest, {
        binding: guest.input.current.binding,
        commandId: key === "mount" ? null : key,
        sequence: ++guest.sequence,
        stateRevision: guest.input.current.document.stateRevision,
        snapshot: guest.input.current.document.snapshot,
        actions: {},
        error: { code, message: message.slice(0, 2048) || "Visual guest failed" },
      });
    if (!guest.view.webContents.isDestroyed()) {
      guest.view.setVisible(false);
      if (guest.view.webContents.getOSProcessId() > 0)
        guest.view.webContents.forcefullyCrashRenderer();
    }
  }

  private dispose(guest: Guest): void {
    const nonce = guest.input.current.binding.nonce;
    this.guests.delete(nonce);
    guest.terminated = true;
    guest.captureAbort?.abort();
    guest.deadlines.close();
    if (!guest.host.isDestroyed()) guest.host.contentView.removeChildView(guest.view);
    if (!guest.view.webContents.isDestroyed())
      guest.view.webContents.close({ waitForBeforeUnload: false });
    guest.session.protocol.unhandle(VISUAL_SCHEME);
  }

  private releaseWindow(window: BrowserWindow, hostId: number): void {
    for (const [nonce, reservation] of this.reservations)
      if (reservation.hostId === hostId) this.reservations.delete(nonce);
    for (const guest of this.guests.values()) if (guest.host === window) this.dispose(guest);
  }
}
