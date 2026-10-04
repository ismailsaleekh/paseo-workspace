import { randomUUID } from "node:crypto";
import { Ajv } from "ajv";
import {
  VisualFailure,
  VISUAL_OPERATION_TIMEOUT_MS,
  parseVisualActions,
  parseVisualSnapshot,
  assertVisualJsonBound,
  type VisualActions,
  type VisualBinding,
  type VisualDocument,
  type VisualOperation,
  type VisualOwner,
  type VisualRecord,
  type VisualResult,
} from "@getpaseo/protocol/pi-workspace/contracts";
import type {
  VisualCommand,
  VisualEvent,
  VisualReceipt,
  VisualRenderDocument,
  VisualView,
} from "@getpaseo/protocol/pi-workspace/rpc-schemas";
import { VisualStorage } from "./storage.js";

interface PendingCommand {
  kind: VisualCommand["kind"];
  resolve(receipt: VisualReceipt): void;
  reject(error: VisualFailure): void;
  cleanup(): void;
}
interface VisualPeer {
  agentId: string;
  source: object;
  generation: string;
  sequence: number;
  documentSequence: number;
  current: VisualRenderDocument | null;
  actions: VisualActions;
  status: VisualRecord["status"];
  error: VisualRecord["error"];
  active: boolean;
  emit(event: VisualEvent): void;
  pending: Map<string, PendingCommand>;
  tail: Promise<void>;
}
interface VisualActionExecution {
  owner: VisualOwner;
  operation: Extract<VisualOperation, { kind: "act" }>;
  signal: AbortSignal;
}
interface ValidatedVisualReceipt {
  current: VisualRenderDocument;
  snapshot: VisualDocument["snapshot"];
  actions: VisualActions;
  pending: PendingCommand | undefined;
}
interface ReceiptValidationInput {
  peer: VisualPeer;
  receipt: VisualReceipt;
}
interface Conversation {
  owner: VisualOwner;
  currentId: string | null;
}
export interface ObserveVisualInput {
  agentId: string;
  source: object;
  emit(event: VisualEvent): void;
}
export interface VisualObservation {
  view: VisualView;
  release(): void;
}
export interface ReceiveVisualInput {
  agentId: string;
  source: object;
  receipt: VisualReceipt;
}

function sameBinding(left: VisualBinding, right: VisualBinding): boolean {
  return (
    left.id === right.id &&
    left.revision === right.revision &&
    left.nonce === right.nonce &&
    left.clientGeneration === right.clientGeneration
  );
}
function conversationKey(owner: VisualOwner): string {
  return JSON.stringify([owner.agentId, owner.sessionId]);
}
function checkCancellation(signal: AbortSignal): void {
  if (signal.aborted) throw new VisualFailure("CANCELLED", "Visual operation was cancelled");
}

export type ScheduleVisualDeadline = (expire: () => void, milliseconds: number) => () => void;
function scheduleVisualDeadline(expire: () => void, milliseconds: number): () => void {
  const timer = setTimeout(expire, milliseconds);
  return () => clearTimeout(timer);
}

/** Artifact ownership and command delivery, independent of WebSocket or Pi SDK implementation. */
export class VisualService {
  private readonly conversations = new Map<string, Conversation>();
  private readonly activeOwners = new Map<string, VisualOwner>();
  private readonly peers = new Map<string, VisualPeer>();
  private readonly busy = new Set<string>();
  private readonly validator = new Ajv({ strict: true, allErrors: false, validateFormats: false });

  constructor(
    private readonly storage: VisualStorage,
    private readonly scheduleDeadline: ScheduleVisualDeadline = scheduleVisualDeadline,
  ) {}

  private conversation(owner: VisualOwner): Conversation {
    const previous = this.activeOwners.get(owner.agentId);
    if (previous && previous.sessionId !== owner.sessionId) {
      const peer = this.peers.get(owner.agentId);
      if (peer) this.restore(peer, null);
    }
    this.activeOwners.set(owner.agentId, owner);
    const key = conversationKey(owner);
    const existing = this.conversations.get(key);
    if (existing) return existing;
    const conversation: Conversation = { owner, currentId: null };
    this.conversations.set(key, conversation);
    return conversation;
  }

  async observe(input: ObserveVisualInput): Promise<VisualObservation> {
    if (this.peers.has(input.agentId))
      throw new VisualFailure(
        "CLIENT_BUSY",
        "Another app connection currently owns this agent's visual surface",
      );
    const peer: VisualPeer = {
      agentId: input.agentId,
      source: input.source,
      generation: randomUUID(),
      sequence: 0,
      documentSequence: 0,
      current: null,
      actions: {},
      status: "stored",
      error: null,
      active: true,
      emit: input.emit,
      pending: new Map(),
      tail: Promise.resolve(),
    };
    this.peers.set(input.agentId, peer);
    try {
      const owner = this.activeOwners.get(input.agentId);
      const conversation = owner ? this.conversations.get(conversationKey(owner)) : undefined;
      if (conversation?.currentId) {
        const document = await this.storage.get({
          owner: conversation.owner,
          id: conversation.currentId,
        });
        if (!peer.active)
          throw new VisualFailure(
            "DISCONNECTED",
            "Visual observer disconnected during restoration",
          );
        peer.current = this.boundDocument(peer, document);
      }
      return { view: this.view(peer), release: () => this.release(peer) };
    } catch (error) {
      this.release(peer);
      throw error;
    }
  }

  close(): void {
    for (const peer of this.peers.values()) this.release(peer);
  }

  private release(peer: VisualPeer): void {
    peer.active = false;
    for (const pending of peer.pending.values()) {
      pending.cleanup();
      pending.reject(
        new VisualFailure(
          "DISCONNECTED",
          "Visual display disconnected",
          peer.current?.document.id ?? null,
        ),
      );
    }
    peer.pending.clear();
    if (this.peers.get(peer.agentId) === peer) this.peers.delete(peer.agentId);
  }

  private view(peer: VisualPeer): VisualView {
    return { generation: peer.generation, sequence: peer.sequence, current: peer.current };
  }

  private boundDocument(peer: VisualPeer, document: VisualDocument): VisualRenderDocument {
    return {
      document,
      binding: {
        id: document.id,
        revision: document.revision,
        nonce: randomUUID(),
        clientGeneration: peer.generation,
      },
    };
  }

  private restore(peer: VisualPeer, document: VisualDocument | null): void {
    for (const pending of peer.pending.values()) {
      pending.cleanup();
      pending.reject(
        new VisualFailure("STALE_DOCUMENT", "Visual document was replaced", document?.id ?? null),
      );
    }
    peer.pending.clear();
    peer.current = document ? this.boundDocument(peer, document) : null;
    peer.documentSequence = 0;
    peer.actions = {};
    peer.status = "stored";
    peer.sequence += 1;
    if (peer.active) peer.emit({ kind: "snapshot", view: this.view(peer) });
  }

  private requirePeer(owner: VisualOwner, id: string): VisualPeer {
    const peer = this.peers.get(owner.agentId);
    if (!peer?.active)
      throw new VisualFailure(
        "CLIENT_UNAVAILABLE",
        "No app is displaying this conversation's visual surface",
        id,
      );
    return peer;
  }

  async execute(
    owner: VisualOwner,
    operation: VisualOperation,
    signal: AbortSignal,
  ): Promise<VisualResult> {
    checkCancellation(signal);
    const conversation = this.conversation(owner);
    const peer = this.peers.get(owner.agentId);
    if (peer) await peer.tail;
    checkCancellation(signal);
    if (operation.kind === "list") {
      const page = await this.storage.list({
        owner,
        ...(operation.cursor ? { cursor: operation.cursor } : {}),
      });
      return {
        kind: "list",
        items: page.items.map((item) => ({
          ...item,
          status: peer?.current?.document.id === item.id ? peer.status : "stored",
        })),
        nextCursor: page.nextCursor,
      };
    }
    if (operation.kind === "context") {
      if (!conversation.currentId) return { kind: "context", visual: null };
      return { kind: "context", visual: await this.record(owner, conversation.currentId) };
    }
    const key = conversationKey(owner);
    if (this.busy.has(key))
      throw new VisualFailure(
        "BUSY",
        "Another visual operation is still awaiting a display receipt",
      );
    this.busy.add(key);
    try {
      switch (operation.kind) {
        case "present": {
          const document = await this.storage.create({
            owner,
            title: operation.title,
            html: operation.html,
          });
          await this.render(owner, document, signal, false);
          conversation.currentId = document.id;
          return this.record(owner, document.id);
        }
        case "open": {
          const document = await this.storage.get({ owner, id: operation.id });
          await this.render(owner, document, signal, false);
          conversation.currentId = document.id;
          return this.record(owner, document.id);
        }
        case "update": {
          await this.storage.get({ owner, id: operation.id });
          this.requirePeer(owner, operation.id);
          const document = await this.storage.stageSource({
            owner,
            id: operation.id,
            revision: operation.revision,
            html: operation.html,
          });
          await this.render(owner, document, signal, true, operation.revision);
          conversation.currentId = document.id;
          return this.record(owner, document.id);
        }
        case "inspect": {
          const id = operation.id ?? conversation.currentId;
          if (!id)
            throw new VisualFailure("NO_CURRENT_VISUAL", "This conversation has no current visual");
          await this.storage.get({ owner, id });
          if (operation.screenshot)
            throw new VisualFailure(
              "CAPTURE_UNSUPPORTED",
              "V1 does not provide actual-client pixel capture",
              id,
            );
          const target = this.requirePeer(owner, id);
          const current = target.current;
          if (!current || current.document.id !== id || target.status !== "rendered")
            throw new VisualFailure("NOT_DISPLAYED", "Open this visual before live inspection", id);
          await this.command(
            target,
            { kind: "inspect", commandId: randomUUID(), binding: current.binding },
            signal,
          );
          return this.record(owner, id);
        }
        case "act":
          return await this.act({ owner, operation, signal });
      }
    } finally {
      this.busy.delete(key);
    }
  }

  private async act({ owner, operation, signal }: VisualActionExecution): Promise<VisualRecord> {
    await this.storage.get({ owner, id: operation.id });
    const target = this.requirePeer(owner, operation.id);
    const current = target.current;
    if (!current || current.document.id !== operation.id || target.status !== "rendered") {
      throw new VisualFailure(
        "NOT_DISPLAYED",
        "Open this visual before invoking an action",
        operation.id,
      );
    }
    const action = Object.hasOwn(target.actions, operation.action)
      ? target.actions[operation.action]
      : undefined;
    if (!action)
      throw new VisualFailure(
        "UNKNOWN_ACTION",
        "Visual has not declared this action",
        operation.id,
      );
    assertVisualJsonBound(operation.value);
    const validate = this.validator.compile(action.parameters);
    if (!validate(operation.value))
      throw new VisualFailure(
        "INVALID_ACTION_VALUE",
        "Action value does not match its declared JSON schema",
        operation.id,
      );
    try {
      await this.command(
        target,
        {
          kind: "act",
          commandId: randomUUID(),
          binding: current.binding,
          action: operation.action,
          value: operation.value,
        },
        signal,
      );
    } catch (error) {
      this.restore(target, await this.storage.get({ owner, id: operation.id }));
      throw error;
    }
    return this.record(owner, operation.id);
  }

  private async render(
    owner: VisualOwner,
    document: VisualDocument,
    signal: AbortSignal,
    replacement: boolean,
    previousRevision = document.revision,
  ): Promise<void> {
    const peer = this.requirePeer(owner, document.id);
    const previous = peer.current?.document ?? null;
    peer.current = this.boundDocument(peer, document);
    peer.documentSequence = 0;
    peer.status = "stored";
    peer.actions = {};
    try {
      const receipt = await this.command(
        peer,
        { kind: "render", commandId: randomUUID(), current: peer.current },
        signal,
      );
      checkCancellation(signal);
      const updated = replacement
        ? await this.storage.commitSource({
            owner,
            id: document.id,
            previousRevision,
            revision: document.revision,
            stateRevision: document.stateRevision,
            snapshot: receipt.snapshot,
          })
        : await this.storage.saveState({
            owner,
            id: document.id,
            revision: document.revision,
            stateRevision: document.stateRevision,
            snapshot: receipt.snapshot,
          });
      if (!peer.active || !peer.current || !sameBinding(peer.current.binding, receipt.binding))
        throw new VisualFailure(
          "STALE_DOCUMENT",
          "Visual display changed before commit acknowledgement",
          document.id,
        );
      peer.current = { binding: receipt.binding, document: updated };
      peer.actions = receipt.actions;
      peer.status = "rendered";
      peer.error = null;
    } catch (error) {
      this.restore(peer, previous);
      if (error instanceof VisualFailure)
        throw new VisualFailure(error.code, error.message, document.id);
      throw error;
    }
  }

  private command(
    peer: VisualPeer,
    command: VisualCommand,
    signal: AbortSignal,
  ): Promise<VisualReceipt> {
    checkCancellation(signal);
    return new Promise<VisualReceipt>((resolve, reject) => {
      const failed = (code: string) => {
        peer.pending.delete(command.commandId);
        cleanup();
        reject(
          new VisualFailure(
            code,
            "Visual display did not complete the operation",
            peer.current?.document.id ?? null,
          ),
        );
      };
      const abort = () => failed("CANCELLED");
      const cancelDeadline = this.scheduleDeadline(
        () => failed("DISPLAY_TIMEOUT"),
        VISUAL_OPERATION_TIMEOUT_MS - 2000,
      );
      const cleanup = () => {
        cancelDeadline();
        signal.removeEventListener("abort", abort);
      };
      peer.pending.set(command.commandId, { kind: command.kind, resolve, reject, cleanup });
      signal.addEventListener("abort", abort, { once: true });
      peer.sequence += 1;
      try {
        peer.emit({ kind: "command", sequence: peer.sequence, command });
      } catch (error) {
        peer.pending.delete(command.commandId);
        cleanup();
        reject(error);
      }
    });
  }

  async receive(input: ReceiveVisualInput): Promise<number> {
    const peer = this.peers.get(input.agentId);
    if (!peer?.active || peer.source !== input.source)
      throw new VisualFailure(
        "STALE_CLIENT",
        "Visual receipt does not belong to this authenticated connection",
      );
    const previous = peer.tail;
    let release: () => void = () => {
      throw new Error("Receipt queue was not initialized");
    };
    peer.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      const receipt = input.receipt;
      const { current, snapshot, actions, pending } = this.validateReceipt({ peer, receipt });
      peer.documentSequence = receipt.sequence;
      if (receipt.error) {
        peer.error = receipt.error;
        peer.status = "error";
        if (pending && receipt.commandId) {
          peer.pending.delete(receipt.commandId);
          pending.cleanup();
          pending.reject(
            new VisualFailure(receipt.error.code, receipt.error.message, current.document.id),
          );
        }
        return current.document.stateRevision;
      }
      if (pending?.kind !== "render") {
        const owner = this.activeOwners.get(input.agentId);
        if (!owner) throw new VisualFailure("STALE_SESSION", "No Pi session owns this visual");
        const saved = await this.storage.get({ owner, id: current.document.id });
        const updated = await this.storage.saveState({
          owner,
          id: saved.id,
          revision: current.document.revision,
          stateRevision: saved.stateRevision,
          snapshot,
        });
        peer.current = { binding: current.binding, document: updated };
        peer.actions = actions;
        peer.status = "rendered";
        peer.error = null;
      }
      if (pending && receipt.commandId) {
        peer.pending.delete(receipt.commandId);
        pending.cleanup();
        pending.resolve({ ...receipt, snapshot, actions });
      }
      if (!peer.current || !peer.active || !sameBinding(peer.current.binding, receipt.binding)) {
        throw new VisualFailure(
          "STALE_DOCUMENT",
          "Visual display changed while committing its receipt",
        );
      }
      return peer.current.document.stateRevision;
    } finally {
      release();
    }
  }

  private validateReceipt({ peer, receipt }: ReceiptValidationInput): ValidatedVisualReceipt {
    const current = peer.current;
    if (!peer.active || !current || !sameBinding(current.binding, receipt.binding)) {
      throw new VisualFailure("STALE_DOCUMENT", "Visual receipt belongs to a replaced document");
    }
    if (receipt.sequence <= peer.documentSequence)
      throw new VisualFailure("STALE_STATE", "Visual receipt sequence has already been observed");
    const snapshot = parseVisualSnapshot(receipt.snapshot);
    const actions = parseVisualActions(receipt.actions);
    for (const action of Object.values(actions)) {
      try {
        this.validator.compile(action.parameters);
      } catch (error) {
        if (!(error instanceof Error)) throw error;
        throw new VisualFailure(
          "INVALID_ACTIONS",
          "Visual action parameters must be valid local JSON schemas",
        );
      }
    }
    const pending = receipt.commandId ? peer.pending.get(receipt.commandId) : undefined;
    if (receipt.commandId && !pending)
      throw new VisualFailure("STALE_COMMAND", "Visual command is no longer pending");
    return { current, snapshot, actions, pending };
  }

  private async record(owner: VisualOwner, id: string): Promise<VisualRecord> {
    const document = await this.storage.get({ owner, id });
    const peer = this.peers.get(owner.agentId);
    const current = peer?.current;
    const live =
      peer &&
      current &&
      current.document.id === id &&
      current.document.revision === document.revision;
    return {
      kind: "visual",
      id,
      title: document.title,
      revision: document.revision,
      stateRevision: document.stateRevision,
      state: document.snapshot.state,
      selection: document.snapshot.selection,
      status: live ? peer.status : "disconnected",
      actions: live ? peer.actions : {},
      error: live ? peer.error : null,
      client: live
        ? { id: peer.generation, generation: peer.generation, nonce: current.binding.nonce }
        : null,
    };
  }
}
