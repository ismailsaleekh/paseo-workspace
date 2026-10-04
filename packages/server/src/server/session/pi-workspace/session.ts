import { VisualFailure } from "@getpaseo/protocol/pi-workspace/contracts";
import type { SessionInboundMessage, SessionOutboundMessage } from "../../messages.js";
import {
  encodeVisualEvent,
  encodeVisualView,
  type VisualReceiptRequest,
  type VisualSubscribeRequest,
} from "@getpaseo/protocol/pi-workspace/rpc-schemas";
import type { VisualObservation, VisualService } from "../../pi-workspace/service.js";
import type { SessionDelivery } from "../owned-subscriptions/index.js";

export interface VisualSessionHost {
  service: VisualService | undefined;
  delivery: SessionDelivery;
  assertAgent(agentId: string): void;
  reply(message: SessionOutboundMessage): void;
}

export class VisualSession {
  constructor(private readonly host: VisualSessionHost) {}

  handle(message: SessionInboundMessage): Promise<void> | undefined {
    if (
      message.type !== "pi_workspace.observe.request" &&
      message.type !== "pi_workspace.receipt.request"
    )
      return undefined;
    return this.dispatch(message);
  }

  private async dispatch(message: VisualSubscribeRequest | VisualReceiptRequest): Promise<void> {
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
      this.host.assertAgent(message.agentId);
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
