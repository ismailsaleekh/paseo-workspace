import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
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
  type VisualError,
  type VisualOperation,
  type VisualOwner,
  type VisualPlatform,
  type VisualRecord,
  type VisualResult,
} from "@getpaseo/protocol/pi-workspace/contracts";
import type {
  VisualCommand,
  VisualEvent,
  VisualReceipt,
  VisualRenderDocument,
  VisualView,
  VisualClientReceipt,
  VisualHostSignal,
} from "@getpaseo/protocol/pi-workspace/rpc-schemas";
import { VisualStorage } from "./storage.js";

const CAPTURE_OPERATION_ERRORS = new Set([
  "DISPLAY_TIMEOUT",
  "STALE_DOCUMENT",
  "STALE_STATE",
  "DISPLAY_UNAVAILABLE",
  "CAPTURE_FAILED",
  "INVALID_CAPTURE",
  "BUSY",
]);

interface PendingCommand {
  kind: VisualCommand["kind"];
  capture: boolean;
  resolve(receipt: VisualReceipt): void;
  reject(error: VisualFailure): void;
  cleanup(): void;
}
interface VisualPeer {
  agentId: string;
  source: object;
  generation: string;
  platform: VisualPlatform;
  mountOrder: number;
  sequence: number;
  documentSequence: number;
  current: VisualRenderDocument | null;
  actions: VisualActions;
  status: VisualRecord["status"];
  error: VisualRecord["error"];
  active: boolean;
  visible: boolean;
  emit(event: VisualEvent): void;
  pending: Map<string, PendingCommand>;
  tail: Promise<void>;
}
interface VisualActionExecution {
  owner: VisualOwner;
  operation: Extract<VisualOperation, { kind: "act" }>;
  signal: AbortSignal;
}
interface VisualInspectionExecution {
  owner: VisualOwner;
  operation: Extract<VisualOperation, { kind: "inspect" }>;
  signal: AbortSignal;
  currentId: string | null;
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
  platform?: VisualPlatform;
  emit(event: VisualEvent): void;
}
export interface VisualObservation {
  view: VisualView;
  release(): void;
}
export interface ReceiveVisualInput {
  agentId: string;
  source: object;
  receipt: VisualClientReceipt;
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
  private mountOrder = 0;
  private readonly validator = new Ajv({ strict: true, allErrors: false, validateFormats: false });

  constructor(
    private readonly storage: VisualStorage,
    private readonly scheduleDeadline: ScheduleVisualDeadline = scheduleVisualDeadline,
  ) {}

  private conversation(owner: VisualOwner): Conversation {
    const previous = this.activeOwners.get(owner.agentId);
    if (previous && previous.sessionId !== owner.sessionId) {
      for (const peer of this.agentPeers(owner.agentId)) this.restore(peer, null);
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
    if (this.agentPeers(input.agentId).length >= 64 || this.peers.size >= 256)
      throw new VisualFailure("BUSY", "Visual display limit reached");
    const peer: VisualPeer = {
      agentId: input.agentId,
      source: input.source,
      generation: randomUUID(),
      // COMPAT(visualPlatform): added in v0.10.3; remove after 2027-04-04 once
      // all app clients declare their display platform. V1 observes the web surface.
      platform: input.platform ?? "web",
      mountOrder: ++this.mountOrder,
      sequence: 0,
      documentSequence: 0,
      current: null,
      actions: {},
      status: "stored",
      error: null,
      active: true,
      visible: true,
      emit: input.emit,
      pending: new Map(),
      tail: Promise.resolve(),
    };
    this.peers.set(peer.generation, peer);
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
    this.peers.delete(peer.generation);
  }

  private agentPeers(agentId: string): VisualPeer[] {
    return [...this.peers.values()].filter((peer) => peer.active && peer.agentId === agentId);
  }

  private latestPeer(agentId: string, id?: string): VisualPeer | undefined {
    let latest: VisualPeer | undefined;
    for (const peer of this.agentPeers(agentId)) {
      if (!peer.visible) continue;
      if (id !== undefined && peer.current?.document.id !== id) continue;
      if (!latest || peer.mountOrder > latest.mountOrder) latest = peer;
    }
    return latest;
  }

  private synchronize(owner: VisualOwner, document: VisualDocument): void {
    for (const peer of this.agentPeers(owner.agentId)) {
      const current = peer.current;
      if (!current || current.document.id !== document.id) continue;
      if (current.document.revision !== document.revision) continue;
      peer.current = { binding: current.binding, document };
      if (peer.error?.code === "DOCUMENT_UNRESPONSIVE") continue;
      peer.sequence += 1;
      peer.emit({ kind: "snapshot", view: this.view(peer) });
    }
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
    peer.error = null;
    peer.sequence += 1;
    if (peer.active) peer.emit({ kind: "snapshot", view: this.view(peer) });
  }

  private requirePeer(owner: VisualOwner, id: string): VisualPeer {
    const peer = this.latestPeer(owner.agentId);
    if (!peer)
      throw new VisualFailure(
        "CLIENT_UNAVAILABLE",
        "No app is displaying this conversation's visual surface",
        id,
      );
    return peer;
  }

  private displayedPeer(owner: VisualOwner, id: string, client?: string): VisualPeer {
    if (client !== undefined) {
      const addressed = this.peers.get(client);
      const available =
        addressed &&
        addressed.active &&
        addressed.visible &&
        addressed.agentId === owner.agentId &&
        addressed.current?.document.id === id;
      if (!available)
        throw new VisualFailure(
          "DISPLAY_UNAVAILABLE",
          "Addressed display is not showing this visual",
          id,
        );
      return addressed;
    }
    const active = this.latestPeer(owner.agentId, id);
    if (active) return active;
    this.requirePeer(owner, id);
    throw new VisualFailure("NOT_DISPLAYED", "Open this visual before live inspection", id);
  }

  async execute(
    owner: VisualOwner,
    operation: VisualOperation,
    signal: AbortSignal,
  ): Promise<VisualResult> {
    checkCancellation(signal);
    const conversation = this.conversation(owner);
    await Promise.all(this.agentPeers(owner.agentId).map((peer) => peer.tail));
    const peer = this.latestPeer(owner.agentId);
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
        case "inspect":
          return await this.inspect({
            owner,
            operation,
            signal,
            currentId: conversation.currentId,
          });
        case "act":
          return await this.act({ owner, operation, signal });
      }
    } finally {
      this.busy.delete(key);
    }
  }

  private async inspect({
    owner,
    operation,
    signal,
    currentId,
  }: VisualInspectionExecution): Promise<VisualRecord> {
    const id = operation.id ?? currentId;
    if (!id)
      throw new VisualFailure("NO_CURRENT_VISUAL", "This conversation has no current visual");
    await this.storage.get({ owner, id });
    const target = this.displayedPeer(owner, id, operation.client);
    this.requireResponsive(target, id);
    const current = target.current;
    if (!current || target.status !== "rendered")
      throw new VisualFailure("NOT_DISPLAYED", "Open this visual before live inspection", id);
    if (operation.screenshot && target.platform !== "electron")
      throw new VisualFailure(
        "CAPTURE_UNSUPPORTED",
        "This display does not provide actual-client pixel capture",
        id,
      );
    const receipt = await this.command(
      target,
      {
        kind: "inspect",
        commandId: randomUUID(),
        binding: current.binding,
        ...(operation.screenshot
          ? { screenshot: true, stateRevision: current.document.stateRevision }
          : {}),
      },
      signal,
    );
    if (
      !target.active ||
      !target.visible ||
      !target.current ||
      !sameBinding(target.current.binding, current.binding)
    )
      throw new VisualFailure("DISPLAY_UNAVAILABLE", "Display changed during inspection", id);
    const record = await this.record(owner, id, target.generation);
    const capture = receipt.capture;
    if (!capture) return record;
    if (
      record.revision !== capture.screenshot.revision ||
      record.stateRevision !== capture.screenshot.stateRevision
    )
      throw new VisualFailure("STALE_STATE", "Stored state changed during capture", id);
    return { ...record, capture };
  }

  private requireResponsive(peer: VisualPeer, id: string): void {
    if (peer.error?.code === "DOCUMENT_UNRESPONSIVE")
      throw new VisualFailure("DOCUMENT_UNRESPONSIVE", "Reopen the terminated visual document", id);
  }

  private async act({ owner, operation, signal }: VisualActionExecution): Promise<VisualRecord> {
    await this.storage.get({ owner, id: operation.id });
    const target = this.displayedPeer(owner, operation.id);
    this.requireResponsive(target, operation.id);
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
      const retained =
        error instanceof VisualFailure &&
        (error.code === "DOCUMENT_UNRESPONSIVE" || error.code === "STALE_STATE");
      if (!retained) this.restore(target, await this.storage.get({ owner, id: operation.id }));
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
    peer.error = null;
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
      peer.mountOrder = ++this.mountOrder;
      this.synchronize(owner, updated);
      for (const other of this.agentPeers(owner.agentId)) {
        if (other !== peer) this.restore(other, updated);
      }
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
      peer.pending.set(command.commandId, {
        kind: command.kind,
        capture: command.kind === "inspect" && command.screenshot === true,
        resolve,
        reject,
        cleanup,
      });
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
    const peer = this.peers.get(input.receipt.binding.clientGeneration);
    if (!peer?.active || peer.agentId !== input.agentId || peer.source !== input.source)
      throw new VisualFailure(
        "STALE_CLIENT",
        "Visual receipt does not belong to this authenticated connection",
      );
    const receipt = input.receipt;
    if ("kind" in receipt) return this.receiveHostSignal(peer, receipt);
    if (!peer.visible)
      throw new VisualFailure(
        "DISPLAY_UNAVAILABLE",
        "Hidden display cannot publish visual state",
        receipt.binding.id,
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
      this.requireResponsive(peer, receipt.binding.id);
      const validated = this.validateReceipt({ peer, receipt });
      const { current, snapshot, actions, pending } = validated;
      peer.documentSequence = receipt.sequence;
      if (receipt.error) {
        this.rejectReceipt({ peer, receipt }, receipt.error, pending);
        return current.document.stateRevision;
      }
      if (pending?.kind !== "render") await this.publishReceipt({ peer, receipt }, validated);
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
    } catch (error) {
      await this.receiptFailure({ peer, receipt }, error);
      throw error;
    } finally {
      release();
    }
  }

  private rejectReceipt(
    { peer, receipt }: ReceiptValidationInput,
    error: VisualError,
    pending: PendingCommand | undefined,
  ): void {
    const captureFailure = pending?.capture && CAPTURE_OPERATION_ERRORS.has(error.code);
    if (!captureFailure) {
      peer.error = error;
      peer.status = "error";
    }
    if (pending && receipt.commandId) {
      peer.pending.delete(receipt.commandId);
      pending.cleanup();
      pending.reject(new VisualFailure(error.code, error.message, receipt.binding.id));
    }
  }

  private receiveHostSignal(peer: VisualPeer, signal: VisualHostSignal): number {
    const current = peer.current;
    if (!current || !sameBinding(current.binding, signal.binding))
      throw new VisualFailure("STALE_DOCUMENT", "Host event belongs to a replaced visual");
    if (peer.platform !== "electron")
      throw new VisualFailure(
        "UNSUPPORTED_CLIENT",
        "This display has no trusted desktop event channel",
      );
    if (signal.kind === "visibility") {
      peer.visible = signal.visible;
      if (!peer.visible) {
        for (const pending of peer.pending.values()) {
          pending.cleanup();
          pending.reject(
            new VisualFailure(
              "DISPLAY_UNAVAILABLE",
              "Visual display was hidden",
              current.document.id,
            ),
          );
        }
        peer.pending.clear();
      }
    } else {
      if (!peer.visible)
        throw new VisualFailure("DISPLAY_UNAVAILABLE", "Hidden display cannot claim activity");
      this.requireResponsive(peer, current.document.id);
      peer.mountOrder = ++this.mountOrder;
    }
    return current.document.stateRevision;
  }

  private async receiptFailure(input: ReceiptValidationInput, error: unknown): Promise<void> {
    if (!(error instanceof VisualFailure)) return;
    if (error.code === "STALE_STATE") await this.recoverStaleState(input, error);
    if (error.code === "INVALID_CAPTURE" && input.receipt.commandId) {
      const pending = input.peer.pending.get(input.receipt.commandId);
      if (pending) {
        input.peer.pending.delete(input.receipt.commandId);
        pending.cleanup();
        pending.reject(error);
      }
    }
  }

  private async publishReceipt(
    { peer, receipt }: ReceiptValidationInput,
    { current, snapshot, actions }: ValidatedVisualReceipt,
  ): Promise<void> {
    const owner = this.activeOwners.get(peer.agentId);
    if (!owner) throw new VisualFailure("STALE_SESSION", "No Pi session owns this visual");
    if (receipt.capture) {
      const stored = await this.storage.get({ owner, id: current.document.id });
      if (
        stored.stateRevision !== receipt.capture.screenshot.stateRevision ||
        !isDeepStrictEqual(stored.snapshot, snapshot)
      )
        throw new VisualFailure(
          "STALE_STATE",
          "Capture did not observe the authoritative stored state",
        );
      peer.actions = actions;
      return;
    }
    // COMPAT(visualStateBase): added in v0.10.3; remove after 2027-04-04 once all
    // visual clients publish an explicit base. V1 receipts use their bound view's base.
    const stateRevision = receipt.stateRevision ?? current.document.stateRevision;
    const updated = await this.storage.saveState({
      owner,
      id: current.document.id,
      revision: current.document.revision,
      stateRevision,
      snapshot,
    });
    // Activity order is fixed at observation, render or trusted interaction. A late mount
    // receipt must not displace a display the user interacted with in the meantime.
    peer.current = { binding: current.binding, document: updated };
    peer.actions = actions;
    peer.status = "rendered";
    peer.error = null;
    this.synchronize(owner, updated);
  }

  private async recoverStaleState(
    { peer, receipt }: ReceiptValidationInput,
    error: VisualFailure,
  ): Promise<void> {
    const pending = receipt.commandId ? peer.pending.get(receipt.commandId) : undefined;
    if (pending && receipt.commandId) {
      peer.pending.delete(receipt.commandId);
      pending.cleanup();
      pending.reject(error);
    }
    const owner = this.activeOwners.get(peer.agentId);
    const current = peer.current;
    if (owner && current && sameBinding(current.binding, receipt.binding)) {
      const stored = await this.storage.get({ owner, id: current.document.id });
      this.synchronize(owner, stored);
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
    this.validateCapture({ peer, receipt }, current, pending);
    return { current, snapshot, actions, pending };
  }

  private validateCapture(
    input: ReceiptValidationInput,
    current: VisualRenderDocument,
    pending: PendingCommand | undefined,
  ): void {
    const capture = input.receipt.capture;
    if (input.receipt.error) return;
    if (!capture) {
      if (pending?.capture)
        throw new VisualFailure("INVALID_CAPTURE", "Requested capture is missing");
      return;
    }
    const valid =
      pending?.capture &&
      input.peer.platform === "electron" &&
      input.peer.visible &&
      capture.operationId === input.receipt.commandId &&
      sameBinding(capture.binding, current.binding) &&
      capture.screenshot.client === input.peer.generation &&
      capture.screenshot.revision === current.document.revision &&
      capture.screenshot.stateRevision === input.receipt.stateRevision;
    if (!valid)
      throw new VisualFailure(
        "INVALID_CAPTURE",
        "Capture does not match the pending display operation",
      );
  }

  private async record(owner: VisualOwner, id: string, client?: string): Promise<VisualRecord> {
    const document = await this.storage.get({ owner, id });
    const active = this.latestPeer(owner.agentId, id);
    const peer = client === undefined ? active : this.displayedPeer(owner, id, client);
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
      client: live ? peer.generation : null,
      displays: this.agentPeers(owner.agentId)
        .filter((display) => display.visible && display.current?.document.id === id)
        .map((display) => ({
          client: display.generation,
          platform: display.platform,
          active: display === active,
        })),
    };
  }
}
