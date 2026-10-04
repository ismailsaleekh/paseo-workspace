import { Type, type TSchema } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { z } from "zod";
import {
  VisualFailure,
  VisualIdSchema,
  VisualRevisionSchema,
  VisualResultSchema,
  VISUAL_SOURCE_BYTES,
  assertVisualJsonBound,
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
  { id: Type.Optional(Id), screenshot: Type.Optional(Type.Boolean()) },
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
      Type.Object({ id: Id, generation: Id, nonce: Id }, objectOptions),
      Type.Null(),
    ]),
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
  .object({ id: VisualIdSchema.optional(), screenshot: z.boolean().optional() })
  .strict();
const ListInputSchema = z.object({ cursor: VisualIdSchema.optional() }).strict();
export type VisualToolDetails =
  | Exclude<VisualResult, { kind: "context" }>
  | { kind: "error"; error: { code: string; message: string }; id: string | null };
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
      return { kind: "inspect", id: value.id ?? null, screenshot: value.screenshot ?? false };
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
    assertVisualJsonBound(received, 128 * 1024);
    const parsed = VisualResultSchema.safeParse(received);
    if (!parsed.success || parsed.data.kind === "context")
      throw new VisualFailure("INVALID_REPLY", "Visual host returned an invalid tool result");
    const result = parsed.data;
    if ((input.name === "visual_list") !== (result.kind === "list"))
      throw new VisualFailure("INVALID_REPLY", "Visual host returned the wrong result kind");
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

export interface VisualToolDefinitionInput<T extends TSchema> {
  name: VisualToolName;
  description: string;
  parameters: T;
  connection: VisualToolConnection;
  bind(sessionId: string): void;
}

export function createVisualTool<T extends TSchema>(
  input: VisualToolDefinitionInput<T>,
): ToolDefinition<T, VisualToolDetails, unknown> {
  return {
    name: input.name,
    label: input.name,
    description: input.description,
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
      return {
        content: [{ type: "text", text: JSON.stringify(details) }],
        details,
        structuredContent: details,
        isError: details.kind === "error",
      };
    },
  };
}
