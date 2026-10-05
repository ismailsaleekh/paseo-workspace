// Judge-owned Pi extension fixture for S1: a tool that keeps the agent busy until the judge
// removes a marker file, so input-while-busy can be observed. It uses the judge-only tool name
// "hello" that the frozen scripted provider already allows; it is never a product tool.
import { existsSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";

export default function s1BusyFixture(pi) {
  pi.registerTool({
    name: "hello",
    label: "Judge busy fixture (S1)",
    description: "Judge-only fixture that stays running while a marker file exists",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    async execute(_id, _input, signal) {
      const marker = process.env.PI_WORKSPACE_S1_BUSY_MARKER;
      if (!marker) throw new Error("PI_WORKSPACE_S1_BUSY_MARKER is not set");
      const started = Date.now();
      while (existsSync(marker)) {
        if (signal?.aborted) throw new Error("judge busy fixture aborted");
        if (Date.now() - started > 300_000) throw new Error("judge busy marker was never released");
        await delay(200);
      }
      return {
        content: [{ type: "text", text: "JUDGE_BUSY_DONE" }],
        details: { waitedMs: Date.now() - started },
      };
    },
  });
}
