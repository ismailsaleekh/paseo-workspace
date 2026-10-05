import assert from "node:assert/strict";
import { test } from "vitest";
import type { VisualError } from "@getpaseo/protocol/pi-workspace/contracts";
import {
  VisualReceiptSchema,
  type VisualHostSignal,
  type VisualReceipt,
  type VisualRenderDocument,
} from "@getpaseo/protocol/pi-workspace/rpc-schemas";
import {
  ANDROID_VISUAL_READY_MS,
  AndroidVisualAdapter,
  type AndroidVisualNative,
} from "./android-visual-host";

const id = "25afcecf-bc68-4c7f-b408-2640ed2a0026";
const nonce = "7c6c0224-4617-4c5b-bbfe-03c3c330c608";
const generation = "b5bed943-2cd8-48bd-ab77-8808b6284674";
const renderId = "0b8b0f4e-8d0c-4b38-9e0c-6f0f8f6a2a11";
const inspectId = "4d6c2f0e-6e44-4a53-8f1a-6a5b2c1d9e01";
const actId = "9a1e4c3b-2d5f-4e6a-8b7c-1d2e3f4a5b6c";
const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lZsAAAAASUVORK5CYII=";
const current: VisualRenderDocument = {
  binding: { id, revision: 3, nonce, clientGeneration: generation },
  document: {
    id,
    title: "Android adapter",
    revision: 3,
    stateRevision: 4,
    html: "<p>android</p>",
    snapshot: { state: { value: 1 }, selection: null },
  },
};

interface NativeCall {
  method: "open" | "post" | "capture" | "close";
  session: string;
  value: string;
}

class FakeNative implements AndroidVisualNative {
  readonly calls: NativeCall[] = [];
  rejectWith: Error | null = null;
  private record(method: NativeCall["method"], session: string, value: string): Promise<void> {
    this.calls.push({ method, session, value });
    return this.rejectWith ? Promise.reject(this.rejectWith) : Promise.resolve();
  }
  open(session: string, html: string): Promise<void> {
    return this.record("open", session, html);
  }
  post(session: string, text: string): Promise<void> {
    return this.record("post", session, text);
  }
  capture(session: string, request: string): Promise<void> {
    return this.record("capture", session, request);
  }
  close(session: string): Promise<void> {
    return this.record("close", session, "");
  }
  describe(): Promise<string> {
    return Promise.resolve("link=binding surface=0x0");
  }
}

interface Harness {
  adapter: AndroidVisualAdapter;
  native: FakeNative;
  received: unknown[];
  signals: VisualHostSignal[];
  errors: unknown[];
  failures: VisualError[];
  /** Fires the pending readiness deadline, if any. */
  expireReady(): void;
  pendingDeadlines(): number;
}

function harness(renderCommandId: string | null = renderId, withNative = true): Harness {
  const native = new FakeNative();
  const received: unknown[] = [];
  const signals: VisualHostSignal[] = [];
  const errors: unknown[] = [];
  const failures: VisualError[] = [];
  const deadlines = new Set<() => void>();
  const adapter = new AndroidVisualAdapter({
    current,
    renderCommandId,
    native: withNative ? native : null,
    receive: (value) => received.push(value),
    hostEvent: (event) => signals.push(event),
    reportError: (error) => errors.push(error),
    onFailure: (error) => failures.push(error),
    schedule: (expire, milliseconds) => {
      assert.equal(milliseconds, ANDROID_VISUAL_READY_MS);
      deadlines.add(expire);
      return () => deadlines.delete(expire);
    },
  });
  return {
    adapter,
    native,
    received,
    signals,
    errors,
    failures,
    expireReady: () => {
      for (const expire of deadlines) {
        deadlines.delete(expire);
        expire();
      }
    },
    pendingDeadlines: () => deadlines.size,
  };
}

function documentReceipt(sequence: number, commandId: string | null): VisualReceipt {
  return {
    binding: current.binding,
    commandId,
    sequence,
    stateRevision: 4,
    snapshot: { state: { value: sequence }, selection: null },
    actions: {},
    error: null,
  };
}

function message(receipt: VisualReceipt) {
  return {
    type: "message",
    session: nonce,
    data: JSON.stringify({ type: "paseo-visual", receipt }),
  };
}

function receiptOf(value: unknown): VisualReceipt {
  if (typeof value !== "object" || value === null || !("receipt" in value))
    throw new Error("Expected a document message");
  return VisualReceiptSchema.parse(value.receipt);
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

test("mount opens the bound document in its own session with the Android host transport", () => {
  const { adapter, native } = harness();
  adapter.mount();
  assert.equal(native.calls.length, 1);
  const [open] = native.calls;
  assert.equal(open?.method, "open");
  assert.equal(open?.session, nonce);
  assert.match(open?.value ?? "", /paseoVisualHost/);
  assert.match(open?.value ?? "", /"platform":"android"/);
  assert.match(open?.value ?? "", new RegExp(renderId));
  assert.match(open?.value ?? "", /Content-Security-Policy/);
});

test("document receipts pass through; a screenshot is attached only to its own inspection", () => {
  const { adapter, native, received, errors } = harness();
  adapter.mount();
  adapter.hostEvent({ type: "attached", session: nonce });
  adapter.hostEvent(message(documentReceipt(1, renderId)));
  assert.equal(received.length, 1);
  adapter.command({
    kind: "inspect",
    commandId: inspectId,
    binding: current.binding,
    screenshot: true,
    stateRevision: 4,
  });
  const post = native.calls.at(-1);
  assert.equal(post?.method, "post");
  assert.deepEqual(JSON.parse(post?.value ?? "null"), {
    type: "paseo-visual-command",
    command: {
      kind: "inspect",
      commandId: inspectId,
      binding: current.binding,
      screenshot: true,
      stateRevision: 4,
    },
  });
  adapter.hostEvent(message(documentReceipt(2, inspectId)));
  assert.equal(received.length, 1, "inspection receipt waits for the capture");
  assert.deepEqual(native.calls.at(-1), { method: "capture", session: nonce, value: inspectId });
  adapter.hostEvent({
    type: "capture",
    session: nonce,
    request: inspectId,
    data: PNG,
    width: 1080,
    height: 945,
    density: 2.625,
  });
  assert.equal(received.length, 2);
  const withCapture = receiptOf(received[1]);
  assert.equal(withCapture.sequence, 2);
  assert.deepEqual(withCapture.capture, {
    operationId: inspectId,
    binding: current.binding,
    screenshot: {
      client: generation,
      mimeType: "image/png",
      width: 1080,
      height: 945,
      viewport: { width: 411, height: 360 },
      pixelRatio: 2.625,
      revision: 3,
      stateRevision: 4,
    },
    data: PNG,
  });
  adapter.hostEvent({
    type: "capture",
    session: nonce,
    request: inspectId,
    data: PNG,
    width: 1,
    height: 1,
    density: 1,
  });
  assert.equal(received.length, 2, "a repeated capture result never satisfies anything");
  assert.match(String(errors.at(-1)), /does not match a pending inspection/);
});

test("capture failures and detached surfaces answer the inspection explicitly", () => {
  const { adapter, received } = harness(null);
  adapter.mount();
  adapter.command({
    kind: "inspect",
    commandId: inspectId,
    binding: current.binding,
    screenshot: true,
    stateRevision: 4,
  });
  adapter.hostEvent(message(documentReceipt(1, inspectId)));
  assert.deepEqual(receiptOf(received[0]).error, {
    code: "CAPTURE_FAILED",
    message: "The visual surface is not attached",
  });
  adapter.hostEvent({ type: "attached", session: nonce });
  adapter.command({
    kind: "inspect",
    commandId: actId,
    binding: current.binding,
    screenshot: true,
    stateRevision: 4,
  });
  adapter.hostEvent(message(documentReceipt(2, actId)));
  adapter.hostEvent({
    type: "captureFailed",
    session: nonce,
    request: actId,
    message: "Renderer produced no frame",
  });
  const failed = receiptOf(received[1]);
  assert.equal(failed.sequence, 2);
  assert.equal(failed.capture, undefined);
  assert.deepEqual(failed.error, { code: "CAPTURE_FAILED", message: "Renderer produced no frame" });
});

test("a capture that exceeds the contract bounds is refused rather than truncated", () => {
  const { adapter, received } = harness(null);
  adapter.mount();
  adapter.hostEvent({ type: "attached", session: nonce });
  adapter.command({
    kind: "inspect",
    commandId: inspectId,
    binding: current.binding,
    screenshot: true,
    stateRevision: 4,
  });
  adapter.hostEvent(message(documentReceipt(1, inspectId)));
  adapter.hostEvent({
    type: "capture",
    session: nonce,
    request: inspectId,
    data: PNG,
    width: 4096,
    height: 4096,
    density: 0.5,
  });
  assert.equal(receiptOf(received[0]).error?.code, "CAPTURE_FAILED");
});

test("a missing visual host answers the pending render with RENDERER_UNAVAILABLE and never falls back", () => {
  const { adapter, native, received, failures } = harness();
  adapter.mount();
  adapter.hostEvent({
    type: "error",
    session: nonce,
    code: "RENDERER_UNAVAILABLE",
    message: "The Paseo visual host is not installed",
  });
  const failure = receiptOf(received[0]);
  assert.equal(failure.commandId, renderId);
  assert.equal(failure.sequence, 1);
  assert.deepEqual(failure.snapshot, current.document.snapshot);
  assert.deepEqual(failure.error, {
    code: "RENDERER_UNAVAILABLE",
    message: "The Paseo visual host is not installed",
  });
  assert.deepEqual(failures, [failure.error]);
  const posts = native.calls.length;
  adapter.command({
    kind: "act",
    commandId: actId,
    binding: current.binding,
    action: "go",
    value: null,
  });
  assert.equal(native.calls.length, posts, "a failed display sends nothing to the host");
  const later = receiptOf(received[1]);
  assert.equal(later.commandId, actId);
  assert.equal(later.sequence, 2);
  assert.equal(later.error?.code, "RENDERER_UNAVAILABLE");
  adapter.dispose();
  assert.equal(native.calls.at(-1)?.method, "open", "the closed native session is not reused");
});

test("a build without the native module reports RENDERER_UNAVAILABLE at mount", () => {
  const { adapter, received, failures } = harness(renderId, false);
  adapter.mount();
  assert.equal(receiptOf(received[0]).error?.code, "RENDERER_UNAVAILABLE");
  assert.equal(failures.length, 1);
});

test("an unresponsive document fails the latest awaited command after earlier receipts", () => {
  const { adapter, received } = harness();
  adapter.mount();
  adapter.hostEvent({ type: "attached", session: nonce });
  adapter.hostEvent(message(documentReceipt(1, renderId)));
  adapter.command({
    kind: "act",
    commandId: actId,
    binding: current.binding,
    action: "freeze",
    value: {},
  });
  adapter.hostEvent(message(documentReceipt(2, actId)));
  adapter.command({ kind: "inspect", commandId: inspectId, binding: current.binding });
  adapter.hostEvent({
    type: "error",
    session: nonce,
    code: "DOCUMENT_UNRESPONSIVE",
    message: "The renderer was terminated",
  });
  const unresponsive = receiptOf(received.at(-1));
  assert.equal(unresponsive.commandId, inspectId);
  assert.equal(unresponsive.sequence, 3);
  assert.deepEqual(unresponsive.snapshot, { state: { value: 2 }, selection: null });
  assert.equal(unresponsive.error?.code, "DOCUMENT_UNRESPONSIVE");
});

test("native call rejections, foreign sessions and malformed events are explicit", async () => {
  const { adapter, native, received, errors, signals } = harness();
  adapter.hostEvent({ type: "activity", session: nonce });
  assert.deepEqual(signals, [{ kind: "activity", binding: current.binding }]);
  adapter.hostEvent({ type: "activity", session: generation });
  assert.equal(signals.length, 1, "another session's activity is not this display's");
  adapter.hostEvent({ type: "message", session: nonce });
  assert.match(String(errors.at(-1)), /invalid event/);
  adapter.hostEvent({ type: "message", session: nonce, data: "{broken" });
  assert.match(String(errors.at(-1)), /malformed JSON/);
  native.rejectWith = new Error("Visual session is not mounted");
  adapter.mount();
  await flush();
  const failure = receiptOf(received.at(-1));
  assert.deepEqual(failure.error, {
    code: "RENDERER_UNAVAILABLE",
    message: "Visual session is not mounted",
  });
  adapter.hostEvent({ type: "activity", session: nonce });
  assert.equal(signals.length, 1, "a failed display claims no activity");
});

test("restoration is posted to the live document and disposal closes the session once", () => {
  const { adapter, native } = harness();
  adapter.mount();
  const restored: VisualRenderDocument = {
    ...current,
    document: { ...current.document, stateRevision: 5, snapshot: { state: 9, selection: null } },
  };
  adapter.restore(restored);
  assert.deepEqual(JSON.parse(native.calls.at(-1)?.value ?? "null"), {
    type: "paseo-visual-state",
    binding: current.binding,
    snapshot: { state: 9, selection: null },
    stateRevision: 5,
  });
  adapter.dispose();
  adapter.dispose();
  assert.deepEqual(
    native.calls.filter((call) => call.method === "close"),
    [{ method: "close", session: nonce, value: "" }],
  );
  adapter.hostEvent(message(documentReceipt(1, renderId)));
  adapter.command({ kind: "inspect", commandId: inspectId, binding: current.binding });
  assert.equal(native.calls.filter((call) => call.method === "post").length, 1);
});

test("a display that never becomes ready fails the render explicitly with its native state", async () => {
  const { adapter, received, failures, expireReady } = harness();
  adapter.mount();
  adapter.hostEvent({ type: "attached", session: nonce });
  expireReady();
  await flush();
  const failure = receiptOf(received[0]);
  assert.equal(failure.commandId, renderId);
  assert.equal(failure.error?.code, "RENDERER_UNAVAILABLE");
  assert.match(failure.error?.message ?? "", /within 12 s/);
  assert.match(failure.error?.message ?? "", /attached=true hostEvents=1/);
  assert.match(failure.error?.message ?? "", /native link=binding surface=0x0/);
  assert.equal(failures.length, 1);
});

test("the first document receipt, a failure or disposal cancels the readiness deadline", () => {
  const ready = harness();
  ready.adapter.mount();
  assert.equal(ready.pendingDeadlines(), 1);
  ready.adapter.hostEvent(message(documentReceipt(1, renderId)));
  assert.equal(ready.pendingDeadlines(), 0);
  const failed = harness();
  failed.adapter.mount();
  failed.adapter.hostEvent({
    type: "error",
    session: nonce,
    code: "RENDERER_UNAVAILABLE",
    message: "Not installed",
  });
  assert.equal(failed.pendingDeadlines(), 0);
  const disposed = harness();
  disposed.adapter.mount();
  disposed.adapter.dispose();
  assert.equal(disposed.pendingDeadlines(), 0);
});
