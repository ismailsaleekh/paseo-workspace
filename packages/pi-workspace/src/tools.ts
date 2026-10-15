import { Type, type TSchema } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { z } from "zod";
import {
  VisualFailure,
  VisualIdSchema,
  VisualDisplayIdSchema,
  VisualRevisionSchema,
  VisualResultSchema,
  VISUAL_SOURCE_BYTES,
  VISUAL_FRAME_BYTES,
  VISUAL_CAPTURE_DIMENSION,
  parseVisualSnapshot,
  parseVisualActions,
  assertVisualJsonBound,
  type VisualRecord,
  type VisualScreenshot,
  type VisualOperation,
  type VisualResult,
} from "@getpaseo/protocol/pi-workspace/contracts";
import type { VisualToolConnection } from "./connection.js";
import { readVisualSource } from "./source.js";

export type VisualToolName =
  | "visual_present"
  | "visual_update"
  | "visual_act"
  | "visual_inspect"
  | "visual_list";
const Title = Type.String({ minLength: 1, maxLength: 256 });
const Id = Type.String({ minLength: 1, maxLength: 256 });
const Html = Type.String({ minLength: 1, maxLength: VISUAL_SOURCE_BYTES });
const File = Type.String({ minLength: 1, maxLength: 4096 });
const Revision = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
const objectOptions = { additionalProperties: false };
export const presentParameters = Type.Union([
  Type.Object({ mode: Type.Literal("new"), title: Title, html: Html }, objectOptions),
  Type.Object({ mode: Type.Literal("new"), title: Title, file: File }, objectOptions),
  Type.Object({ mode: Type.Literal("open"), id: Id }, objectOptions),
]);
export const updateParameters = Type.Union([
  Type.Object({ id: Id, revision: Revision, html: Html }, objectOptions),
  Type.Object({ id: Id, revision: Revision, file: File }, objectOptions),
]);
export const actParameters = Type.Object(
  {
    id: Id,
    action: Type.String({ minLength: 1, maxLength: 128 }),
    value: Type.Optional(Type.Unknown()),
  },
  objectOptions,
);
export const inspectParameters = Type.Object(
  { id: Type.Optional(Id), screenshot: Type.Optional(Type.Boolean()), client: Type.Optional(Id) },
  objectOptions,
);
export const listParameters = Type.Object({ cursor: Type.Optional(Id) }, objectOptions);
const ErrorOutput = Type.Object(
  {
    kind: Type.Literal("error"),
    error: Type.Object({ code: Type.String(), message: Type.String() }, objectOptions),
    id: Type.Union([Type.String(), Type.Null()]),
  },
  objectOptions,
);
const VisualOutput = Type.Object(
  {
    kind: Type.Literal("visual"),
    id: Id,
    title: Title,
    revision: Revision,
    stateRevision: Revision,
    status: Type.Union([
      Type.Literal("stored"),
      Type.Literal("rendered"),
      Type.Literal("disconnected"),
      Type.Literal("error"),
    ]),
    client: Type.Union([
      Id,
      Type.Object({ id: Id, generation: Id, nonce: Id }, objectOptions),
      Type.Null(),
    ]),
    displays: Type.Optional(
      Type.Array(
        Type.Object(
          {
            client: Id,
            platform: Type.Union([
              Type.Literal("electron"),
              Type.Literal("android"),
              Type.Literal("web"),
              Type.Literal("ios"),
            ]),
            active: Type.Boolean(),
          },
          objectOptions,
        ),
        { maxItems: 64 },
      ),
    ),
    screenshot: Type.Optional(
      Type.Object(
        {
          client: Id,
          mimeType: Type.Literal("image/png"),
          width: Type.Integer({ minimum: 1, maximum: VISUAL_CAPTURE_DIMENSION }),
          height: Type.Integer({ minimum: 1, maximum: VISUAL_CAPTURE_DIMENSION }),
          viewport: Type.Object(
            {
              width: Type.Integer({ minimum: 1, maximum: VISUAL_CAPTURE_DIMENSION }),
              height: Type.Integer({ minimum: 1, maximum: VISUAL_CAPTURE_DIMENSION }),
            },
            objectOptions,
          ),
          pixelRatio: Type.Number({ exclusiveMinimum: 0, maximum: 4 }),
          revision: Revision,
          stateRevision: Revision,
        },
        objectOptions,
      ),
    ),
    state: Type.Unknown(),
    selection: Type.Unknown(),
    actions: Type.Record(
      Type.String(),
      Type.Object(
        { description: Type.String(), parameters: Type.Record(Type.String(), Type.Unknown()) },
        objectOptions,
      ),
    ),
    error: Type.Union([
      Type.Object({ code: Type.String(), message: Type.String() }, objectOptions),
      Type.Null(),
    ]),
  },
  objectOptions,
);
const ListOutput = Type.Object(
  {
    kind: Type.Literal("list"),
    items: Type.Array(
      Type.Object(
        { id: Id, title: Title, revision: Revision, status: Type.String() },
        objectOptions,
      ),
      { maxItems: 50 },
    ),
    nextCursor: Type.Union([Id, Type.Null()]),
  },
  objectOptions,
);
const outputSchema = Type.Union([VisualOutput, ListOutput, ErrorOutput]);

const htmlInput = z.string().min(1).max(VISUAL_SOURCE_BYTES);
const fileInput = z.string().min(1).max(4096);
const titleInput = z.string().min(1).max(256);
const PresentInputSchema = z.union([
  z.object({ mode: z.literal("new"), title: titleInput, html: htmlInput }).strict(),
  z.object({ mode: z.literal("new"), title: titleInput, file: fileInput }).strict(),
  z.object({ mode: z.literal("open"), id: VisualIdSchema }).strict(),
]);
const UpdateInputSchema = z.union([
  z.object({ id: VisualIdSchema, revision: VisualRevisionSchema, html: htmlInput }).strict(),
  z.object({ id: VisualIdSchema, revision: VisualRevisionSchema, file: fileInput }).strict(),
]);
const ActInputSchema = z
  .object({ id: VisualIdSchema, action: z.string().min(1).max(128), value: z.json().optional() })
  .strict();
const InspectInputSchema = z
  .object({
    id: VisualIdSchema.optional(),
    screenshot: z.boolean().optional(),
    client: VisualDisplayIdSchema.optional(),
  })
  .strict();
const ListInputSchema = z.object({ cursor: VisualIdSchema.optional() }).strict();
export type VisualToolDetails =
  | Exclude<VisualResult, { kind: "context" }>
  | { kind: "error"; error: { code: string; message: string }; id: string | null };
export type VisualPublicDetails =
  | (Omit<VisualRecord, "capture"> & { screenshot?: VisualScreenshot })
  | Extract<VisualToolDetails, { kind: "list" | "error" }>;
type VisualToolResult = Awaited<
  ReturnType<ToolDefinition<TSchema, VisualPublicDetails>["execute"]>
>;

export interface ExecuteVisualToolInput {
  name: VisualToolName;
  input: unknown;
  cwd: string;
  connection: VisualToolConnection;
  signal: AbortSignal | undefined;
}

async function operation(input: ExecuteVisualToolInput): Promise<VisualOperation> {
  switch (input.name) {
    case "visual_present": {
      const value = PresentInputSchema.parse(input.input);
      if (value.mode === "open") return { kind: "open", id: value.id };
      const source = "html" in value ? { html: value.html } : { file: value.file };
      const html = await readVisualSource({
        source,
        cwd: input.cwd,
        ...(input.signal ? { signal: input.signal } : {}),
      });
      return { kind: "present", title: value.title, html };
    }
    case "visual_update": {
      const value = UpdateInputSchema.parse(input.input);
      const source = "html" in value ? { html: value.html } : { file: value.file };
      const html = await readVisualSource({
        source,
        cwd: input.cwd,
        ...(input.signal ? { signal: input.signal } : {}),
      });
      return { kind: "update", id: value.id, revision: value.revision, html };
    }
    case "visual_act": {
      assertVisualJsonBound(input.input);
      const value = ActInputSchema.parse(input.input);
      return {
        kind: "act",
        id: value.id,
        action: value.action,
        value: value.value === undefined ? null : value.value,
      };
    }
    case "visual_inspect": {
      const value = InspectInputSchema.parse(input.input);
      return {
        kind: "inspect",
        id: value.id ?? null,
        screenshot: value.screenshot ?? false,
        ...(value.client === undefined ? {} : { client: value.client }),
      };
    }
    case "visual_list": {
      const value = ListInputSchema.parse(input.input);
      return { kind: "list", cursor: value.cursor ?? null };
    }
  }
}

export async function executeVisualTool(input: ExecuteVisualToolInput): Promise<VisualToolDetails> {
  try {
    if (input.signal?.aborted)
      throw new VisualFailure("CANCELLED", "Visual operation was cancelled");
    const request = await operation(input);
    const received: unknown = await input.connection.request(request, input.signal);
    assertVisualJsonBound(received, VISUAL_FRAME_BYTES);
    const parsed = VisualResultSchema.safeParse(received);
    if (!parsed.success || parsed.data.kind === "context")
      throw new VisualFailure("INVALID_REPLY", "Visual host returned an invalid tool result");
    const result = parsed.data;
    validateToolReply(request, result);
    return result;
  } catch (error) {
    if (error instanceof VisualFailure)
      return {
        kind: "error",
        error: { code: error.code, message: error.message },
        id: error.artifactId,
      };
    if (error instanceof z.ZodError)
      return {
        kind: "error",
        error: {
          code: "INVALID_ARGUMENT",
          message: "Visual tool arguments do not match the declared schema",
        },
        id: null,
      };
    throw error;
  }
}

function validateToolReply(
  request: VisualOperation,
  result: Exclude<VisualResult, { kind: "context" }>,
): void {
  if ((request.kind === "list") !== (result.kind === "list"))
    throw new VisualFailure("INVALID_REPLY", "Visual host returned the wrong result kind");
  if (result.kind !== "visual") return;
  parseVisualSnapshot({ state: result.state, selection: result.selection });
  parseVisualActions(result.actions);
  if (
    request.kind === "inspect" &&
    request.client !== undefined &&
    result.client !== request.client
  )
    throw new VisualFailure("INVALID_REPLY", "Visual host answered from a different display");
  const capture = result.capture;
  if (!capture) return;
  const valid =
    request.kind === "inspect" &&
    request.screenshot &&
    capture.binding.id === result.id &&
    capture.screenshot.client === result.client &&
    capture.screenshot.revision === result.revision &&
    capture.screenshot.stateRevision === result.stateRevision;
  if (!valid)
    throw new VisualFailure(
      "INVALID_REPLY",
      "Capture identity does not match the inspected visual",
    );
}

export function visualToolResult(result: VisualToolDetails): VisualToolResult {
  if (result.kind !== "visual" || !result.capture) {
    return {
      content: [{ type: "text", text: JSON.stringify(result) }],
      details: result,
      structuredContent: z.json().parse(result),
      isError: result.kind === "error",
    };
  }
  const { capture, ...record } = result;
  const details: VisualPublicDetails = { ...record, screenshot: capture.screenshot };
  return {
    content: [
      { type: "text", text: JSON.stringify(details) },
      { type: "image", mimeType: "image/png", data: capture.data },
    ],
    details,
    structuredContent: z.json().parse(details),
    isError: false,
  };
}

/** Paseo's chat shows images and plays videos that a reply embeds; added only while attached. */
export const MEDIA_PROMPT_GUIDELINE =
  "To show the user an image or video file from this computer, embed it in your reply as Markdown: ![title](</absolute/path>). The Paseo chat shows images (.png .jpg .gif .webp .svg) and plays videos (.mp4 .mov .m4v .webm) exactly as they are; make a smaller copy only when the user asks.";

export interface VisualToolDefinitionInput<T extends TSchema> {
  name: VisualToolName;
  description: string;
  /** System-prompt guideline bullets, present while this tool is active. */
  promptGuidelines?: string[];
  parameters: T;
  connection: VisualToolConnection;
  bind(sessionId: string): void;
}

export function createVisualTool<T extends TSchema>(
  input: VisualToolDefinitionInput<T>,
): ToolDefinition<T, VisualPublicDetails, unknown> {
  return {
    name: input.name,
    label: input.name,
    description: input.description,
    ...(input.promptGuidelines ? { promptGuidelines: input.promptGuidelines } : {}),
    parameters: input.parameters,
    outputSchema,
    exposure: "direct",
    executionMode: "sequential",
    async execute(_id, args, signal, _onUpdate, ctx) {
      input.bind(ctx.sessionManager.getSessionId());
      const details = await executeVisualTool({
        name: input.name,
        input: args,
        signal,
        cwd: ctx.cwd,
        connection: input.connection,
      });
      return visualToolResult(details);
    },
  };
}
