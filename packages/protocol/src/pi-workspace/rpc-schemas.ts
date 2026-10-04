import { z } from "zod";
import {
  VisualActionsSchema,
  VisualBindingSchema,
  VisualDocumentSchema,
  VisualErrorSchema,
  VisualSnapshotSchema,
  VisualFailure,
  VISUAL_SNAPSHOT_BYTES,
  assertVisualJsonBound,
  parseVisualSnapshot,
} from "./contracts.js";

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
]);
export const VisualReceiptSchema = z
  .object({
    binding: VisualBindingSchema,
    commandId: z.string().uuid().nullable(),
    sequence: z.number().int().positive(),
    snapshot: VisualSnapshotSchema,
    actions: VisualActionsSchema,
    error: VisualErrorSchema.nullable(),
  })
  .strict();

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
]);

export const VisualSubscribeRequestSchema = z.object({
  type: z.literal("pi_workspace.observe.request"),
  requestId: z.string(),
  agentId: z.string().min(1).max(256),
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
  receipt: VisualReceiptSchema,
});
export const VisualReceiptResponseSchema = z.object({
  type: z.literal("pi_workspace.receipt.response"),
  payload: z.object({
    requestId: z.string(),
    agentId: z.string(),
    stateRevision: z.number().int().positive(),
  }),
});

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
  const command = event.command;
  if (command.kind === "render")
    return { ...event, command: { ...command, current: decodeDocument(command.current) } };
  if (command.kind === "act") {
    const { valueJson, ...rest } = command;
    return { ...event, command: { ...rest, value: decodeJson(valueJson) } };
  }
  return { ...event, command };
}
