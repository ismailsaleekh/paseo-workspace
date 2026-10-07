import { z } from "zod";
import {
  VisualActionsSchema,
  VisualBindingSchema,
  VisualDocumentSchema,
  VisualErrorSchema,
  VisualSnapshotSchema,
  VisualRevisionSchema,
  VisualPlatformSchema,
  VisualCaptureSchema,
  VisualFailure,
  VISUAL_SNAPSHOT_BYTES,
  VISUAL_CAPTURE_DIMENSION,
  assertVisualJsonBound,
  parseVisualSnapshot,
} from "./contracts.js";
import { SpeechEventSchema, SpeechReceiptSchema } from "./speech.js";

export const VisualRenderDocumentSchema = z
  .object({
    binding: VisualBindingSchema,
    document: VisualDocumentSchema,
  })
  .strict();
export const VisualViewSchema = z
  .object({
    generation: z.string().uuid(),
    sequence: z.number().int().nonnegative(),
    current: VisualRenderDocumentSchema.nullable(),
  })
  .strict();
export const VisualCommandSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("render"),
      commandId: z.string().uuid(),
      current: VisualRenderDocumentSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("inspect"),
      commandId: z.string().uuid(),
      binding: VisualBindingSchema,
      screenshot: z.boolean().optional(),
      stateRevision: VisualRevisionSchema.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("act"),
      commandId: z.string().uuid(),
      binding: VisualBindingSchema,
      action: z.string().min(1).max(128),
      value: z.json(),
    })
    .strict(),
]);
export const VisualEventSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("snapshot"), view: VisualViewSchema }).strict(),
  z
    .object({
      kind: z.literal("command"),
      sequence: z.number().int().positive(),
      command: VisualCommandSchema,
    })
    .strict(),
  // Agent speech for the one playback client; unsequenced and independent of visual commands.
  // Sent only to observations that announced speech support with a `ready` speech receipt.
  z.object({ kind: z.literal("speech"), speech: SpeechEventSchema }).strict(),
]);
export const VisualReceiptSchema = z
  .object({
    binding: VisualBindingSchema,
    commandId: z.string().uuid().nullable(),
    sequence: z.number().int().positive(),
    stateRevision: VisualRevisionSchema.optional(),
    snapshot: VisualSnapshotSchema,
    actions: VisualActionsSchema,
    error: VisualErrorSchema.nullable(),
    capture: VisualCaptureSchema.optional(),
  })
  .strict();
export const VisualHostSignalSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("activity"), binding: VisualBindingSchema }).strict(),
  z
    .object({ kind: z.literal("visibility"), binding: VisualBindingSchema, visible: z.boolean() })
    .strict(),
]);
export const VisualClientReceiptSchema = z.union([
  VisualReceiptSchema,
  VisualHostSignalSchema,
  SpeechReceiptSchema,
]);
export const DesktopVisualEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("paseo-visual"), receipt: VisualReceiptSchema }).strict(),
  z.object({ type: z.literal("paseo-visual-host"), event: VisualHostSignalSchema }).strict(),
]);
export type VisualHostSignal = z.infer<typeof VisualHostSignalSchema>;
export type VisualClientReceipt = z.infer<typeof VisualClientReceiptSchema>;

// zod-aot 0.20.4 rejects recursive JSON objects in outbound action/state leaves.
// The generated transport validator checks bounded text; the consumer decodes and
// validates JSON immediately, without weakening validation or patching shared codegen.
const WireJsonSchema = z.string().max(VISUAL_SNAPSHOT_BYTES);
const WireDocumentSchema = VisualDocumentSchema.omit({ snapshot: true }).extend({
  snapshotJson: WireJsonSchema,
});
const WireRenderDocumentSchema = z
  .object({ binding: VisualBindingSchema, document: WireDocumentSchema })
  .strict();
export const VisualWireViewSchema = VisualViewSchema.omit({ current: true }).extend({
  current: WireRenderDocumentSchema.nullable(),
});
const WireCommandSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("render"),
      commandId: z.string().uuid(),
      current: WireRenderDocumentSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("inspect"),
      commandId: z.string().uuid(),
      binding: VisualBindingSchema,
      screenshot: z.boolean().optional(),
      stateRevision: VisualRevisionSchema.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("act"),
      commandId: z.string().uuid(),
      binding: VisualBindingSchema,
      action: z.string().min(1).max(128),
      valueJson: WireJsonSchema,
    })
    .strict(),
]);
export const VisualWireEventSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("snapshot"), view: VisualWireViewSchema }).strict(),
  z
    .object({
      kind: z.literal("command"),
      sequence: z.number().int().positive(),
      command: WireCommandSchema,
    })
    .strict(),
  z.object({ kind: z.literal("speech"), speech: SpeechEventSchema }).strict(),
]);

export const VisualSubscribeRequestSchema = z.object({
  type: z.literal("pi_workspace.observe.request"),
  requestId: z.string(),
  agentId: z.string().min(1).max(256),
  platform: VisualPlatformSchema.optional(),
});
export const VisualSubscribeResponseSchema = z.object({
  type: z.literal("pi_workspace.observe.response"),
  payload: z.object({
    requestId: z.string(),
    subscriptionId: z.string(),
    agentId: z.string(),
    view: VisualWireViewSchema,
  }),
});
export const VisualEventMessageSchema = z.object({
  type: z.literal("pi_workspace.update"),
  payload: z.object({
    subscriptionId: z.string(),
    agentId: z.string(),
    event: VisualWireEventSchema,
  }),
});
export const VisualReceiptRequestSchema = z.object({
  type: z.literal("pi_workspace.receipt.request"),
  requestId: z.string(),
  agentId: z.string().min(1).max(256),
  receipt: VisualClientReceiptSchema,
});
export const VisualReceiptResponseSchema = z.object({
  type: z.literal("pi_workspace.receipt.response"),
  payload: z.object({
    requestId: z.string(),
    agentId: z.string(),
    stateRevision: z.number().int().positive(),
  }),
});
// For speech receipts `stateRevision` acknowledges the observation's speech receipt sequence.

export const DesktopVisualBoundsSchema = z
  .object({
    x: z.number().int().min(-131072).max(131072),
    y: z.number().int().min(-131072).max(131072),
    width: z.number().int().nonnegative().max(8192),
    height: z.number().int().nonnegative().max(8192),
  })
  .strict();
export const DesktopVisualMountSchema = z
  .object({
    current: VisualRenderDocumentSchema,
    commandId: z.string().uuid().nullable(),
    bounds: DesktopVisualBoundsSchema,
  })
  .strict();
export const DesktopVisualAddressSchema = z.object({ nonce: z.string().uuid() }).strict();
export const DesktopVisualBoundsUpdateSchema = DesktopVisualAddressSchema.extend({
  bounds: DesktopVisualBoundsSchema,
});
export const DesktopVisualCommandSchema = DesktopVisualAddressSchema.extend({
  command: VisualCommandSchema,
});
export const DesktopVisualStateSchema = z
  .object({
    binding: VisualBindingSchema,
    snapshot: VisualSnapshotSchema,
    stateRevision: VisualRevisionSchema,
  })
  .strict();
/**
 * The daemon's answer to one guest receipt the guest waits for (a publication or a command
 * result): the stored state revision that holds it, or `null` when it was rejected.
 */
export const DesktopVisualAcknowledgementSchema = z
  .object({
    binding: VisualBindingSchema,
    sequence: z.number().int().positive(),
    stateRevision: VisualRevisionSchema.nullable(),
  })
  .strict();
export type DesktopVisualMount = z.infer<typeof DesktopVisualMountSchema>;
export type DesktopVisualBoundsUpdate = z.infer<typeof DesktopVisualBoundsUpdateSchema>;
export type DesktopVisualCommand = z.infer<typeof DesktopVisualCommandSchema>;
export type DesktopVisualState = z.infer<typeof DesktopVisualStateSchema>;
export type DesktopVisualAddress = z.infer<typeof DesktopVisualAddressSchema>;
export type DesktopVisualAcknowledgement = z.infer<typeof DesktopVisualAcknowledgementSchema>;
export interface DesktopVisualBridge {
  mount(input: DesktopVisualMount): Promise<void>;
  bounds(input: DesktopVisualBoundsUpdate): Promise<void>;
  command(input: DesktopVisualCommand): Promise<void>;
  restore(input: DesktopVisualState): Promise<void>;
  acknowledge(input: DesktopVisualAcknowledgement): Promise<void>;
  dispose(input: DesktopVisualAddress): Promise<void>;
}

/** Bound on one document-to-host message relayed by the Android visual host (bridge limit is 64 KiB). */
export const ANDROID_VISUAL_MESSAGE_CHARS = 128 * 1024;
const AndroidVisualSessionSchema = z.string().uuid();
const AndroidVisualTextSchema = z.string().min(1).max(2048);
// Events emitted by the Paseo Android visual host view. They come from trusted native code, but
// every field is still checked: the document message text originates in the untrusted document.
export const AndroidVisualHostEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("attached"), session: AndroidVisualSessionSchema }),
  z.object({
    type: z.literal("message"),
    session: AndroidVisualSessionSchema,
    data: z.string().min(1).max(ANDROID_VISUAL_MESSAGE_CHARS),
  }),
  z.object({
    type: z.literal("capture"),
    session: AndroidVisualSessionSchema,
    request: z.string().uuid(),
    data: VisualCaptureSchema.shape.data,
    width: z.number().int().positive().max(VISUAL_CAPTURE_DIMENSION),
    height: z.number().int().positive().max(VISUAL_CAPTURE_DIMENSION),
    density: z.number().positive().max(4),
  }),
  z.object({
    type: z.literal("captureFailed"),
    session: AndroidVisualSessionSchema,
    request: z.string().uuid(),
    message: AndroidVisualTextSchema,
  }),
  z.object({
    type: z.literal("error"),
    session: AndroidVisualSessionSchema,
    code: z.string().min(1).max(128),
    message: AndroidVisualTextSchema,
  }),
  z.object({ type: z.literal("activity"), session: AndroidVisualSessionSchema }),
]);
export type AndroidVisualHostEvent = z.infer<typeof AndroidVisualHostEventSchema>;

export type VisualRenderDocument = z.infer<typeof VisualRenderDocumentSchema>;
export type VisualView = z.infer<typeof VisualViewSchema>;
export type VisualCommand = z.infer<typeof VisualCommandSchema>;
export type VisualEvent = z.infer<typeof VisualEventSchema>;
export type VisualReceipt = z.infer<typeof VisualReceiptSchema>;
export type VisualSubscribeRequest = z.infer<typeof VisualSubscribeRequestSchema>;
export type VisualReceiptRequest = z.infer<typeof VisualReceiptRequestSchema>;
export type VisualWireView = z.infer<typeof VisualWireViewSchema>;
export type VisualWireEvent = z.infer<typeof VisualWireEventSchema>;
type WireRenderDocument = z.infer<typeof WireRenderDocumentSchema>;

function encodeJson(value: unknown): string {
  assertVisualJsonBound(value);
  return JSON.stringify(value);
}
function decodeJson(text: string): z.infer<ReturnType<typeof z.json>> {
  if (new TextEncoder().encode(text).byteLength > VISUAL_SNAPSHOT_BYTES) {
    throw new VisualFailure("INVALID_DATA", "Visual wire JSON exceeds its byte limit");
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw new VisualFailure("INVALID_DATA", "Malformed visual wire JSON");
  }
  assertVisualJsonBound(value);
  return z.json().parse(value);
}
function encodeDocument(current: VisualRenderDocument): WireRenderDocument {
  const { snapshot, ...document } = current.document;
  return {
    binding: current.binding,
    document: { ...document, snapshotJson: encodeJson(snapshot) },
  };
}
function decodeDocument(current: WireRenderDocument): VisualRenderDocument {
  const { snapshotJson, ...document } = current.document;
  return {
    binding: current.binding,
    document: { ...document, snapshot: parseVisualSnapshot(decodeJson(snapshotJson)) },
  };
}
export function encodeVisualView(view: VisualView): VisualWireView {
  return { ...view, current: view.current ? encodeDocument(view.current) : null };
}
export function decodeVisualView(view: VisualWireView): VisualView {
  return { ...view, current: view.current ? decodeDocument(view.current) : null };
}
export function encodeVisualEvent(event: VisualEvent): VisualWireEvent {
  if (event.kind === "snapshot") return { kind: "snapshot", view: encodeVisualView(event.view) };
  if (event.kind === "speech") return event;
  const command = event.command;
  if (command.kind === "render")
    return { ...event, command: { ...command, current: encodeDocument(command.current) } };
  if (command.kind === "act") {
    const { value, ...rest } = command;
    return { ...event, command: { ...rest, valueJson: encodeJson(value) } };
  }
  return { ...event, command };
}
export function decodeVisualEvent(event: VisualWireEvent): VisualEvent {
  if (event.kind === "snapshot") return { kind: "snapshot", view: decodeVisualView(event.view) };
  if (event.kind === "speech") return event;
  const command = event.command;
  if (command.kind === "render")
    return { ...event, command: { ...command, current: decodeDocument(command.current) } };
  if (command.kind === "act") {
    const { valueJson, ...rest } = command;
    return { ...event, command: { ...rest, value: decodeJson(valueJson) } };
  }
  return { ...event, command };
}
