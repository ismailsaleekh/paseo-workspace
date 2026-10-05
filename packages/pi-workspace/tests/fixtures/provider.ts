import { appendFileSync } from "node:fs";
import { z } from "zod";
import {
  createAssistantMessageEventStream,
  getCurrentTools,
  type AssistantMessage,
  type TextContent,
  type ImageContent,
  type ToolCall,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const CallSchema = z
  .object({
    name: z.enum([
      "visual_present",
      "visual_update",
      "visual_act",
      "visual_inspect",
      "visual_list",
      "speak",
      "branch_open",
      "branch_return",
    ]),
    arguments: z.record(z.string(), z.json()),
  })
  .strict();
const usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function userText(content: string | readonly (TextContent | ImageContent)[]): string {
  return typeof content === "string"
    ? content
    : content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n");
}

export default function registerTestProvider(pi: ExtensionAPI): void {
  let request = 0;
  pi.registerProvider("pi-workspace-tests", {
    api: "pi-workspace-tests-stream",
    apiKey: "offline-fixture",
    baseUrl: "http://127.0.0.1:1",
    models: [
      {
        id: "scripted",
        name: "Scripted visual test",
        reasoning: false,
        input: ["text"],
        contextWindow: 131072,
        maxTokens: 1024,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
    ],
    streamSimple(model, context, options) {
      request += 1;
      const trace = process.env["PI_WORKSPACE_TEST_TRACE"];
      if (!trace) throw new Error("Test provider requires an isolated trace path");
      appendFileSync(
        trace,
        JSON.stringify({
          tools: getCurrentTools(context.messages).map((tool) => tool.name),
          messages: context.messages,
        }) + "\n",
      );
      const lastUser = context.messages.findLastIndex(
        (message) =>
          message.role === "user" &&
          !userText(message.content).startsWith("<pi-workspace-context>"),
      );
      const user = context.messages[lastUser];
      if (!user || user.role !== "user") throw new Error("Test request has no user message");
      const text = userText(user.content);
      const completed = context.messages
        .slice(lastUser + 1)
        .some((message) => message.role === "toolResult");
      let content: Array<TextContent | ToolCall>;
      let stopReason: "stop" | "toolUse";
      if (completed) {
        content = [{ type: "text", text: "TEST_TOOL_COMPLETE" }];
        stopReason = "stop";
      } else if (text.startsWith("call:")) {
        const parsed: unknown = JSON.parse(text.slice(5));
        const call = CallSchema.parse(parsed);
        content = [
          { type: "toolCall", id: `test-${request}`, name: call.name, arguments: call.arguments },
        ];
        stopReason = "toolUse";
      } else {
        content = [{ type: "text", text }];
        stopReason = "stop";
      }
      const message: AssistantMessage = {
        role: "assistant",
        api: model.api,
        provider: model.provider,
        model: model.id,
        timestamp: request,
        content,
        stopReason,
        usage,
      };
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        if (options?.signal?.aborted) {
          const aborted: AssistantMessage = {
            ...message,
            content: [],
            stopReason: "aborted",
            errorMessage: "Test provider aborted",
          };
          stream.push({ type: "error", reason: "aborted", error: aborted });
          stream.end(aborted);
          return;
        }
        stream.push({ type: "start", partial: message });
        content.forEach((block, contentIndex) => {
          if (block.type === "toolCall") {
            stream.push({ type: "toolcall_start", contentIndex, partial: message });
            stream.push({
              type: "toolcall_delta",
              contentIndex,
              delta: JSON.stringify(block.arguments),
              partial: message,
            });
            stream.push({ type: "toolcall_end", contentIndex, toolCall: block, partial: message });
          } else {
            stream.push({ type: "text_start", contentIndex, partial: message });
            stream.push({ type: "text_delta", contentIndex, delta: block.text, partial: message });
            stream.push({ type: "text_end", contentIndex, content: block.text, partial: message });
          }
        });
        stream.push({ type: "done", reason: stopReason, message });
        stream.end(message);
      });
      return stream;
    },
  });
}
