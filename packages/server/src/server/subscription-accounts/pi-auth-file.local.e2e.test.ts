import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import pino from "pino";
import { expect, test } from "vitest";
import { z } from "zod";
import { JsonlRpcProcess } from "../agent/providers/jsonl-rpc-process.js";
import { PiAuthFile } from "./pi-auth-file.js";

const State = z.object({
  sessionId: z.string(),
  model: z.object({ id: z.string(), provider: z.string() }),
});
const Messages = z.object({
  messages: z.array(z.object({ role: z.string(), content: z.unknown() })),
});
const OAuth = z.object({
  type: z.literal("oauth"),
  access: z.string(),
  refresh: z.string(),
  expires: z.number(),
});

function credential(account: string, expires = Date.now() + 3600_000) {
  return {
    type: "oauth",
    access: `fixture-${account}`,
    refresh: `fixture-refresh-${account}`,
    expires,
    clientId: `fixture-client-${account}`,
  };
}

async function promptAndSettle(rpc: JsonlRpcProcess, prompt: string): Promise<void> {
  let settled: () => void = () => {
    throw new Error("Settlement listener was not initialized");
  };
  const done = new Promise<void>((resolve) => {
    settled = resolve;
  });
  const unsubscribe = rpc.onMessage((message) => {
    if (message.type === "agent_settled") settled();
  });
  try {
    await rpc.request({ type: "prompt", message: prompt });
    await done;
  } finally {
    unsubscribe();
  }
}

async function respond(rpc: JsonlRpcProcess, prompt: string): Promise<string> {
  await promptAndSettle(rpc, prompt);
  return z
    .object({ text: z.string() })
    .parse(await rpc.request({ type: "get_last_assistant_text" })).text;
}

for (const provider of ["anthropic", "openai"] as const) {
  test(`stock Pi ${provider}: A → B → A uses fresh tokens without changing the session or model`, async () => {
    const binary = process.env.PASEO_TEST_PI_BIN;
    if (!binary)
      throw new Error("Pin installed Pi with PASEO_TEST_PI_BIN; do not use npm's development Pi");
    const home = await mkdtemp(join(tmpdir(), "paseo-stock-pi-"));
    const agentDir = join(home, "agent");
    await mkdir(agentDir, { mode: 0o700 });
    const settings = JSON.stringify({
      packages: [],
      compaction: { enabled: false },
      retry: { enabled: false },
    });
    await writeFile(join(agentDir, "settings.json"), settings, { mode: 0o600 });
    const auth = new PiAuthFile(join(agentDir, "auth.json"), binary);
    await auth.change((records) => {
      records[provider] = credential("A", 1); // The actual Pi refresh path must rotate this.
      records["paseo-saved-B"] = credential("B");
      records["unrelated-provider"] = { type: "api_key", key: "fixture-unrelated" };
    });
    const rpc = new JsonlRpcProcess({
      logger: pino({ level: "silent" }),
      launch: {
        command: binary,
        cwd: home,
        args: [
          "--mode",
          "rpc",
          "--offline",
          "--no-session",
          "--no-extensions",
          "--no-skills",
          "--no-prompt-templates",
          "--no-context-files",
          "--no-themes",
          "--no-tools",
          "--extension",
          fileURLToPath(new URL("./test-utils/stock-pi-provider.ts", import.meta.url)),
          "--provider",
          provider,
          "--model",
          "account-fixture",
          "--thinking",
          "off",
        ],
      },
      spawn: (launch) =>
        spawn(launch.command, launch.args, {
          cwd: launch.cwd,
          env: {
            HOME: home,
            PATH: process.env.PATH ?? "/usr/bin:/bin",
            PI_CODING_AGENT_DIR: agentDir,
            PI_OFFLINE: "1",
            PI_SKIP_VERSION_CHECK: "1",
            OPENAI_API_KEY: "fixture-ambient-must-not-win",
            ANTHROPIC_API_KEY: "fixture-ambient-must-not-win",
          },
          stdio: ["pipe", "pipe", "pipe"],
        }),
    });
    try {
      const before = State.parse(await rpc.request({ type: "get_state" }));
      expect(await respond(rpc, "first")).toBe("fixture-A-renewed");
      const rotated = await auth.read((records) => OAuth.parse(records[provider]));
      expect(rotated.refresh).toBe("fixture-refresh-A-renewed");
      await auth.change((records) => {
        records["paseo-saved-A"] = records[provider];
        records[provider] = records["paseo-saved-B"];
        delete records["paseo-saved-B"];
      });
      expect(await respond(rpc, "second")).toBe("fixture-B");
      await auth.change((records) => {
        records["paseo-saved-B"] = records[provider];
        records[provider] = records["paseo-saved-A"];
        delete records["paseo-saved-A"];
      });
      expect(await respond(rpc, "third")).toBe("fixture-A-renewed");
      expect(State.parse(await rpc.request({ type: "get_state" }))).toEqual(before);
      const history = Messages.parse(await rpc.request({ type: "get_messages" }));
      expect(history.messages.filter((entry) => entry.role === "user")).toHaveLength(3);
      expect(history.messages.filter((entry) => entry.role === "assistant")).toHaveLength(3);
      expect(await readFile(join(agentDir, "settings.json"), "utf8")).toBe(settings);
      expect(await auth.read((records) => records["unrelated-provider"])).toEqual({
        type: "api_key",
        key: "fixture-unrelated",
      });
      expect((await stat(auth.path)).mode & 0o077).toBe(0);
      await auth.change((records) => {
        records[provider] = { ...credential("revoked", 1), refresh: "fixture-revoked" };
      });
      await promptAndSettle(rpc, "must not use ambient API key");
      const failed = z
        .object({
          messages: z.array(z.object({ role: z.string(), errorMessage: z.string().optional() })),
        })
        .parse(await rpc.request({ type: "get_messages" }));
      expect(failed.messages.at(-1)?.errorMessage).toContain("OAuth refresh failed");
    } finally {
      await rpc.close();
      await rm(home, { recursive: true, force: true });
    }
  }, 45_000);
}
