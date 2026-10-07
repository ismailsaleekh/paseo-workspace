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
/** One of this guest's receipts whose returned state has not been seen yet. */
interface SentReceipt {
  sequence: number;
  base: number;
  key: string;
  command: boolean;
  /** Its answer names the stored state holding this receipt's own content. */
  advances: boolean;
}
type GuestCommand =
  | { kind: "act"; commandId: string; action: string; value: Json }
  | { kind: "inspect"; commandId: string };
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
/** Content identity of a snapshot, independent of object key order. */
function canonical(value: VisualSnapshot): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (!record(item)) return item;
    const sorted: Record<string, unknown> = {};
    for (const name of Object.keys(item).sort()) sorted[name] = item[name];
    return sorted;
  });
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
function revision(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}
function configuration(value: unknown): Configuration {
  if (!record(value) || !revision(value.stateRevision))
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
let sequence = 0;
let operations = Promise.resolve();
const seen = new Set<string>();

// State synchronization, as in the app's document bridge (`visualDocumentHtml`): the live state
// is built on one stored state (`stateRevision`). At most one receipt (a publication or a command
// result) awaits its answer; changes made meanwhile are published together, on the acknowledged
// base, once it arrives, and commands received meanwhile run then. A returned state whose content
// is one of this guest's unanswered receipts only advances the base and never replaces newer live
// state; an older or repeated revision is ignored; a newer state from another writer is adopted
// (unpublished local changes lose that conflict).
let stateRevision = config.stateRevision;
const sent: SentReceipt[] = [];
let publication: SentReceipt | null = null;
let wanted = false;
let executing = false;
const commands: GuestCommand[] = [];

function awaitingAnswer(): boolean {
  return publication !== null;
}
function matches(value: unknown): boolean {
  const candidate = binding(value);
  return (
    candidate.id === config.binding.id &&
    candidate.revision === config.binding.revision &&
    candidate.nonce === config.binding.nonce &&
    candidate.clientGeneration === config.binding.clientGeneration
  );
}
function emit(commandId: string | null, error: VisualReceipt["error"]): VisualReceipt {
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
  return receipt;
}
/** Sends the current state; it stays tracked until its returned state is seen (bounded). */
function send(commandId: string | null): SentReceipt {
  const receipt = emit(commandId, null);
  const entry: SentReceipt = {
    sequence: receipt.sequence,
    base: stateRevision,
    key: canonical(receipt.snapshot),
    command: commandId !== null,
    advances: true,
  };
  // The oldest are never answered when nothing changed, so the list is bounded rather than
  // drained by acknowledgements.
  sent.push(entry);
  if (sent.length > 64) sent.shift();
  return entry;
}
function fail(commandId: string | null, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  emit(commandId, {
    code: "DOCUMENT_ERROR",
    message: message.slice(0, 2048) || "Visual document failed",
  });
}
function publishLatest(): void {
  wanted = false;
  publication = send(null);
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
      if (awaitingAnswer() || executing) {
        wanted = true;
        return;
      }
      try {
        publishLatest();
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
        const entry = send(config.commandId);
        // The render result is not awaited; a first publication is.
        if (config.commandId === null) publication = entry;
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

async function execute(command: GuestCommand): Promise<void> {
  executing = true;
  try {
    if (command.kind === "act") {
      const action = registered ? registered.actions.get(command.action) : undefined;
      if (!action) throw new Error("Unknown visual action or invalid value");
      await action.run(command.value);
    }
    const entry = send(command.commandId);
    // The result carries every local change, so it is this guest's next publication and later
    // changes wait for its answer. An action's answer always names its own stored result; an
    // agent read may be answered with another writer's newer state, which then arrives as a
    // returned state.
    entry.advances = command.kind === "act";
    wanted = false;
    publication = entry;
  } catch (error) {
    fail(command.commandId, error);
  } finally {
    executing = false;
  }
}
/** Runs the commands that waited for an answer, then publishes changes made meanwhile. */
async function proceed(retry: boolean): Promise<void> {
  while (!awaitingAnswer()) {
    const next = commands.shift();
    if (!next) break;
    await execute(next);
  }
  if (!awaitingAnswer() && (wanted || retry)) publishLatest();
}
async function accept(stored: number, value: VisualSnapshot): Promise<void> {
  if (stored < stateRevision) return;
  const key = canonical(value);
  const own = sent.findIndex((entry) => entry.key === key);
  if (own !== -1) {
    // One of this guest's receipts came back: the live state already contains it and may be
    // newer, so it is never restored over the live state.
    sent.splice(0, own + 1);
    stateRevision = stored;
    return;
  }
  if (stored === stateRevision) return;
  restoring = true;
  try {
    if (registered) await registered.restore(value);
    else if (value.state !== null || value.selection !== null)
      throw new Error("Static visual cannot restore nonempty state");
  } finally {
    restoring = false;
  }
  stateRevision = stored;
  sent.length = 0;
  publication = null;
  wanted = false;
  await proceed(false);
}
async function restoreStored(value: unknown): Promise<void> {
  if (!record(value) || !matches(value.binding) || !revision(value.stateRevision))
    throw new Error("Invalid visual restoration");
  if (!ready) throw new Error("Visual restoration precedes readiness");
  await accept(value.stateRevision, snapshot(value.snapshot));
}
async function acknowledged(value: unknown): Promise<void> {
  if (!record(value) || !matches(value.binding) || !revision(value.sequence))
    throw new Error("Invalid visual acknowledgement");
  const raw = value.stateRevision;
  let stored: number | null = null;
  if (raw !== null) {
    if (!revision(raw)) throw new Error("Invalid acknowledged state revision");
    stored = raw;
  }
  if (!ready) throw new Error("Visual acknowledgement precedes readiness");
  const answered = publication;
  if (!answered || answered.sequence !== value.sequence) return;
  publication = null;
  if (stored !== null && answered.advances && stored > stateRevision) stateRevision = stored;
  // A publication rejected only because the stored state advanced with this guest's own receipts
  // is published again on that base; any other rejection waits for the next change. A rejected
  // command result is never repeated: the agent was told that it failed.
  const retry = stored === null && !answered.command && answered.base < stateRevision;
  await proceed(retry);
}
function guestCommand(value: unknown): GuestCommand {
  if (!record(value) || !matches(value.binding) || typeof value.commandId !== "string")
    throw new Error("Invalid visual command");
  if (value.kind === "inspect") return { kind: "inspect", commandId: value.commandId };
  if (value.kind !== "act") throw new Error("Unknown visual command");
  if (typeof value.action !== "string" || !json(value.value))
    throw new Error("Unknown visual action or invalid value");
  return { kind: "act", commandId: value.commandId, action: value.action, value: value.value };
}
ipcRenderer.on("paseo:visual:restore", (_event, value: unknown) => {
  operations = operations
    .then(() => restoreStored(value))
    .catch((error: unknown) => fail(null, error));
});
ipcRenderer.on("paseo:visual:ack", (_event, value: unknown) => {
  operations = operations
    .then(() => acknowledged(value))
    .catch((error: unknown) => fail(null, error));
});
ipcRenderer.on("paseo:visual:command", (_event, value: unknown) => {
  const commandId = record(value) && typeof value.commandId === "string" ? value.commandId : null;
  operations = operations
    .then(async () => {
      const command = guestCommand(value);
      if (!ready) throw new Error("Visual command precedes readiness");
      if (seen.has(command.commandId) || seen.size >= 4096)
        throw new Error("Visual command identity exhausted or repeated");
      seen.add(command.commandId);
      if (awaitingAnswer()) {
        // Bounded: the desktop host admits few pending commands per guest.
        if (commands.length >= 64) throw new Error("Visual command limit reached");
        commands.push(command);
        return undefined;
      }
      await execute(command);
      return undefined;
    })
    .catch((error: unknown) => fail(commandId, error));
});
