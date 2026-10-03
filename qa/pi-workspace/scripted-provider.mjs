// Judge-owned deterministic provider. It never calls a network model or registers product tools.
import { appendFileSync } from "node:fs";
import { createAssistantMessageEventStream, getCurrentTools } from "@earendil-works/pi-ai";

const providerId = "pi-workspace-oracle";
const modelId = "scripted";
const allowedTools = new Set([
  "hello",
  "visual_present",
  "visual_update",
  "visual_act",
  "visual_inspect",
  "visual_list",
  "speak",
  "branch_open",
  "branch_return",
]);
const zeroUsage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) throw new Error("Oracle received invalid message content");
  return content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

function readCall(value, index, requestNumber) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Oracle call must be an object");
  }
  const keys = Object.keys(value).sort();
  if (keys.join(",") !== "arguments,name" || !allowedTools.has(value.name)) {
    throw new Error("Oracle call has an unexpected tool or field");
  }
  if (
    value.arguments === null ||
    typeof value.arguments !== "object" ||
    Array.isArray(value.arguments)
  ) {
    throw new Error("Oracle tool arguments must be an object");
  }
  return {
    type: "toolCall",
    id: `oracle-${requestNumber}-${index}`,
    name: value.name,
    arguments: value.arguments,
  };
}

function chooseResponse(messages, requestNumber) {
  // Workspace context can follow the driver's user message without being another user request.
  const requestIndex = messages.findLastIndex((message) => {
    if (message.role !== "user") return false;
    const text = textOf(message.content);
    return (
      text.startsWith("oracle-call:") ||
      text.startsWith("oracle-batch:") ||
      text.startsWith("oracle-text:")
    );
  });
  if (requestIndex < 0) throw new Error("No scripted oracle request in this conversation");
  if (messages.slice(requestIndex + 1).some((message) => message.role === "toolResult")) {
    return { content: [{ type: "text", text: "ORACLE_TOOL_COMPLETE" }], stopReason: "stop" };
  }
  const text = textOf(messages[requestIndex].content);
  if (text.startsWith("oracle-text:")) {
    return {
      content: [{ type: "text", text: text.slice("oracle-text:".length) }],
      stopReason: "stop",
    };
  }
  const single = "oracle-call:";
  const batch = "oracle-batch:";
  let calls;
  if (text.startsWith(single)) {
    calls = [JSON.parse(text.slice(single.length))];
  } else if (text.startsWith(batch)) {
    calls = JSON.parse(text.slice(batch.length));
    if (!Array.isArray(calls) || calls.length === 0)
      throw new Error("Oracle batch is empty or invalid");
  } else {
    throw new Error(`Unscripted oracle request: ${text.slice(0, 160)}`);
  }
  return {
    content: calls.map((call, index) => readCall(call, index, requestNumber)),
    stopReason: "toolUse",
  };
}

export default function registerOracleProvider(pi) {
  let requestNumber = 0;
  pi.registerProvider(providerId, {
    api: "pi-workspace-oracle-stream",
    apiKey: "offline-test-fixture-not-a-credential",
    baseUrl: "http://127.0.0.1:1",
    models: [
      {
        id: modelId,
        name: "Offline workspace oracle",
        reasoning: false,
        input: ["text", "image"],
        contextWindow: 131072,
        maxTokens: 1024,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
    ],
    streamSimple(model, context, options) {
      const tracePath = process.env.PI_WORKSPACE_ORACLE_TRACE;
      if (!tracePath) throw new Error("The oracle requires a test-owned trace file");
      requestNumber += 1;
      const response = chooseResponse(context.messages, requestNumber);
      appendFileSync(
        tracePath,
        JSON.stringify({
          requestNumber,
          provider: model.provider,
          model: model.id,
          tools: getCurrentTools(context.messages).map((tool) => tool.name),
          messages: context.messages,
          response,
        }) + "\n",
      );
      const stream = createAssistantMessageEventStream();
      const message = {
        role: "assistant",
        api: model.api,
        provider: model.provider,
        model: model.id,
        content: response.content,
        stopReason: response.stopReason,
        usage: zeroUsage,
        timestamp: requestNumber,
      };
      queueMicrotask(() => {
        if (options?.signal?.aborted) {
          const aborted = {
            ...message,
            content: [],
            stopReason: "aborted",
            errorMessage: "Oracle aborted",
          };
          stream.push({ type: "error", reason: "aborted", error: aborted });
          stream.end(aborted);
          return;
        }
        stream.push({ type: "start", partial: message });
        response.content.forEach((block, contentIndex) => {
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
        stream.push({ type: "done", reason: response.stopReason, message });
        stream.end(message);
      });
      return stream;
    },
  });
}
