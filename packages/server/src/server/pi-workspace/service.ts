import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { Ajv } from "ajv";
import {
  VisualFailure,
  VISUAL_OPERATION_TIMEOUT_MS,
  VISUAL_CAPTURE_PLATFORMS,
  VISUAL_HOST_SIGNAL_PLATFORMS,
  VISUAL_RENDERER_UNAVAILABLE,
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
  VisualLibraryOperation,
  VisualLibraryResult,
} from "@getpaseo/protocol/pi-workspace/rpc-schemas";
import { VisualStorage } from "./storage.js";
import { encodeVisualView } from "@getpaseo/protocol/pi-workspace/rpc-schemas";
import {
  DEFAULT_SPEECH_VOICE,
  parseSpeechReceipt,
  speechEvent,
  type SpeechDevice,
  type SpeechEvent,
  type SpeechPlayback,
  type SpeechReceipt,
  type SpeechResult,
  type SpeechVoice,
} from "@getpaseo/protocol/pi-workspace/speech";
import { PRESENCE_THRESHOLD_MS, type ClientPresenceState } from "../agent-attention-policy.js";
import type { TextToSpeechProvider } from "../speech/speech-provider.js";
import { SPEECH_VOICE_SPEAKERS, SpeechUtterances } from "./speech.js";

/** A display must acknowledge within this budget; the agent tool allows the operation 2 s more. */
const DISPLAY_DEADLINE_MS = VISUAL_OPERATION_TIMEOUT_MS - 2000;
/** Longest wait for a re-established display before a released one fails a render. */
const REPLACEMENT_WAIT_MS = 4000;
/** Smallest acknowledgement window worth re-targeting a render into. */
const MIN_RENDER_MS = 1000;

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
  owner: VisualOwner | null;
  library: boolean;
  drawingVisible: boolean;
  historical: boolean;
  selectionIntent: number;
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
  /** The observation announced agent speech playback with a `ready` speech receipt. */
  speech: boolean;
  speechReceipts: number;
  /** The owning connection's `client_heartbeat` presence, when it reported one. */
  presence(): ClientPresenceState | null;
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
interface SaveReceiptStateInput {
  owner: VisualOwner;
  id: string;
  revision: number;
  stateRevision: number;
  snapshot: VisualDocument["snapshot"];
  /** An agent inspection: it reports state and must not fail on a concurrent change. */
  read: boolean;
}
interface RenderRequest {
  owner: VisualOwner;
  document: VisualDocument;
  signal: AbortSignal;
  replacement: boolean;
  previousRevision: number;
  /** Wall-clock end of the display budget shared by the first and a re-targeted attempt. */
  deadline: number;
}
interface Conversation {
  owner: VisualOwner;
  currentId: string | null;
}
interface VisualLibraryInput {
  owner: VisualOwner;
  source: object;
  generation: string;
  operation: VisualLibraryOperation;
}
export interface ObserveVisualInput {
  agentId: string;
  owner?: VisualOwner | null;
  library?: boolean;
  source: object;
  platform?: VisualPlatform;
  emit(event: VisualEvent): void;
  presence?: () => ClientPresenceState | null;
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
/** The daemon's local agent-speech engine; independent of realtime voice mode. */
export interface VisualSpeechHost {
  resolveTts(): TextToSpeechProvider | null;
}
export interface SpeakVisualInput {
  utterance: string;
  text: string;
  voice?: SpeechVoice;
  /** The device the user asked for; absent plays where the user is talking from. */
  device?: SpeechDevice;
}
/** An app connection that plays the agent speech of every conversation. */
export interface ObserveSpeechInput {
  source: object;
  /** The app installation's stable client ID. */
  clientId: string;
  device: SpeechDevice;
  /** The app keeps playing while hidden (desktop apps always do). */
  background: boolean;
  presence(): ClientPresenceState | null;
  emit(agentId: string, voice: SpeechVoice, speech: SpeechEvent): void;
}
export interface SpeechObservation {
  generation: string;
  release(): void;
}
interface SpeechClient extends Omit<ObserveSpeechInput, "source"> {
  source: object;
  generation: string;
  mountOrder: number;
  active: boolean;
  receipts: number;
}
/** A playback client able to take the next utterance. */
interface SpeechCandidate {
  generation: string;
  clientId: string | null;
  device: SpeechDevice;
  playable: boolean;
  rank: number[];
  send(agentId: string, voice: SpeechVoice, playback: SpeechPlayback): void;
}

function isSpeechReceipt(receipt: VisualClientReceipt): receipt is SpeechReceipt {
  return "kind" in receipt && receipt.kind === "speech";
}
/** Resolves when the previous utterance of the conversation settled; rejects on cancellation. */
function waitForSpeechTurn(
  previous: Promise<void>,
  signal: AbortSignal,
  utterance: string,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const abort = () =>
      reject(new VisualFailure("CANCELLED", "Speech was cancelled while queued", utterance));
    if (signal.aborted) {
      abort();
      return;
    }
    signal.addEventListener("abort", abort, { once: true });
    void previous.then(() => {
      signal.removeEventListener("abort", abort);
      resolve();
      return undefined;
    });
  });
}
/**
 * Presence rank of a display that shows the conversation: focused on the agent, then recent
 * activity, then the latest mount. Activity age only ranks; an idle operator still hears speech.
 */
function speechRank(
  presence: ClientPresenceState | null,
  mountOrder: number,
  agentId: string,
  now: number,
): number[] {
  const reported = presence ? presence.lastActivityAtMs : null;
  const activity = reported === null ? null : Math.min(reported, now);
  const present = activity !== null && now - activity <= PRESENCE_THRESHOLD_MS;
  return [
    presence?.focusedAgentId === agentId ? 1 : 0,
    present && activity !== null ? activity : Number.NEGATIVE_INFINITY,
    mountOrder,
  ];
}
function outranks(left: number[], right: number[]): boolean {
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index] ?? 0;
    const b = right[index] ?? 0;
    if (a !== b) return a > b;
  }
  return false;
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
  private readonly replacementWaiters = new Set<() => void>();
  private mountOrder = 0;
  private readonly validator = new Ajv({ strict: true, allErrors: false, validateFormats: false });
  private speechHost: VisualSpeechHost | null = null;
  private readonly utterances: SpeechUtterances;
  /** One voice at a time: utterances of every conversation play in order. */
  private speechTail: Promise<void> = Promise.resolve();
  private readonly speechClients = new Map<string, SpeechClient>();
  /** Conversations whose speech the user stopped, until the user's next message. */
  private readonly stoppedSpeech = new Set<string>();
  /** The app client the user last messaged each conversation from. */
  private readonly lastUserClient = new Map<string, string>();

  constructor(
    private readonly storage: VisualStorage,
    private readonly scheduleDeadline: ScheduleVisualDeadline = scheduleVisualDeadline,
  ) {
    this.utterances = new SpeechUtterances(scheduleDeadline);
  }

  /** Connects the daemon's local speech engine; created after this service at bootstrap. */
  connectSpeech(host: VisualSpeechHost): void {
    this.speechHost = host;
  }

  private conversation(owner: VisualOwner): Conversation {
    const previous = this.activeOwners.get(owner.agentId);
    if (previous && previous.sessionId !== owner.sessionId) {
      for (const peer of this.agentPeers(owner.agentId)) {
        peer.owner = owner;
        this.restore(peer, null);
      }
    }
    this.activeOwners.set(owner.agentId, owner);
    for (const peer of this.agentPeers(owner.agentId)) peer.owner = owner;
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
      owner: input.owner ?? null,
      library: input.library === true,
      drawingVisible: input.library !== true,
      historical: false,
      selectionIntent: 0,
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
      speech: false,
      speechReceipts: 0,
      presence: input.presence ?? (() => null),
    };
    this.peers.set(peer.generation, peer);
    try {
      if (input.owner) this.conversation(input.owner);
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
      // Operations waiting for a re-established display re-check after this observation's
      // response reached the client (a zero-delay deadline runs after the session reply).
      for (const wake of this.replacementWaiters) this.scheduleDeadline(wake, 0);
      return { view: this.view(peer), release: () => this.release(peer) };
    } catch (error) {
      this.release(peer);
      throw error;
    }
  }

  private libraryPeer(input: VisualLibraryInput): VisualPeer {
    const peer = this.peers.get(input.generation);
    if (
      !peer ||
      !peer.active ||
      !peer.library ||
      peer.source !== input.source ||
      peer.agentId !== input.owner.agentId
    )
      throw new VisualFailure("STALE_CLIENT", "Library request does not own this physical display");
    return peer;
  }

  private checkLibraryConversation(peer: VisualPeer, input: VisualLibraryInput): void {
    if (
      !peer.active ||
      this.peers.get(input.generation) !== peer ||
      (peer.owner && conversationKey(peer.owner) !== conversationKey(input.owner))
    )
      throw new VisualFailure("STALE_SESSION", "Library conversation changed");
    const previous = this.activeOwners.get(input.owner.agentId);
    if (previous && conversationKey(previous) !== conversationKey(input.owner))
      throw new VisualFailure(
        "STALE_SESSION",
        "Stored Pi conversation does not own the active display",
      );
  }

  async library(input: VisualLibraryInput): Promise<VisualLibraryResult> {
    const peer = this.libraryPeer(input);
    const check = () => this.checkLibraryConversation(peer, input);
    check();
    const operation = input.operation;
    const selecting = operation.kind === "select" || operation.kind === "visibility";
    const intent = selecting ? (operation.intent ?? peer.selectionIntent + 1) : null;
    if (intent !== null) {
      if (!Number.isSafeInteger(intent) || intent <= peer.selectionIntent)
        throw new VisualFailure("STALE_SELECTION", "Library choice has been superseded");
      peer.selectionIntent = intent;
    }
    const checkIntent = () => {
      check();
      if (intent !== null && intent !== peer.selectionIntent)
        throw new VisualFailure("STALE_SELECTION", "Library choice has been superseded");
    };
    await peer.tail;
    checkIntent();
    this.conversation(input.owner);
    if (operation.kind === "list") {
      const page = await this.storage.list({
        owner: input.owner,
        ...(operation.cursor === undefined ? {} : { cursor: operation.cursor }),
      });
      check();
      return { kind: "list", ...page };
    }
    if (operation.kind === "versions") {
      const page = await this.storage.listVersions({
        owner: input.owner,
        id: operation.id,
        ...(operation.cursor === undefined ? {} : { cursor: operation.cursor }),
      });
      check();
      return { kind: "versions", ...page };
    }
    if (operation.kind === "select") {
      const document =
        operation.revision === null
          ? await this.storage.get({ owner: input.owner, id: operation.id })
          : await this.storage.getVersion({
              owner: input.owner,
              id: operation.id,
              revision: operation.revision,
            });
      checkIntent();
      this.restore(peer, document);
      peer.historical = document.historyState !== undefined;
      this.conversation(input.owner).currentId = document.id;
    } else {
      if (operation.visible && peer.current) {
        const document = peer.historical
          ? peer.current.document
          : await this.storage.get({ owner: input.owner, id: peer.current.document.id });
        checkIntent();
        this.restore(peer, document);
      }
      checkIntent();
      peer.drawingVisible = operation.visible;
      if (!operation.visible) {
        for (const pending of peer.pending.values()) {
          pending.cleanup();
          pending.reject(new VisualFailure("DISPLAY_UNAVAILABLE", "Drawing sidebar was closed"));
        }
        peer.pending.clear();
        peer.status = "stored";
      }
    }
    return { kind: "view", view: encodeVisualView(this.view(peer)) };
  }

  close(): void {
    for (const peer of this.peers.values()) this.release(peer);
    for (const client of this.speechClients.values()) this.releaseSpeechClient(client);
    this.utterances.close();
  }

  private release(peer: VisualPeer): void {
    peer.active = false;
    this.utterances.release(peer.generation);
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
      if (!peer.visible || !peer.drawingVisible) continue;
      if (id !== undefined && peer.current?.document.id !== id) continue;
      if (!latest || peer.mountOrder > latest.mountOrder) latest = peer;
    }
    return latest;
  }

  private synchronize(owner: VisualOwner, document: VisualDocument): void {
    for (const peer of this.agentPeers(owner.agentId)) {
      const current = peer.current;
      if (!current || peer.historical || current.document.id !== document.id) continue;
      if (current.document.revision !== document.revision) continue;
      peer.current = { binding: current.binding, document };
      if (peer.error?.code === "DOCUMENT_UNRESPONSIVE") continue;
      peer.sequence += 1;
      peer.emit({ kind: "snapshot", view: this.view(peer) });
    }
  }

  private view(peer: VisualPeer): VisualView {
    return {
      generation: peer.generation,
      sequence: peer.sequence,
      current: peer.current,
      ...(peer.library
        ? { sessionId: peer.owner?.sessionId ?? null, selectionIntent: peer.selectionIntent }
        : {}),
    };
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
    peer.historical = document?.historyState !== undefined;
    peer.actions = {};
    peer.status = "stored";
    peer.error = null;
    peer.sequence += 1;
    if (peer.active) peer.emit({ kind: "snapshot", view: this.view(peer) });
  }

  private requirePeer(owner: VisualOwner, id: string): VisualPeer {
    const peer =
      this.latestPeer(owner.agentId) ??
      this.agentPeers(owner.agentId).findLast(
        (candidate) => candidate.library && candidate.visible,
      );
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
        addressed.drawingVisible &&
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
          status:
            peer?.current?.document.id === item.id &&
            peer.current.document.revision === item.revision
              ? peer.status
              : "stored",
        })),
        nextCursor: page.nextCursor,
      };
    }
    if (operation.kind === "context") {
      if (!conversation.currentId) return { kind: "context", visual: null };
      const displayed = this.latestPeer(owner.agentId, conversation.currentId);
      return {
        kind: "context",
        visual: await this.record(owner, conversation.currentId, displayed?.generation),
      };
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

  /** Registers an app connection that plays agent speech whatever the app displays. */
  observeSpeech(input: ObserveSpeechInput): SpeechObservation {
    if (this.speechClients.size >= 64)
      throw new VisualFailure("BUSY", "Speech playback client limit reached");
    const client: SpeechClient = {
      ...input,
      generation: randomUUID(),
      mountOrder: ++this.mountOrder,
      active: true,
      receipts: 0,
    };
    this.speechClients.set(client.generation, client);
    return { generation: client.generation, release: () => this.releaseSpeechClient(client) };
  }

  /** The user messaged a conversation: speech plays where they are and may start again. */
  noteUserMessage(agentId: string, clientId: string): void {
    this.stoppedSpeech.delete(agentId);
    // Only an app that plays speech is a destination; a message from elsewhere leaves none.
    const plays = [...this.speechClients.values()].some((client) => client.clientId === clientId);
    if (plays) this.lastUserClient.set(agentId, clientId);
    else this.lastUserClient.delete(agentId);
  }

  private releaseSpeechClient(client: SpeechClient): void {
    if (!client.active) return;
    client.active = false;
    this.speechClients.delete(client.generation);
    this.utterances.release(client.generation);
  }

  /**
   * Speaks one utterance on exactly one client, chosen when its turn starts and kept until it
   * ends: the requested device, else the app the user last messaged from, else the best-ranked
   * playing app. A user stop ends the conversation's speech until the user's next message.
   */
  async speak(
    owner: VisualOwner,
    request: SpeakVisualInput,
    signal: AbortSignal,
  ): Promise<SpeechResult> {
    if (signal.aborted)
      throw new VisualFailure("CANCELLED", "Speech was cancelled", request.utterance);
    this.conversation(owner);
    const previous = this.speechTail;
    let releaseTurn: () => void = () => {
      throw new Error("Speech turn was not initialized");
    };
    const turn = new Promise<void>((resolve) => {
      releaseTurn = resolve;
    });
    // A cancelled queued utterance leaves the queue without letting later ones overtake.
    const tail = previous.then(() => turn);
    this.speechTail = tail;
    try {
      await waitForSpeechTurn(previous, signal, request.utterance);
      if (this.stoppedSpeech.has(owner.agentId))
        throw new VisualFailure(
          "SPEECH_STOPPED",
          "The user stopped speech playback; do not speak again until they ask",
          request.utterance,
        );
      const target = this.speechTarget(owner.agentId, request);
      const tts = this.speechHost?.resolveTts() ?? null;
      if (!tts)
        throw new VisualFailure(
          "TTS_UNAVAILABLE",
          "No local text-to-speech engine is available on this host",
          request.utterance,
        );
      const voice = request.voice ?? DEFAULT_SPEECH_VOICE;
      const result = await this.utterances.speak({
        utterance: request.utterance,
        text: request.text,
        tts,
        signal,
        speakerId: SPEECH_VOICE_SPEAKERS[voice],
        target: {
          client: target.generation,
          send: (playback) => target.send(owner.agentId, voice, playback),
        },
      });
      if (result.status === "stopped") this.stoppedSpeech.add(owner.agentId);
      return result;
    } finally {
      releaseTurn();
    }
  }

  private speechTarget(agentId: string, request: SpeakVisualInput): SpeechCandidate {
    const candidates = this.speechCandidates(agentId);
    const lastUser = request.device === undefined ? this.lastUserClient.get(agentId) : undefined;
    if (lastUser !== undefined) {
      // Speech plays where the user talks from and never silently moves to another device.
      const intended = candidates.find((candidate) => candidate.clientId === lastUser);
      if (!intended?.playable)
        throw new VisualFailure(
          "DEVICE_UNAVAILABLE",
          intended
            ? `Paseo on the user's ${intended.device} is in the background and cannot play speech; ask the user to open it or to name another device`
            : "The app the user is talking from is no longer connected; ask the user to open it or to name another device",
          request.utterance,
        );
      return intended;
    }
    let best: SpeechCandidate | undefined;
    for (const candidate of candidates) {
      if (!candidate.playable) continue;
      if (request.device !== undefined && candidate.device !== request.device) continue;
      if (!best || outranks(candidate.rank, best.rank)) best = candidate;
    }
    if (best) return best;
    if (request.device !== undefined)
      throw new VisualFailure(
        "DEVICE_UNAVAILABLE",
        `No Paseo app on the user's ${request.device} can play speech now`,
        request.utterance,
      );
    throw new VisualFailure(
      "CLIENT_UNAVAILABLE",
      "No app with speech playback is displaying this conversation",
      request.utterance,
    );
  }

  private speechCandidates(agentId: string): SpeechCandidate[] {
    const now = Date.now();
    const candidates: SpeechCandidate[] = [];
    for (const client of this.speechClients.values()) {
      const presence = client.presence();
      candidates.push({
        generation: client.generation,
        clientId: client.clientId,
        device: client.device,
        playable:
          client.device === "computer" || client.background || presence?.appVisible !== false,
        rank: speechRank(presence, client.mountOrder, agentId, now),
        send: (owner, voice, playback) => {
          if (!client.active)
            throw new VisualFailure(
              "CLIENT_DISCONNECTED",
              "The playback client disconnected",
              playback.utterance,
            );
          client.emit(owner, voice, speechEvent(playback));
        },
      });
    }
    // COMPAT(piSpeech): apps before v0.10.4 play speech in a displayed conversation only.
    for (const peer of this.agentPeers(agentId)) {
      if (!peer.speech || !peer.visible) continue;
      const presence = peer.presence();
      candidates.push({
        generation: peer.generation,
        clientId: null,
        device: peer.platform === "android" || peer.platform === "ios" ? "phone" : "computer",
        // A hidden app (for example a backgrounded Android app) does not display the conversation.
        playable: presence?.appVisible !== false,
        rank: speechRank(presence, peer.mountOrder, agentId, now),
        send: (_owner, _voice, playback) => {
          if (!peer.active)
            throw new VisualFailure(
              "CLIENT_DISCONNECTED",
              "The playback client disconnected",
              playback.utterance,
            );
          peer.emit({ kind: "speech", speech: speechEvent(playback) });
        },
      });
    }
    return candidates;
  }

  private receiveSpeech(input: ReceiveVisualInput, receipt: SpeechReceipt): number {
    const signal = parseSpeechReceipt(receipt);
    const client = this.speechClients.get(receipt.clientGeneration);
    if (client) {
      if (!client.active || client.source !== input.source)
        throw new VisualFailure(
          "STALE_CLIENT",
          "Speech receipt does not belong to this authenticated connection",
        );
      if (!signal)
        throw new VisualFailure(
          "INVALID_SPEECH_REPORT",
          "Speech receipt fields do not match its type",
        );
      if (signal.type !== "ready") this.utterances.receive(client.generation, signal);
      client.receipts += 1;
      return client.receipts;
    }
    const peer = this.peers.get(receipt.clientGeneration);
    if (!peer?.active || peer.agentId !== input.agentId || peer.source !== input.source)
      throw new VisualFailure(
        "STALE_CLIENT",
        "Speech receipt does not belong to this authenticated connection",
      );
    if (!signal)
      throw new VisualFailure(
        "INVALID_SPEECH_REPORT",
        "Speech receipt fields do not match its type",
      );
    if (signal.type === "ready") peer.speech = true;
    else this.utterances.receive(peer.generation, signal);
    peer.speechReceipts += 1;
    return peer.speechReceipts;
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
    if (operation.screenshot && !VISUAL_CAPTURE_PLATFORMS.has(target.platform))
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
    if (peer.error?.code === VISUAL_RENDERER_UNAVAILABLE)
      throw new VisualFailure(
        VISUAL_RENDERER_UNAVAILABLE,
        "This display cannot render visuals; install or repair its visual host, then reopen the visual",
        id,
      );
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
      if (!retained && !target.historical)
        this.restore(target, await this.storage.get({ owner, id: operation.id }));
      throw error;
    }
    return this.record(owner, operation.id, target.generation);
  }

  private requireRestorationDisplay(
    peer: VisualPeer,
    document: VisualDocument,
    previousRevision: number,
  ): void {
    const latestView = peer.current?.document;
    if (
      peer.library &&
      (!peer.drawingVisible ||
        peer.historical ||
        latestView?.id !== document.id ||
        latestView.revision !== previousRevision)
    )
      throw new VisualFailure(
        "NOT_DISPLAYED",
        "Open this drawing's Latest view before replacing its source; restoration must be verified",
        document.id,
      );
  }

  private async render(
    owner: VisualOwner,
    document: VisualDocument,
    signal: AbortSignal,
    replacement: boolean,
    previousRevision = document.revision,
  ): Promise<void> {
    const request: RenderRequest = {
      owner,
      document,
      signal,
      replacement,
      previousRevision,
      deadline: Date.now() + DISPLAY_DEADLINE_MS,
    };
    const peer = this.requirePeer(owner, document.id);
    const preserveHistory = peer.historical && peer.current?.document.id === document.id;
    if (replacement) this.requireRestorationDisplay(peer, document, previousRevision);
    if (peer.library && (!peer.drawingVisible || preserveHistory)) {
      if (!preserveHistory) this.restore(peer, document);
      for (const other of this.agentPeers(owner.agentId)) {
        if (other !== peer && !other.historical) this.restore(other, document);
      }
      return;
    }
    try {
      await this.renderOn(peer, request, DISPLAY_DEADLINE_MS);
    } catch (error) {
      // The same app may re-establish its display mid-operation (relaunch, reconnect, panel
      // remount). Rendering is idempotent, so it is re-targeted once to the replacement display
      // within the original display budget; without one the original failure stands.
      const next = await this.replacementFor(peer, error, request);
      if (!next) throw error;
      await this.renderOn(next, request, Math.max(MIN_RENDER_MS, request.deadline - Date.now()));
    }
  }

  private async replacementFor(
    peer: VisualPeer,
    error: unknown,
    request: RenderRequest,
  ): Promise<VisualPeer | undefined> {
    const released =
      error instanceof VisualFailure && error.code === "DISCONNECTED" && !peer.active;
    const remaining = request.deadline - Date.now() - MIN_RENDER_MS;
    if (!released || request.signal.aborted || remaining <= 0) return undefined;
    return this.waitForReplacement(peer, request.signal, Math.min(REPLACEMENT_WAIT_MS, remaining));
  }

  private waitForReplacement(
    released: VisualPeer,
    signal: AbortSignal,
    milliseconds: number,
  ): Promise<VisualPeer | undefined> {
    return new Promise((resolve) => {
      let settled = false;
      const cancels: (() => void)[] = [];
      const finish = (found: VisualPeer | undefined) => {
        if (settled) return;
        settled = true;
        this.replacementWaiters.delete(check);
        signal.removeEventListener("abort", abort);
        for (const cancel of cancels) cancel();
        resolve(found);
      };
      const check = () => {
        const candidate = this.latestPeer(released.agentId);
        if (candidate && candidate !== released) finish(candidate);
      };
      const abort = () => finish(undefined);
      signal.addEventListener("abort", abort, { once: true });
      this.replacementWaiters.add(check);
      cancels.push(this.scheduleDeadline(() => finish(undefined), milliseconds));
      // A replacement that observed before the release was processed is already present.
      cancels.push(this.scheduleDeadline(check, 0));
    });
  }

  private async renderOn(
    peer: VisualPeer,
    request: RenderRequest,
    milliseconds: number,
  ): Promise<void> {
    const { owner, document, signal, replacement, previousRevision } = request;
    const previous = peer.current?.document ?? null;
    peer.current = this.boundDocument(peer, document);
    peer.historical = false;
    peer.documentSequence = 0;
    peer.status = "stored";
    peer.actions = {};
    peer.error = null;
    try {
      const receipt = await this.command(
        peer,
        { kind: "render", commandId: randomUUID(), current: peer.current },
        signal,
        milliseconds,
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
        if (other !== peer && !other.historical) this.restore(other, updated);
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
    milliseconds = DISPLAY_DEADLINE_MS,
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
      const cancelDeadline = this.scheduleDeadline(() => failed("DISPLAY_TIMEOUT"), milliseconds);
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
    const receipt = input.receipt;
    if (isSpeechReceipt(receipt)) return this.receiveSpeech(input, receipt);
    const peer = this.peers.get(receipt.binding.clientGeneration);
    if (!peer?.active || peer.agentId !== input.agentId || peer.source !== input.source)
      throw new VisualFailure(
        "STALE_CLIENT",
        "Visual receipt does not belong to this authenticated connection",
      );
    if ("kind" in receipt) return this.receiveHostSignal(peer, receipt);
    if (!peer.visible || !peer.drawingVisible)
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
      let stored: number | null = null;
      if (pending?.kind !== "render")
        stored = await this.publishReceipt({ peer, receipt }, validated);
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
      // The answer names the stored revision this receipt produced (or found unchanged), so a
      // publishing document can continue on exactly that base.
      return stored ?? peer.current.document.stateRevision;
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
    if (!VISUAL_HOST_SIGNAL_PLATFORMS.has(peer.platform))
      throw new VisualFailure(
        "UNSUPPORTED_CLIENT",
        "This display has no trusted host event channel",
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

  private publishHistoricalReceipt(
    { peer, receipt }: ReceiptValidationInput,
    { current, snapshot, actions }: ValidatedVisualReceipt,
  ): number {
    const base = receipt.stateRevision ?? current.document.stateRevision;
    const unchanged = isDeepStrictEqual(current.document.snapshot, snapshot);
    if (receipt.capture) {
      if (receipt.capture.screenshot.stateRevision !== current.document.stateRevision || !unchanged)
        throw new VisualFailure(
          "STALE_STATE",
          "Historical capture no longer matches the displayed choices",
        );
    } else if (base !== current.document.stateRevision) {
      throw new VisualFailure(
        "STALE_STATE",
        "Historical interaction was published from an obsolete base",
      );
    }
    const stateRevision = unchanged
      ? current.document.stateRevision
      : current.document.stateRevision + 1;
    if (!Number.isSafeInteger(stateRevision))
      throw new VisualFailure("INVALID_DATA", "Historical interaction revision limit reached");
    peer.current = {
      binding: current.binding,
      document: { ...current.document, stateRevision, snapshot },
    };
    peer.actions = actions;
    peer.status = "rendered";
    peer.error = null;
    return stateRevision;
  }

  private async publishReceipt(
    { peer, receipt }: ReceiptValidationInput,
    { current, snapshot, actions, pending }: ValidatedVisualReceipt,
  ): Promise<number> {
    const owner = this.activeOwners.get(peer.agentId);
    if (!owner) throw new VisualFailure("STALE_SESSION", "No Pi session owns this visual");
    if (peer.historical)
      return this.publishHistoricalReceipt(
        { peer, receipt },
        { current, snapshot, actions, pending },
      );
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
      return stored.stateRevision;
    }
    // COMPAT(visualStateBase): added in v0.10.3; remove after 2027-04-04 once all
    // visual clients publish an explicit base. V1 receipts use their bound view's base.
    const stateRevision = receipt.stateRevision ?? current.document.stateRevision;
    const read = pending?.kind === "inspect";
    const authoritative = await this.storage.get({ owner, id: current.document.id });
    let updated: VisualDocument;
    if (
      authoritative.revision === current.document.revision &&
      isDeepStrictEqual(authoritative.snapshot, snapshot)
    ) {
      // Nothing changed: no new state revision. Bumping it here would make every other display's
      // next genuine change look stale and be rejected (a lost user update).
      updated = authoritative;
    } else if (read && stateRevision !== authoritative.stateRevision) {
      // An agent read answered from an older base while another display published. The read
      // reports the authoritative stored state; synchronization restores this display.
      updated = authoritative;
    } else {
      updated = await this.saveReceiptState({
        owner,
        id: current.document.id,
        revision: current.document.revision,
        stateRevision,
        snapshot,
        read,
      });
    }
    // Activity order is fixed at observation, render or trusted interaction. A late mount
    // receipt must not displace a display the user interacted with in the meantime.
    peer.current = { binding: current.binding, document: updated };
    peer.actions = actions;
    peer.status = "rendered";
    peer.error = null;
    const unchangedForAll =
      updated === authoritative && stateRevision === authoritative.stateRevision;
    if (!unchangedForAll) this.synchronize(owner, updated);
    return updated.stateRevision;
  }

  /** Saves a publication; a concurrent change only fails publications, never agent reads. */
  private async saveReceiptState(input: SaveReceiptStateInput): Promise<VisualDocument> {
    const { read, ...save } = input;
    try {
      return await this.storage.saveState(save);
    } catch (error) {
      if (!read || !(error instanceof VisualFailure) || error.code !== "STALE_STATE") throw error;
      return this.storage.get({ owner: save.owner, id: save.id });
    }
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
      if (peer.historical) {
        peer.sequence += 1;
        peer.emit({ kind: "snapshot", view: this.view(peer) });
        return;
      }
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
      VISUAL_CAPTURE_PLATFORMS.has(input.peer.platform) &&
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
    const latest = await this.storage.get({ owner, id });
    const active = this.latestPeer(owner.agentId, id);
    const collapsed = this.agentPeers(owner.agentId).find(
      (candidate) => candidate.library && candidate.current?.document.id === id,
    );
    const peer = client === undefined ? active : this.displayedPeer(owner, id, client);
    const current = peer?.current;
    const document =
      client !== undefined && peer?.historical && current ? current.document : latest;
    const live =
      peer &&
      current &&
      current.document.id === id &&
      current.document.revision === document.revision;
    let status: VisualRecord["status"] = "disconnected";
    if (live) status = peer.status;
    else if (collapsed) status = "stored";
    return {
      kind: "visual",
      id,
      title: document.title,
      revision: document.revision,
      stateRevision: document.stateRevision,
      state: document.snapshot.state,
      selection: document.snapshot.selection,
      status,
      actions: live ? peer.actions : {},
      error: live ? peer.error : null,
      client: live ? peer.generation : null,
      displays: this.agentPeers(owner.agentId)
        .filter(
          (display) =>
            display.visible && display.drawingVisible && display.current?.document.id === id,
        )
        .map((display) => ({
          client: display.generation,
          platform: display.platform,
          active: display === active,
        })),
    };
  }
}
