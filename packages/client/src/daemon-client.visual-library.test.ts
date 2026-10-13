import { expect, test } from "vitest";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { DaemonClient, type DaemonTransport } from "./daemon-client";

async function connect(features: Record<string, boolean>) {
  const sent: unknown[] = [];
  let opened: () => void = () => {};
  let receive: (data: unknown) => void = () => {};
  const transport: DaemonTransport = {
    send: (frame) => {
      if (typeof frame !== "string") throw new Error("Unexpected binary frame");
      sent.push(JSON.parse(frame));
    },
    close: () => {},
    onOpen: (handler) => {
      opened = handler;
      return () => {};
    },
    onMessage: (handler) => {
      receive = (data) => handler(data, false);
      return () => {};
    },
    onClose: () => () => {},
    onError: () => () => {},
  };
  const client = new DaemonClient({
    url: "ws://library-port",
    clientId: "library",
    transportFactory: () => transport,
    reconnect: { enabled: false },
  });
  const connecting = client.connect();
  opened();
  const reply = (message: unknown) => receive(JSON.stringify({ type: "session", message }));
  reply({
    type: "status",
    payload: { status: "server_info", serverId: "host", hostname: null, version: null, features },
  });
  await connecting;
  return { client, sent, reply };
}

test("one enhanced observation gate refuses older hosts without emulating or sending prompts", async () => {
  const { client, sent } = await connect({ ownedSubscriptions: true, piWorkspace: true });
  try {
    const observation = client.observePiWorkspace("agent", undefined, "web", true);
    await expect(observation.ready).rejects.toThrow("Update the Paseo host");
    expect(sent).toHaveLength(1); // Hello only; no legacy visual requests or prompts.
  } finally {
    await client.close();
  }
});

test("native library reads and selections stay conversation/generation scoped and propagate refusals without model effects", async () => {
  const { client, sent, reply } = await connect({
    ownedSubscriptions: true,
    piWorkspace: true,
    piVisualLibrary: true,
  });
  const requestSchema = z.object({
    type: z.literal("session"),
    message: z.object({
      type: z.string(),
      requestId: z.string(),
      agentId: z.string(),
      clientGeneration: z.string().optional(),
      operation: z.unknown().optional(),
      library: z.boolean().optional(),
    }),
  });
  try {
    const generation = randomUUID();
    const observation = client.observePiWorkspace("agent", undefined, "web", true);
    const observed = requestSchema.parse(sent.at(-1)).message;
    expect(observed).toMatchObject({
      type: "pi_workspace.observe.request",
      agentId: "agent",
      library: true,
    });
    reply({
      type: "pi_workspace.observe.response",
      payload: {
        requestId: observed.requestId,
        agentId: "agent",
        subscriptionId: "visual-source",
        view: { generation, sequence: 0, current: null, sessionId: "persisted" },
      },
    });
    await observation.ready;
    const reading = client.requestVisualLibrary({
      agentId: "agent",
      clientGeneration: generation,
      operation: { kind: "list" },
    });
    const request = requestSchema.parse(sent.at(-1)).message;
    expect(request).toMatchObject({
      type: "pi_workspace.library.request",
      agentId: "agent",
      clientGeneration: generation,
      operation: { kind: "list" },
    });
    reply({
      type: "pi_workspace.library.response",
      payload: {
        requestId: request.requestId,
        agentId: "agent",
        result: { kind: "list", items: [], nextCursor: null },
      },
    });
    await expect(reading).resolves.toEqual({ kind: "list", items: [], nextCursor: null });
    const selection = client.requestVisualLibrary({
      agentId: "agent",
      clientGeneration: generation,
      operation: { kind: "select", id: randomUUID(), revision: 1 },
    });
    const selecting = requestSchema.parse(sent.at(-1)).message;
    reply({
      type: "rpc_error",
      payload: {
        requestId: selecting.requestId,
        requestType: selecting.type,
        code: "UNKNOWN_REVISION",
        error: "Uncommitted source",
      },
    });
    await expect(selection).rejects.toMatchObject({ code: "UNKNOWN_REVISION" });
    expect(sent.slice(1).map((frame) => requestSchema.parse(frame).message.type)).toEqual([
      "pi_workspace.observe.request",
      "pi_workspace.library.request",
      "pi_workspace.library.request",
    ]);
  } finally {
    await client.close();
  }
});
