import { contextBridge, ipcRenderer } from "electron";
import type {
  VisualActions,
  VisualBinding,
  VisualSnapshot,
} from "@getpaseo/protocol/pi-workspace/contracts";
import type { VisualReceipt } from "@getpaseo/protocol/pi-workspace/rpc-schemas";

type Json = VisualSnapshot["state"];
interface Configuration {
  binding: VisualBinding;
  snapshot: VisualSnapshot;
  stateRevision: number;
  commandId: string | null;
}
interface RegisteredAction {
  description: string;
  parameters: VisualActions[string]["parameters"];
  run(value: Json): unknown;
}
interface Registration {
  read(): unknown;
  restore(snapshot: VisualSnapshot): unknown;
  actions: Map<string, RegisteredAction>;
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function json(value: unknown, depth = 0): value is Json {
  if (depth > 16) return false;
  if (value === null || typeof value === "boolean") return true;
  if (typeof value === "string") return value.length <= 32768;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value))
    return value.length <= 32768 && value.every((item: unknown) => json(item, depth + 1));
  return (
    record(value) &&
    Object.keys(value).length <= 32768 &&
    Object.values(value).every((item) => json(item, depth + 1))
  );
}
function snapshot(value: unknown): VisualSnapshot {
  if (
    !record(value) ||
    Object.keys(value).length !== 2 ||
    !json(value.state) ||
    !json(value.selection)
  )
    throw new Error("Visual read/restore requires bounded JSON state and selection");
  if (new TextEncoder().encode(JSON.stringify(value)).length > 32768)
    throw new Error("Visual snapshot exceeds its byte limit");
  return { state: value.state, selection: value.selection };
}
function binding(value: unknown): VisualBinding {
  if (
    !record(value) ||
    typeof value.id !== "string" ||
    typeof value.nonce !== "string" ||
    typeof value.clientGeneration !== "string" ||
    typeof value.revision !== "number" ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 1
  )
    throw new Error("Invalid visual document binding");
  return {
    id: value.id,
    nonce: value.nonce,
    clientGeneration: value.clientGeneration,
    revision: value.revision,
  };
}
function configuration(value: unknown): Configuration {
  if (
    !record(value) ||
    typeof value.stateRevision !== "number" ||
    !Number.isSafeInteger(value.stateRevision) ||
    value.stateRevision < 1
  )
    throw new Error("Visual guest has no valid host configuration");
  if (value.commandId !== null && typeof value.commandId !== "string")
    throw new Error("Invalid render operation identity");
  return {
    binding: binding(value.binding),
    snapshot: snapshot(value.snapshot),
    stateRevision: value.stateRevision,
    commandId: value.commandId,
  };
}
function registration(value: unknown): Registration {
  if (
    !record(value) ||
    typeof value.read !== "function" ||
    typeof value.restore !== "function" ||
    !record(value.actions)
  )
    throw new Error("Register read, restore and declared actions");
  const read = value.read;
  const restore = value.restore;
  const entries = Object.entries(value.actions);
  if (entries.length > 64) throw new Error("Visual action limit exceeded");
  const actions = new Map<string, RegisteredAction>();
  for (const [name, action] of entries) {
    if (
      name.length === 0 ||
      name.length > 128 ||
      !record(action) ||
      typeof action.run !== "function" ||
      typeof action.description !== "string" ||
      action.description.length === 0 ||
      action.description.length > 1024 ||
      !record(action.parameters) ||
      !json(action.parameters)
    )
      throw new Error("Invalid declared visual action");
    const run = action.run;
    actions.set(name, {
      description: action.description,
      parameters: action.parameters,
      run: (input) => run(input),
    });
  }
  return { read: () => read(), restore: (state) => restore(state), actions };
}
const rawConfiguration: unknown = ipcRenderer.sendSync("paseo:visual:configuration");
const config = configuration(rawConfiguration);
let registered: Registration | null = null;
let ready = false;
let restoring = false;
let stateRevision = config.stateRevision;
let sequence = 0;
let operations = Promise.resolve();
const seen = new Set<string>();

function matches(value: unknown): boolean {
  const candidate = binding(value);
  return (
    candidate.id === config.binding.id &&
    candidate.revision === config.binding.revision &&
    candidate.nonce === config.binding.nonce &&
    candidate.clientGeneration === config.binding.clientGeneration
  );
}
function send(commandId: string | null, error: VisualReceipt["error"]): void {
  const observed =
    !error && registered ? snapshot(registered.read()) : { state: null, selection: null };
  const actions: VisualActions = {};
  if (!error && registered) {
    for (const [name, action] of registered.actions)
      Object.defineProperty(actions, name, {
        enumerable: true,
        value: { description: action.description, parameters: action.parameters },
      });
  }
  const receipt: VisualReceipt = {
    binding: config.binding,
    sequence: ++sequence,
    commandId,
    stateRevision,
    snapshot: observed,
    actions,
    error,
  };
  if (new TextEncoder().encode(JSON.stringify(receipt)).length > 65536)
    throw new Error("Visual receipt exceeds its byte limit");
  ipcRenderer.send("paseo:visual:receipt", receipt);
}
function fail(commandId: string | null, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  send(commandId, {
    code: "DOCUMENT_ERROR",
    message: message.slice(0, 2048) || "Visual document failed",
  });
}
contextBridge.exposeInMainWorld(
  "paseoVisual",
  Object.freeze({
    register(value: unknown): void {
      if (registered || ready) throw new Error("Register visual callbacks once before readiness");
      registered = registration(value);
    },
    publish(): void {
      if (!ready || restoring)
        throw new Error("Visual cannot publish before readiness or during restoration");
      try {
        send(null, null);
      } catch (error) {
        fail(null, error);
      }
    },
  }),
);

window.addEventListener(
  "load",
  () => {
    operations = operations
      .then(async () => {
        if (config.stateRevision > 1) {
          if (registered) await registered.restore(config.snapshot);
          else if (config.snapshot.state !== null || config.snapshot.selection !== null)
            throw new Error("Replacement cannot restore saved state");
        }
        ready = true;
        send(config.commandId, null);
        return undefined;
      })
      .catch((error: unknown) => fail(config.commandId, error));
  },
  { once: true },
);
window.addEventListener("error", (event) =>
  fail(ready ? null : config.commandId, event.error || event.message),
);
window.addEventListener("unhandledrejection", (event) =>
  fail(ready ? null : config.commandId, event.reason),
);
async function restoreStored(value: unknown): Promise<void> {
  if (
    !record(value) ||
    !matches(value.binding) ||
    typeof value.stateRevision !== "number" ||
    !Number.isSafeInteger(value.stateRevision) ||
    value.stateRevision < 1
  )
    throw new Error("Invalid visual restoration");
  if (!ready) throw new Error("Visual restoration precedes readiness");
  if (value.stateRevision < stateRevision) return;
  const stored = snapshot(value.snapshot);
  restoring = true;
  try {
    if (registered) await registered.restore(stored);
    else if (stored.state !== null || stored.selection !== null)
      throw new Error("Static visual cannot restore nonempty state");
    stateRevision = value.stateRevision;
  } finally {
    restoring = false;
  }
}
ipcRenderer.on("paseo:visual:restore", (_event, value: unknown) => {
  operations = operations
    .then(() => restoreStored(value))
    .catch((error: unknown) => fail(null, error));
});
ipcRenderer.on("paseo:visual:command", (_event, value: unknown) => {
  const commandId = record(value) && typeof value.commandId === "string" ? value.commandId : null;
  operations = operations
    .then(async () => {
      if (!record(value) || !matches(value.binding) || commandId === null)
        throw new Error("Invalid visual command");
      if (!ready) throw new Error("Visual command precedes readiness");
      if (seen.has(commandId) || seen.size >= 4096)
        throw new Error("Visual command identity exhausted or repeated");
      seen.add(commandId);
      if (value.kind === "act") {
        const action =
          registered && typeof value.action === "string"
            ? registered.actions.get(value.action)
            : undefined;
        if (!action || !json(value.value))
          throw new Error("Unknown visual action or invalid value");
        await action.run(value.value);
      } else if (value.kind !== "inspect") throw new Error("Unknown visual command");
      send(commandId, null);
      return undefined;
    })
    .catch((error: unknown) => fail(commandId, error));
});
