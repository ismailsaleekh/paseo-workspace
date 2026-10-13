import { VisualFailure, type VisualOwner } from "@getpaseo/protocol/pi-workspace/contracts";
import type { SessionInboundMessage, SessionOutboundMessage } from "../../messages.js";
import {
  encodeVisualEvent,
  encodeVisualView,
  type VisualReceiptRequest,
  type VisualSubscribeRequest,
  type VisualLibraryRequest,
  type SpeechObserveRequest,
} from "@getpaseo/protocol/pi-workspace/rpc-schemas";
import type {
  SpeechObservation,
  VisualObservation,
  VisualService,
} from "../../pi-workspace/service.js";
import type { SessionDelivery } from "../owned-subscriptions/index.js";
import type { ClientPresenceState } from "../../agent-attention-policy.js";

export interface VisualSessionHost {
  service: VisualService | undefined;
  /** The connected app installation's stable client ID. */
  clientId: string;
  delivery: SessionDelivery;
  assertAgent(agentId: string): void | Promise<void>;
  owner(agentId: string): Promise<VisualOwner | null>;
  reply(message: SessionOutboundMessage): void;
  /** The connection's latest `client_heartbeat` presence (focus, visibility, activity). */
  presence(source: object): ClientPresenceState | null;
}

export class VisualSession {
  constructor(private readonly host: VisualSessionHost) {}

  /** The user messaged this agent from this connection's app: speech follows them there. */
  noteUserMessage(agentId: string): void {
    this.host.service?.noteUserMessage(agentId, this.host.clientId);
  }

  /** The app plays agent speech of every conversation, whatever it displays. */
  private async observeSpeech(
    service: VisualService,
    source: object,
    message: SpeechObserveRequest,
  ): Promise<void> {
    let observation: SpeechObservation | null = null;
    const owner = this.host.delivery.begin("pi-workspace-speech", undefined, () => {
      observation?.release();
    });
    try {
      observation = service.observeSpeech({
        source: owner.source,
        clientId: this.host.clientId,
        device: message.device,
        background: message.background === true,
        presence: () => this.host.presence(source),
        emit: (agentId, voice, speech) =>
          owner.emit({
            type: "pi_workspace.speech.update",
            payload: { subscriptionId: owner.id, agentId, voice, speech },
          }),
      });
      this.host.reply({
        type: "pi_workspace.speech.observe.response",
        payload: {
          requestId: message.requestId,
          subscriptionId: owner.id,
          generation: observation.generation,
        },
      });
    } catch (error) {
      await owner.release();
      throw error;
    }
  }

  handle(message: SessionInboundMessage): Promise<void> | undefined {
    if (
      message.type !== "pi_workspace.observe.request" &&
      message.type !== "pi_workspace.receipt.request" &&
      message.type !== "pi_workspace.library.request" &&
      message.type !== "pi_workspace.speech.observe.request"
    )
      return undefined;
    return this.dispatch(message);
  }

  private async dispatch(
    message:
      | VisualSubscribeRequest
      | VisualReceiptRequest
      | VisualLibraryRequest
      | SpeechObserveRequest,
  ): Promise<void> {
    try {
      const service = this.host.service;
      if (!service)
        throw new VisualFailure(
          "HOST_UNAVAILABLE",
          "This daemon does not support Pi visual workspaces",
        );
      const source = this.host.delivery.currentSource;
      if (!source || !this.host.delivery.isModern(source))
        throw new VisualFailure(
          "UNSUPPORTED_CLIENT",
          "Pi visual workspaces require source-owned subscriptions",
        );
      if (message.type === "pi_workspace.speech.observe.request") {
        await this.observeSpeech(service, source, message);
        return;
      }
      const enhanced =
        message.type === "pi_workspace.library.request" ||
        (message.type === "pi_workspace.observe.request" && message.library === true);
      const conversationOwner = enhanced ? await this.host.owner(message.agentId) : null;
      if (!enhanced) await this.host.assertAgent(message.agentId);
      if (!this.host.delivery.isModern(source))
        throw new VisualFailure("DISCONNECTED", "Visual library source disconnected");
      if (message.type === "pi_workspace.library.request") {
        if (!conversationOwner)
          throw new VisualFailure(
            "NO_SESSION",
            "This Pi conversation has no persisted session yet",
          );
        const result = await service.library({
          owner: conversationOwner,
          source,
          generation: message.clientGeneration,
          operation: message.operation,
        });
        this.host.reply({
          type: "pi_workspace.library.response",
          payload: { requestId: message.requestId, agentId: message.agentId, result },
        });
        return;
      }
      if (message.type === "pi_workspace.receipt.request") {
        const stateRevision = await service.receive({
          agentId: message.agentId,
          source,
          receipt: message.receipt,
        });
        this.host.reply({
          type: "pi_workspace.receipt.response",
          payload: { requestId: message.requestId, agentId: message.agentId, stateRevision },
        });
        return;
      }
      let observation: VisualObservation | null = null;
      const owner = this.host.delivery.begin("pi-workspace", undefined, () => {
        observation?.release();
      });
      try {
        observation = await service.observe({
          agentId: message.agentId,
          source: owner.source,
          library: message.library === true,
          owner: conversationOwner,
          ...(message.platform === undefined ? {} : { platform: message.platform }),
          presence: () => this.host.presence(source),
          emit: (event) =>
            owner.emit({
              type: "pi_workspace.update",
              payload: {
                subscriptionId: owner.id,
                agentId: message.agentId,
                event: encodeVisualEvent(event),
              },
            }),
        });
        if (owner.signal.aborted) {
          observation.release();
          throw new VisualFailure("DISCONNECTED", "Visual observation source disconnected");
        }
        this.host.reply({
          type: "pi_workspace.observe.response",
          payload: {
            requestId: message.requestId,
            subscriptionId: owner.id,
            agentId: message.agentId,
            view: encodeVisualView(observation.view),
          },
        });
      } catch (error) {
        await owner.release();
        throw error;
      }
    } catch (error) {
      if (!(error instanceof VisualFailure)) throw error;
      this.host.reply({
        type: "rpc_error",
        payload: {
          requestId: message.requestId,
          requestType: message.type,
          code: error.code,
          error: error.message,
        },
      });
    }
  }
}
