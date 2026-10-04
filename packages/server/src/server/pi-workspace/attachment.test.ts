import assert from "node:assert/strict";
import { test } from "vitest";
import { stat } from "node:fs/promises";
import { dirname } from "node:path";
import { createConnection } from "node:net";
import {
  VisualFailure,
  VISUAL_FRAME_BYTES,
  type VisualOperation,
  type VisualOwner,
  type VisualResult,
} from "@getpaseo/protocol/pi-workspace/contracts";
import { VisualConnection } from "../../../../pi-workspace/src/connection.js";
import { VisualAttachmentBridge } from "./attachment.js";
import {
  withIsolatedHome,
  withRpc,
  type IsolatedHome,
} from "../../../../pi-workspace/tests/helpers/pi-harness.js";

interface Invocation {
  owner: VisualOwner;
  operation: VisualOperation;
}
const emptyList: VisualResult = { kind: "list", items: [], nextCursor: null };

async function withBridge(
  run: (bridge: VisualAttachmentBridge, calls: Invocation[]) => Promise<void>,
): Promise<void> {
  const calls: Invocation[] = [];
  const failures: unknown[] = [];
  const bridge = new VisualAttachmentBridge({
    async execute(owner, operation) {
      calls.push({ owner, operation });
      return emptyList;
    },
    reportFailure(error) {
      failures.push(error);
    },
  });
  await bridge.start();
  try {
    await run(bridge, calls);
    assert.deepEqual(failures, []);
  } finally {
    await bridge.stop();
  }
}

async function verifyRpcBinding(home: IsolatedHome): Promise<void> {
  const calls: Invocation[] = [];
  const failures: unknown[] = [];
  const bridge = new VisualAttachmentBridge({
    async execute(owner, operation) {
      calls.push({ owner, operation });
      if (operation.kind === "context") return { kind: "context", visual: null };
      if (operation.kind === "list") return emptyList;
      throw new VisualFailure(
        "UNSUPPORTED_TEST_OPERATION",
        "This transport test accepts only context and list",
      );
    },
    reportFailure(error) {
      failures.push(error);
    },
  });
  await bridge.start();
  const lease = bridge.issue("rpc-bound-agent");
  Object.assign(home.env, lease.env);
  try {
    await withRpc(home, async (client) => {
      const state = await client.getState();
      lease.activate(async () => (await client.getState()).sessionId);
      await client.promptAndWait('call:{"name":"visual_list","arguments":{}}', undefined, 20_000);
      const results = (await client.getMessages()).filter(
        (message) => message.role === "toolResult",
      );
      assert.equal(results.length, 1, JSON.stringify(results));
      const result = results[0];
      if (!result) throw new Error("Pi did not persist its visual tool result");
      assert.equal(result.isError, false, JSON.stringify(result));
      assert.deepEqual(result.details, emptyList);
      const listCalls = calls.filter((call) => call.operation.kind === "list");
      assert.deepEqual(listCalls, [
        {
          owner: { agentId: "rpc-bound-agent", sessionId: state.sessionId },
          operation: { kind: "list", cursor: null },
        },
      ]);
      assert.deepEqual(failures, []);
    });
  } finally {
    lease.revoke();
    await bridge.stop();
  }
}

test("real Pi can verify its RPC session while a visual context/tool request is in flight", async () => {
  await withIsolatedHome(verifyRpcBinding);
}, 45_000);

function unavailable(error: unknown): boolean {
  return error instanceof VisualFailure;
}

test("real private socket verifies actual session and binds the host-owned agent identity", async () => {
  await withBridge(async (bridge, calls) => {
    const lease = bridge.issue("bound-agent");
    lease.activate(async () => "actual-session");
    const directory = await stat(dirname(lease.env.PI_WORKSPACE_SOCKET));
    const socket = await stat(lease.env.PI_WORKSPACE_SOCKET);
    assert.equal(directory.mode & 0o777, 0o700);
    assert.equal(socket.mode & 0o777, 0o600);
    const client = new VisualConnection({
      socketPath: lease.env.PI_WORKSPACE_SOCKET,
      capability: lease.env.PI_WORKSPACE_CAPABILITY,
    });
    client.bind("actual-session");
    try {
      assert.deepEqual(await client.request({ kind: "list", cursor: null }), emptyList);
      assert.deepEqual(calls, [
        {
          owner: { agentId: "bound-agent", sessionId: "actual-session" },
          operation: { kind: "list", cursor: null },
        },
      ]);
    } finally {
      client.close();
      lease.revoke();
    }
  });
});

test("a guessed capability, inactive runtime or mismatched session cannot call the host", async () => {
  await withBridge(async (bridge, calls) => {
    const lease = bridge.issue("bound-agent");
    const inactive = new VisualConnection({
      socketPath: lease.env.PI_WORKSPACE_SOCKET,
      capability: lease.env.PI_WORKSPACE_CAPABILITY,
    });
    inactive.bind("actual-session");
    await assert.rejects(inactive.request({ kind: "list", cursor: null }), unavailable);
    inactive.close();
    lease.activate(async () => "actual-session");
    const guessed = new VisualConnection({
      socketPath: lease.env.PI_WORKSPACE_SOCKET,
      capability: "0".repeat(64),
    });
    guessed.bind("actual-session");
    await assert.rejects(guessed.request({ kind: "list", cursor: null }), unavailable);
    guessed.close();
    const wrongSession = new VisualConnection({
      socketPath: lease.env.PI_WORKSPACE_SOCKET,
      capability: lease.env.PI_WORKSPACE_CAPABILITY,
    });
    wrongSession.bind("guessed-session");
    await assert.rejects(wrongSession.request({ kind: "list", cursor: null }), unavailable);
    wrongSession.close();
    assert.deepEqual(calls, []);
    lease.revoke();
  });
});

test("session changes and runtime revocation invalidate an already established attachment", async () => {
  await withBridge(async (bridge, calls) => {
    let sessionId = "first-session";
    const lease = bridge.issue("bound-agent");
    lease.activate(async () => sessionId);
    const client = new VisualConnection({
      socketPath: lease.env.PI_WORKSPACE_SOCKET,
      capability: lease.env.PI_WORKSPACE_CAPABILITY,
    });
    client.bind(sessionId);
    try {
      await client.request({ kind: "list", cursor: null });
      sessionId = "replacement-session";
      await assert.rejects(
        client.request({ kind: "list", cursor: null }),
        (error: unknown) => error instanceof VisualFailure && error.code === "STALE_SESSION",
      );
      assert.equal(calls.length, 1);
      client.bind(sessionId);
      await client.request({ kind: "list", cursor: null });
      assert.equal(calls[1]?.owner.sessionId, sessionId);
      lease.revoke();
      await assert.rejects(client.request({ kind: "list", cursor: null }), unavailable);
      assert.equal(calls.length, 2);
    } finally {
      client.close();
      lease.revoke();
    }
  });
});

test("malformed, deep, oversized and premature private frames close without invoking host operations", async () => {
  await withBridge(async (bridge, calls) => {
    const lease = bridge.issue("frame-boundary-agent");
    lease.activate(async () => "session");
    const frames = [
      "{broken\n",
      JSON.stringify({ nested: "x".repeat(VISUAL_FRAME_BYTES + 1) }) + "\n",
      '{"nested":' + "[".repeat(30) + "0" + "]".repeat(30) + "}\n",
      JSON.stringify({
        kind: "request",
        requestId: "e113d702-db65-45b7-8063-00c69336f75c",
        operation: { kind: "list", cursor: null },
      }) + "\n",
    ];
    try {
      for (const frame of frames) {
        await new Promise<void>((resolve, reject) => {
          const socket = createConnection({ path: lease.env.PI_WORKSPACE_SOCKET });
          socket.setTimeout(2000, () => {
            socket.destroy();
            reject(new Error("Invalid visual frame was not disconnected"));
          });
          socket.once("connect", () => {
            socket.write(frame);
          });
          socket.on("data", () => {
            /* Drain any explicit refusal before the peer closes. */
          });
          socket.on("error", (error) => {
            const refused =
              "code" in error && (error.code === "ECONNRESET" || error.code === "EPIPE");
            if (!refused) reject(error);
          });
          socket.once("close", () => {
            resolve();
          });
        });
      }
      assert.deepEqual(calls, []);
    } finally {
      lease.revoke();
    }
  });
});

test("cancelling the client request cancels the host operation and permits later requests", async () => {
  let markStarted: () => void = () => {
    throw new Error("Not initialized");
  };
  let markCancelled: () => void = () => {
    throw new Error("Not initialized");
  };
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const cancelled = new Promise<void>((resolve) => {
    markCancelled = resolve;
  });
  const failures: unknown[] = [];
  const bridge = new VisualAttachmentBridge({
    async execute(_owner, operation, signal) {
      if (operation.kind === "list") return emptyList;
      return new Promise<VisualResult>((_resolve, reject) => {
        const abort = () => {
          markCancelled();
          reject(new VisualFailure("CANCELLED", "Operation cancelled"));
        };
        signal.addEventListener("abort", abort, { once: true });
        markStarted();
        if (signal.aborted) abort();
      });
    },
    reportFailure(error) {
      failures.push(error);
    },
  });
  await bridge.start();
  const lease = bridge.issue("agent");
  lease.activate(async () => "session");
  const client = new VisualConnection({
    socketPath: lease.env.PI_WORKSPACE_SOCKET,
    capability: lease.env.PI_WORKSPACE_CAPABILITY,
  });
  client.bind("session");
  try {
    const controller = new AbortController();
    const request = client.request(
      { kind: "inspect", id: null, screenshot: false },
      controller.signal,
    );
    const rejected = assert.rejects(
      request,
      (error: unknown) => error instanceof VisualFailure && error.code === "CANCELLED",
    );
    await started;
    controller.abort();
    await rejected;
    await cancelled;
    assert.deepEqual(await client.request({ kind: "list", cursor: null }), emptyList);
    assert.deepEqual(failures, []);
  } finally {
    client.close();
    lease.revoke();
    await bridge.stop();
  }
});
