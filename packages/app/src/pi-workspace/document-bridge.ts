import { z } from "zod";
import type {
  VisualCommand,
  VisualRenderDocument,
} from "@getpaseo/protocol/pi-workspace/rpc-schemas";
import { VisualReceiptSchema } from "@getpaseo/protocol/pi-workspace/rpc-schemas";
import { withPreviewCsp } from "../file-pane/html-preview-csp";

export const DocumentMessageSchema = z
  .object({ type: z.literal("paseo-visual"), receipt: VisualReceiptSchema })
  .strict();
export interface VisualDocumentProps {
  current: VisualRenderDocument;
  renderCommandId: string | null;
  command: Exclude<VisualCommand, { kind: "render" }> | null;
  receive(value: unknown): void;
  reportError(error: unknown): void;
}
interface BridgeDocumentInput {
  current: VisualRenderDocument;
  commandId: string | null;
  platform: "web" | "native";
}

/** Only the document identity, saved snapshot and narrow commands cross the sandbox. */
export function visualDocumentHtml(input: BridgeDocumentInput): string {
  const configuration = JSON.stringify({
    binding: input.current.binding,
    snapshot: input.current.document.snapshot,
    restore: input.current.document.stateRevision > 1,
    commandId: input.commandId,
    platform: input.platform,
  }).replace(/</g, "\\u003c");
  const script = `(() => {
    const config = ${configuration};
    let registration = null;
    let ready = false;
    let sequence = 0;
    let operation = Promise.resolve();
    const seen = new Set();
    const empty = {state:null, selection:null};
    function send(commandId, error) {
      let snapshot = empty;
      let actions = {};
      if (!error && registration) {
        snapshot = registration.read();
        if (!snapshot || !Object.hasOwn(snapshot,'state') || !Object.hasOwn(snapshot,'selection')) throw new Error('read() must return state and selection');
        for (const [name, action] of Object.entries(registration.actions)) actions[name] = {description:action.description, parameters:action.parameters};
      }
      const receipt = {binding:config.binding, commandId, sequence:++sequence, snapshot, actions, error};
      const message = JSON.stringify({type:'paseo-visual',receipt});
      if (message.length > 65536) throw new Error('Visual observation exceeds its size limit');
      if (config.platform === 'native') window.ReactNativeWebView.postMessage(message);
      else window.parent.postMessage(JSON.parse(message),'*');
    }
    function fail(commandId, error) {
      const message = error instanceof Error ? error.message : String(error);
      send(commandId, {code:'DOCUMENT_ERROR',message:message.slice(0,2048) || 'Visual document failed'});
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
        if (!ready) throw new Error('Visual is not ready to publish');
        try { send(null,null); } catch(error) { fail(null,error); }
      }
    }),writable:false,configurable:false});
    window.addEventListener('load',async () => {
      try {
        if (config.restore) {
          if (!registration && (config.snapshot.state !== null || config.snapshot.selection !== null)) throw new Error('Replacement cannot restore saved visual state');
          if (registration) await registration.restore(structuredClone(config.snapshot));
        }
        ready = true;
        send(config.commandId,null);
      } catch(error) { fail(config.commandId,error); }
    },{once:true});
    window.addEventListener('error',(event) => fail(ready ? null : config.commandId, event.error || event.message));
    window.addEventListener('unhandledrejection',(event) => fail(ready ? null : config.commandId,event.reason));
    window.addEventListener('message',(event) => {
      if (config.platform === 'web' && event.source !== window.parent) return;
      const envelope = event.data;
      if (!envelope || envelope.type !== 'paseo-visual-command') return;
      const command = envelope.command;
      if (!command || !command.binding || command.binding.nonce !== config.binding.nonce || command.binding.clientGeneration !== config.binding.clientGeneration || command.binding.id !== config.binding.id || command.binding.revision !== config.binding.revision) return;
      if (typeof command.commandId !== 'string' || seen.has(command.commandId)) return;
      if (seen.size >= 4096) { fail(command.commandId,new Error('Document command limit reached; reopen the visual')); return; }
      seen.add(command.commandId);
      operation = operation.then(async () => {
        try {
          if (!ready) throw new Error('Visual is not ready');
          if (command.kind === 'act') {
            if (!registration || !Object.hasOwn(registration.actions,command.action)) throw new Error('Unknown visual action');
            await registration.actions[command.action].run(command.value);
          } else if (command.kind !== 'inspect') throw new Error('Unknown visual command');
          send(command.commandId,null);
        } catch(error) { fail(command.commandId,error); }
      });
    });
  })();`;
  return withPreviewCsp(`<script>${script}</script>${input.current.document.html}`);
}
