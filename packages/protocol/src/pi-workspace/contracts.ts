import { z } from "zod";

export const VISUAL_SOURCE_BYTES = 1024 * 1024;
export const VISUAL_FRAME_BYTES = 4 * 1024 * 1024;
export const VISUAL_SNAPSHOT_BYTES = 32 * 1024;
export const VISUAL_JSON_DEPTH = 16;
export const VISUAL_ACTION_LIMIT = 64;
export const VISUAL_OPERATION_TIMEOUT_MS = 15_000;
export const VISUAL_PROTOCOL_VERSION = 1;
export const VISUAL_CAPTURE_BYTES = 2 * 1024 * 1024;
export const VISUAL_CAPTURE_DIMENSION = 4096;

export const VisualIdSchema = z.string().uuid();
export const VisualRevisionSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const VisualOwnerSchema = z
  .object({
    agentId: z.string().min(1).max(256),
    sessionId: z.string().min(1).max(256),
  })
  .strict();
export const VisualSnapshotSchema = z
  .object({
    state: z.json(),
    selection: z.json(),
  })
  .strict();
export const VisualActionSchema = z
  .object({
    description: z.string().min(1).max(1024),
    parameters: z.record(z.string(), z.json()),
  })
  .strict();
export const VisualActionsSchema = z.record(z.string().min(1).max(128), VisualActionSchema);
export const VisualErrorSchema = z
  .object({
    code: z.string().min(1).max(128),
    message: z.string().min(1).max(2048),
  })
  .strict();
export const VisualBindingSchema = z
  .object({
    id: VisualIdSchema,
    revision: VisualRevisionSchema,
    nonce: z.string().uuid(),
    clientGeneration: z.string().uuid(),
  })
  .strict();
export const VisualDocumentSchema = z
  .object({
    id: VisualIdSchema,
    title: z.string().min(1).max(256),
    revision: VisualRevisionSchema,
    stateRevision: VisualRevisionSchema,
    html: z.string().max(VISUAL_SOURCE_BYTES),
    snapshot: VisualSnapshotSchema,
  })
  .strict();
export const VisualDeliveryStatusSchema = z.enum(["stored", "rendered", "disconnected", "error"]);

export const VisualClientSchema = z
  .object({
    id: z.string().uuid(),
    generation: z.string().uuid(),
    nonce: z.string().uuid(),
  })
  .strict();
export const VisualDisplayIdSchema = z.string().min(1).max(256);
export const VisualPlatformSchema = z.enum(["electron", "android", "web", "ios"]);
export const VisualDisplaySchema = z
  .object({
    client: VisualDisplayIdSchema,
    platform: VisualPlatformSchema,
    active: z.boolean(),
  })
  .strict();
export type VisualPlatform = z.infer<typeof VisualPlatformSchema>;
/** Displays whose trusted host captures the actual displayed document pixels. */
export const VISUAL_CAPTURE_PLATFORMS: ReadonlySet<VisualPlatform> = new Set<VisualPlatform>([
  "electron",
  "android",
]);
/** Displays with a trusted native host that reports activity and visibility outside the document. */
export const VISUAL_HOST_SIGNAL_PLATFORMS: ReadonlySet<VisualPlatform> = new Set<VisualPlatform>([
  "electron",
  "android",
]);
/** The display platform cannot render generated documents (for example a missing Android visual host). */
export const VISUAL_RENDERER_UNAVAILABLE = "RENDERER_UNAVAILABLE";

export const VisualScreenshotSchema = z
  .object({
    client: VisualDisplayIdSchema,
    mimeType: z.literal("image/png"),
    width: z.number().int().positive().max(VISUAL_CAPTURE_DIMENSION),
    height: z.number().int().positive().max(VISUAL_CAPTURE_DIMENSION),
    viewport: z
      .object({
        width: z.number().int().positive().max(VISUAL_CAPTURE_DIMENSION),
        height: z.number().int().positive().max(VISUAL_CAPTURE_DIMENSION),
      })
      .strict(),
    pixelRatio: z.number().positive().max(4),
    revision: VisualRevisionSchema,
    stateRevision: VisualRevisionSchema,
  })
  .strict();
export const VisualCaptureSchema = z
  .object({
    operationId: z.string().uuid(),
    binding: VisualBindingSchema,
    screenshot: VisualScreenshotSchema,
    data: z
      .string()
      .min(4)
      .max(Math.ceil(VISUAL_CAPTURE_BYTES / 3) * 4)
      .regex(/^[A-Za-z0-9+/]+={0,2}$/),
  })
  .strict();
export type VisualScreenshot = z.infer<typeof VisualScreenshotSchema>;
export type VisualCapture = z.infer<typeof VisualCaptureSchema>;

export const VisualRecordSchema = z
  .object({
    kind: z.literal("visual"),
    id: VisualIdSchema,
    title: z.string().min(1).max(256),
    revision: VisualRevisionSchema,
    stateRevision: VisualRevisionSchema,
    status: VisualDeliveryStatusSchema,
    client: z.union([VisualDisplayIdSchema, VisualClientSchema]).nullable(),
    displays: z.array(VisualDisplaySchema).max(64).optional(),
    capture: VisualCaptureSchema.optional(),
    state: z.json(),
    selection: z.json(),
    actions: VisualActionsSchema,
    error: VisualErrorSchema.nullable(),
  })
  .strict();
export const VisualListSchema = z
  .object({
    kind: z.literal("list"),
    items: z
      .array(
        z
          .object({
            id: VisualIdSchema,
            title: z.string().min(1).max(256),
            revision: VisualRevisionSchema,
            status: VisualDeliveryStatusSchema,
          })
          .strict(),
      )
      .max(50),
    nextCursor: VisualIdSchema.nullable(),
  })
  .strict();
export const VisualContextSchema = z
  .object({
    kind: z.literal("context"),
    visual: VisualRecordSchema.nullable(),
  })
  .strict();
export const VisualResultSchema = z.discriminatedUnion("kind", [
  VisualRecordSchema,
  VisualListSchema,
  VisualContextSchema,
]);
export const VisualOperationSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("present"),
      title: z.string().min(1).max(256),
      html: z.string().min(1).max(VISUAL_SOURCE_BYTES),
    })
    .strict(),
  z.object({ kind: z.literal("open"), id: VisualIdSchema }).strict(),
  z
    .object({
      kind: z.literal("update"),
      id: VisualIdSchema,
      revision: VisualRevisionSchema,
      html: z.string().min(1).max(VISUAL_SOURCE_BYTES),
    })
    .strict(),
  z
    .object({
      kind: z.literal("act"),
      id: VisualIdSchema,
      action: z.string().min(1).max(128),
      value: z.json(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("inspect"),
      id: VisualIdSchema.nullable(),
      screenshot: z.boolean(),
      client: VisualDisplayIdSchema.optional(),
    })
    .strict(),
  z.object({ kind: z.literal("list"), cursor: VisualIdSchema.nullable() }).strict(),
  z.object({ kind: z.literal("context") }).strict(),
]);
export const VisualLocalRequestSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("attach"),
      protocol: z.literal(VISUAL_PROTOCOL_VERSION),
      capability: z.string().regex(/^[a-f0-9]{64}$/),
      sessionId: z.string().min(1).max(256),
    })
    .strict(),
  z
    .object({
      kind: z.literal("request"),
      requestId: z.string().uuid(),
      operation: VisualOperationSchema,
    })
    .strict(),
  z.object({ kind: z.literal("cancel"), requestId: z.string().uuid() }).strict(),
]);
export const VisualLocalResponseSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("attached"),
      protocol: z.literal(VISUAL_PROTOCOL_VERSION),
      sessionId: z.string().min(1).max(256),
      generation: z.string().uuid(),
    })
    .strict(),
  z
    .object({ kind: z.literal("result"), requestId: z.string().uuid(), result: VisualResultSchema })
    .strict(),
  z
    .object({
      kind: z.literal("error"),
      requestId: z.string().uuid().nullable(),
      error: VisualErrorSchema,
      artifactId: VisualIdSchema.nullable(),
    })
    .strict(),
]);

export type VisualRecord = z.infer<typeof VisualRecordSchema>;
export type VisualResult = z.infer<typeof VisualResultSchema>;
export type VisualOperation = z.infer<typeof VisualOperationSchema>;
export type VisualLocalRequest = z.infer<typeof VisualLocalRequestSchema>;
export type VisualLocalResponse = z.infer<typeof VisualLocalResponseSchema>;
export type VisualOwner = z.infer<typeof VisualOwnerSchema>;
export type VisualSnapshot = z.infer<typeof VisualSnapshotSchema>;
export type VisualActions = z.infer<typeof VisualActionsSchema>;
export type VisualBinding = z.infer<typeof VisualBindingSchema>;
export type VisualDocument = z.infer<typeof VisualDocumentSchema>;
export type VisualError = z.infer<typeof VisualErrorSchema>;
export type VisualDeliveryStatus = z.infer<typeof VisualDeliveryStatusSchema>;

export class VisualFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly artifactId: string | null = null,
  ) {
    super(message);
    this.name = "VisualFailure";
  }
}

// Check resource bounds before asking recursive schema validators to traverse untrusted data.
export function assertVisualJsonBound(value: unknown, byteLimit = VISUAL_SNAPSHOT_BYTES): void {
  const ancestors = new Set<object>();
  let remainingNodes = byteLimit;
  function visit(node: unknown, depth: number): void {
    remainingNodes -= 1;
    if (depth > VISUAL_JSON_DEPTH || remainingNodes < 0) {
      throw new VisualFailure("INVALID_DATA", "Visual data exceeds its depth or node limit");
    }
    if (node === null || typeof node === "boolean") return;
    if (typeof node === "string") {
      if (node.length > byteLimit)
        throw new VisualFailure("INVALID_DATA", "Visual string is too large");
      return;
    }
    if (typeof node === "number" && Number.isFinite(node)) return;
    if (typeof node !== "object" || ancestors.has(node)) {
      throw new VisualFailure("INVALID_DATA", "Visual data must be finite, acyclic JSON");
    }
    ancestors.add(node);
    if (Array.isArray(node)) {
      for (const item of node) visit(item, depth + 1);
    } else {
      if (
        Object.getPrototypeOf(node) !== Object.prototype &&
        Object.getPrototypeOf(node) !== null
      ) {
        throw new VisualFailure("INVALID_DATA", "Visual data must contain only JSON objects");
      }
      for (const [key, item] of Object.entries(node)) {
        if (key.length > byteLimit)
          throw new VisualFailure("INVALID_DATA", "Visual key is too large");
        visit(item, depth + 1);
      }
    }
    ancestors.delete(node);
  }
  visit(value, 0);
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > byteLimit) {
    throw new VisualFailure("INVALID_DATA", "Visual data exceeds its byte limit");
  }
}

export function parseVisualSnapshot(value: unknown): VisualSnapshot {
  assertVisualJsonBound(value);
  const parsed = VisualSnapshotSchema.safeParse(value);
  if (!parsed.success)
    throw new VisualFailure("INVALID_DATA", "Invalid visual state/selection snapshot");
  return parsed.data;
}

export function parseVisualActions(value: unknown): VisualActions {
  assertVisualJsonBound(value);
  const parsed = VisualActionsSchema.safeParse(value);
  if (!parsed.success || Object.keys(parsed.data).length > VISUAL_ACTION_LIMIT) {
    throw new VisualFailure("INVALID_ACTIONS", "Invalid or excessive visual action declarations");
  }
  return parsed.data;
}

export function validateVisualHtml(html: string): string {
  if (html.length === 0) throw new VisualFailure("INVALID_SOURCE", "Visual HTML must not be empty");
  const bytes = new TextEncoder().encode(html);
  if (bytes.byteLength > VISUAL_SOURCE_BYTES) {
    throw new VisualFailure(
      "SOURCE_TOO_LARGE",
      `Visual HTML exceeds ${VISUAL_SOURCE_BYTES} UTF-8 bytes`,
    );
  }
  // A lone surrogate would otherwise be silently replaced during transport.
  if (new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes) !== html) {
    throw new VisualFailure("INVALID_SOURCE", "Visual HTML must be valid Unicode");
  }
  return html;
}
