import { z } from "zod";
import type {
  VisualCommand,
  VisualRenderDocument,
  VisualHostSignal,
} from "@getpaseo/protocol/pi-workspace/rpc-schemas";
import { VisualReceiptSchema } from "@getpaseo/protocol/pi-workspace/rpc-schemas";
import type { VisualBinding, VisualSnapshot } from "@getpaseo/protocol/pi-workspace/contracts";
import { withPreviewCsp } from "../file-pane/html-preview-csp";

export const DocumentMessageSchema = z
  .object({ type: z.literal("paseo-visual"), receipt: VisualReceiptSchema })
  .strict();
/**
 * The daemon's answer to one receipt the document waits for (a publication, that is a state
 * receipt without a command, or a command result): the stored state revision that now holds it,
 * or `null` when it was rejected.
 */
export interface VisualAcknowledgement {
  binding: VisualBinding;
  sequence: number;
  stateRevision: number | null;
}
export interface VisualDocumentProps {
  current: VisualRenderDocument;
  restoration?: VisualRenderDocument | null;
  /** Bridges built by `visualDocumentHtml` need it to publish their next change. */
  acknowledgement?: VisualAcknowledgement | null;
  renderCommandId: string | null;
  command: Exclude<VisualCommand, { kind: "render" }> | null;
  receive(value: unknown): void;
  hostEvent?(event: VisualHostSignal): void;
  reportError(error: unknown): void;
}
export interface VisualStateMessage {
  type: "paseo-visual-state";
  binding: VisualBinding;
  snapshot: VisualSnapshot;
  stateRevision: number;
}
export interface VisualAcknowledgementMessage {
  type: "paseo-visual-ack";
  binding: VisualBinding;
  sequence: number;
  stateRevision: number | null;
}

export function visualStateMessage(current: VisualRenderDocument): VisualStateMessage {
  return {
    type: "paseo-visual-state",
    binding: current.binding,
    snapshot: current.document.snapshot,
    stateRevision: current.document.stateRevision,
  };
}

export function visualAcknowledgementMessage(
  acknowledgement: VisualAcknowledgement,
): VisualAcknowledgementMessage {
  return {
    type: "paseo-visual-ack",
    binding: acknowledgement.binding,
    sequence: acknowledgement.sequence,
    stateRevision: acknowledgement.stateRevision,
  };
}

interface BridgeDocumentInput {
  current: VisualRenderDocument;
  commandId: string | null;
  /** web: sandboxed iframe; native: in-app WebView (iOS); android: companion visual host. */
  platform: "web" | "native" | "android";
}

/**
 * Only the document identity, saved snapshot and narrow commands cross the sandbox.
 *
 * State synchronization inside the document: the live state is built on one stored state
 * (`stateRevision` and its content). At most one publication awaits its acknowledgement; changes
 * made meanwhile are published together, on the acknowledged base, once it arrives. A returned
 * state whose content is one of the document's own unanswered receipts confirms that receipt and
 * never replaces the newer live state; an older or repeated revision is ignored; a newer state
 * from another writer is adopted (unpublished local changes lose that conflict). Known limitation:
 * a different writer storing exactly the content of one of the unanswered receipts is taken as an
 * own returned state (its content already equals a state this document published).
 *
 * Agent commands are ordered with publications: a command that arrives while a receipt awaits its
 * answer runs once that answer arrives, so its result is sent on the acknowledged base and is
 * never rejected only because this document's own publication was in flight; changes made
 * meanwhile wait for the command result's answer. The result carries those changes too.
 */
export function visualDocumentHtml(input: BridgeDocumentInput): string {
  const configuration = JSON.stringify({
    binding: input.current.binding,
    snapshot: input.current.document.snapshot,
    stateRevision: input.current.document.stateRevision,
    restore: input.current.document.stateRevision > 1,
    commandId: input.commandId,
    platform: input.platform,
  }).replace(/</g, "\\u003c");
  const script = `(() => {
    const config = ${configuration};
    // The Android visual host injects its message port before any document script runs; keep the
    // reference so later document code cannot swap the transport this bridge reports through.
    const hostPort = config.platform === 'android' ? window.paseoVisualHost : null;
    if (config.platform === 'android' && (!hostPort || typeof hostPort.postMessage !== 'function')) throw new Error('Visual host transport is unavailable');
    let registration = null;
    let ready = false;
    let sequence = 0;
    let stateRevision = config.stateRevision;
    const sent = [];
    let publication = null;
    let wanted = false;
    let executing = false;
    const commands = [];
    let restoring = false;
    let resolveReady;
    const readiness = new Promise(resolve => { resolveReady = resolve; });
    let operation = Promise.resolve();
    const seen = new Set();
    const empty = {state:null, selection:null};
    function canonical(value) {
      return JSON.stringify(value, (key, item) => {
        if (item === null || typeof item !== 'object' || Array.isArray(item)) return item;
        const sorted = {};
        for (const name of Object.keys(item).sort()) sorted[name] = item[name];
        return sorted;
      });
    }
    function bound(binding) {
      return !!binding && binding.nonce === config.binding.nonce && binding.clientGeneration === config.binding.clientGeneration && binding.id === config.binding.id && binding.revision === config.binding.revision;
    }
    function send(commandId, error) {
      let snapshot = empty;
      let actions = {};
      if (!error && registration) {
        snapshot = registration.read();
        if (!snapshot || !Object.hasOwn(snapshot,'state') || !Object.hasOwn(snapshot,'selection')) throw new Error('read() must return state and selection');
        for (const [name, action] of Object.entries(registration.actions)) actions[name] = {description:action.description, parameters:action.parameters};
      }
      const receipt = {binding:config.binding, commandId, sequence:++sequence, stateRevision, snapshot, actions, error};
      const message = JSON.stringify({type:'paseo-visual',receipt});
      if (message.length > 65536) throw new Error('Visual observation exceeds its size limit');
      if (config.platform === 'native') window.ReactNativeWebView.postMessage(message);
      else if (hostPort) hostPort.postMessage(message);
      else window.parent.postMessage(JSON.parse(message),'*');
      if (error) return null;
      // Receipts whose returned state has not been seen yet; the oldest are never answered when
      // nothing changed, so the list is bounded rather than drained by acknowledgements.
      const entry = {sequence:receipt.sequence, base:receipt.stateRevision, key:canonical(snapshot), command:commandId !== null, advances:true};
      sent.push(entry);
      if (sent.length > 64) sent.shift();
      return entry;
    }
    function fail(commandId, error) {
      const message = error instanceof Error ? error.message : String(error);
      send(commandId, {code:'DOCUMENT_ERROR',message:message.slice(0,2048) || 'Visual document failed'});
    }
    function publishLatest() {
      wanted = false;
      publication = send(null,null);
    }
    async function accept(revision, snapshot) {
      if (revision < stateRevision) return;
      const key = canonical(snapshot);
      const own = sent.findIndex(entry => entry.key === key);
      if (own !== -1) {
        // One of this document's receipts came back: the live state already contains it and may
        // be newer, so it is never restored over the live state.
        sent.splice(0, own + 1);
        stateRevision = revision;
        return;
      }
      if (revision === stateRevision) return;
      restoring = true;
      if (registration) await registration.restore(structuredClone(snapshot));
      else if (snapshot.state !== null || snapshot.selection !== null) throw new Error('Static document cannot restore nonempty state');
      stateRevision = revision;
      sent.length = 0;
      publication = null;
      wanted = false;
      restoring = false;
      await proceed(false);
    }
    async function execute(command) {
      executing = true;
      try {
        if (command.kind === 'act') {
          if (!registration || !Object.hasOwn(registration.actions,command.action)) throw new Error('Unknown visual action');
          await registration.actions[command.action].run(command.value);
        } else if (command.kind !== 'inspect') throw new Error('Unknown visual command');
        const entry = send(command.commandId,null);
        // The result carries every local change, so it is this document's next publication and
        // later changes wait for its answer. An action's answer always names its own stored
        // result; an agent read may be answered with another writer's newer state, which then
        // arrives as a returned state.
        entry.advances = command.kind === 'act';
        wanted = false;
        publication = entry;
      } catch(error) { fail(command.commandId,error); }
      finally { executing = false; }
    }
    async function proceed(retry) {
      while (!publication && commands.length > 0) await execute(commands.shift());
      if (!publication && (wanted || retry)) publishLatest();
    }
    async function acknowledge(acknowledged, stored) {
      const answered = publication;
      if (!answered || answered.sequence !== acknowledged) return;
      publication = null;
      if (stored !== null && answered.advances && stored > stateRevision) stateRevision = stored;
      // A publication rejected only because the stored state advanced with this document's own
      // receipts is published again on that base; any other rejection waits for the next change.
      // A rejected command result is never repeated: the agent was told that it failed.
      const retry = stored === null && !answered.command && answered.base < stateRevision;
      await proceed(retry);
    }
    Object.defineProperty(window,'paseoVisual',{value:Object.freeze({
      register(value) {
        if (registration || ready) throw new Error('Register visual callbacks once before document readiness');
        if (!value || typeof value.read !== 'function' || typeof value.restore !== 'function' || !value.actions || typeof value.actions !== 'object') throw new Error('Invalid visual registration');
        if (Object.keys(value.actions).length > 64) throw new Error('Too many visual actions');
        for (const action of Object.values(value.actions)) {
          if (!action || typeof action.run !== 'function' || typeof action.description !== 'string' || !action.parameters || typeof action.parameters !== 'object') throw new Error('Invalid visual action');
        }
        registration = value;
      },
      publish() {
        if (!ready || restoring) throw new Error('Visual cannot publish before readiness or during restoration');
        if (publication || executing) { wanted = true; return; }
        try { publishLatest(); } catch(error) { fail(null,error); }
      }
    }),writable:false,configurable:false});
    window.addEventListener('load',async () => {
      try {
        if (config.restore) {
          if (!registration && (config.snapshot.state !== null || config.snapshot.selection !== null)) throw new Error('Replacement cannot restore saved visual state');
          if (registration) await registration.restore(structuredClone(config.snapshot));
        }
        ready = true;
        const entry = send(config.commandId,null);
        if (config.commandId === null) publication = entry;
      } catch(error) { fail(config.commandId,error); }
      finally { resolveReady(); }
    },{once:true});
    window.addEventListener('error',(event) => fail(ready ? null : config.commandId, event.error || event.message));
    window.addEventListener('unhandledrejection',(event) => fail(ready ? null : config.commandId,event.reason));
    window.addEventListener('message',(event) => {
      if (config.platform === 'web' && event.source !== window.parent) return;
      const envelope = event.data;
      if (!envelope) return;
      if (envelope.type === 'paseo-visual-state') {
        if (!bound(envelope.binding)) return;
        operation = operation.then(async () => {
          await readiness;
          try {
            if (!ready) throw new Error('Visual is not ready');
            if (!Number.isSafeInteger(envelope.stateRevision) || envelope.stateRevision < 1) throw new Error('Invalid stored state revision');
            if (!envelope.snapshot || typeof envelope.snapshot !== 'object' || !Object.hasOwn(envelope.snapshot,'state') || !Object.hasOwn(envelope.snapshot,'selection')) throw new Error('Invalid stored state');
            await accept(envelope.stateRevision, envelope.snapshot);
          } catch(error) { fail(null,error); }
          finally { restoring = false; }
        });
        return;
      }
      if (envelope.type === 'paseo-visual-ack') {
        if (!bound(envelope.binding)) return;
        operation = operation.then(async () => {
          await readiness;
          try {
            if (!ready) throw new Error('Visual is not ready');
            if (!Number.isSafeInteger(envelope.sequence) || envelope.sequence < 1) throw new Error('Invalid publication acknowledgement');
            const stored = envelope.stateRevision;
            if (stored !== null && (!Number.isSafeInteger(stored) || stored < 1)) throw new Error('Invalid acknowledged state revision');
            await acknowledge(envelope.sequence, stored);
          } catch(error) { fail(null,error); }
        });
        return;
      }
      if (envelope.type !== 'paseo-visual-command') return;
      const command = envelope.command;
      if (!command || !bound(command.binding)) return;
      if (typeof command.commandId !== 'string' || seen.has(command.commandId)) return;
      if (seen.size >= 4096) { fail(command.commandId,new Error('Document command limit reached; reopen the visual')); return; }
      seen.add(command.commandId);
      operation = operation.then(async () => {
        await readiness;
        try {
          if (!ready) throw new Error('Visual is not ready');
          if (publication) {
            // Bounded: the daemon keeps few operations per display in flight.
            if (commands.length >= 64) throw new Error('Document command limit reached; reopen the visual');
            commands.push(command);
            return;
          }
          await execute(command);
        } catch(error) { fail(command.commandId,error); }
      });
    });
  })();`;
  return withPreviewCsp(`<script>${script}</script>${input.current.document.html}`);
}
