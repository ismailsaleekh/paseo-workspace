// Judge-owned deterministic provider. It never calls a network model or registers product tools.
import { appendFileSync, readFileSync, watch } from "node:fs";
import { createAssistantMessageEventStream, getCurrentTools } from "@earendil-works/pi-ai";

const providerId = "pi-background-oracle";
const modelId = "scripted";
const allowedTools = new Set([
  "bg_run",
  "bg_status",
  "bg_logs",
  "bg_kill",
  "bg_result",
  "bg_delegate",
  "bg_run_pi_attested",
  "fusion_reason",
  "fusion_investigate",
  "fusion_research",
  "fusion_validate",
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
      text.startsWith("oracle-text:") ||
      text.startsWith("oracle-hold:")
    );
  });
  if (requestIndex < 0) throw new Error("No scripted oracle request in this conversation");
  if (messages.slice(requestIndex + 1).some((message) => message.role === "toolResult")) {
    return { content: [{ type: "text", text: "ORACLE_TOOL_COMPLETE" }], stopReason: "stop" };
  }
  const text = textOf(messages[requestIndex].content);
  if (text.startsWith("oracle-hold:")) {
    return {
      content: [{ type: "text", text: "ORACLE_HOLD_FINISHED" }],
      stopReason: "stop",
      hold: true,
    };
  }
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

function holdUntilReleased(stream, message, signal) {
  const gate = process.env.PI_BG_ORACLE_GATE;
  if (!gate) throw new Error("The held scripted response requires its test-owned gate file");
  let settled = false;
  const observer = watch(gate, check);
  const deadline = setTimeout(() => fail("Oracle gate was not released within 30 seconds"), 30000);
  const aborted = () => fail("Oracle held response aborted", "aborted");
  function cleanup() {
    observer.close();
    clearTimeout(deadline);
    signal?.removeEventListener("abort", aborted);
  }
  function fail(reason, stopReason = "error") {
    if (settled) return;
    settled = true;
    cleanup();
    const error = { ...message, content: [], stopReason, errorMessage: reason };
    stream.push({ type: "error", reason: stopReason, error });
    stream.end(error);
  }
  function check() {
    if (settled) return;
    try {
      if (readFileSync(gate, "utf8") !== "open") return;
      settled = true;
      cleanup();
      stream.push({ type: "done", reason: "stop", message });
      stream.end(message);
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
  }
  observer.on("error", (error) => fail(error.message));
  signal?.addEventListener("abort", aborted, { once: true });
  if (signal?.aborted) aborted();
  else check();
}

export default function registerOracleProvider(pi) {
  let requestNumber = 0;
  pi.registerProvider(providerId, {
    api: "pi-background-oracle-stream",
    apiKey: "offline-test-fixture-not-a-credential",
    baseUrl: "http://127.0.0.1:1",
    models: [
      {
        id: modelId,
        name: "Offline background jobs oracle",
        reasoning: false,
        input: ["text", "image"],
        contextWindow: 131072,
        maxTokens: 1024,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
      {
        id: "child-model",
        name: "Offline child model",
        reasoning: false,
        input: ["text"],
        contextWindow: 131072,
        maxTokens: 4096,
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
        if (response.hold) {
          holdUntilReleased(stream, message, options?.signal);
        } else {
          stream.push({ type: "done", reason: response.stopReason, message });
          stream.end(message);
        }
      });
      return stream;
    },
  });
}
