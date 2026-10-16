import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";

/** Offline fixture: stock Pi supplies credentials; this adapter never calls a provider. */
export default function fixture(pi: ExtensionAPI): void {
  for (const provider of ["anthropic", "openai"] as const) {
    pi.registerProvider(provider, {
      api: "anthropic-messages",
      baseUrl: "https://example.invalid",
      models: [
        {
          id: "account-fixture",
          name: "Account fixture",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 8192,
          maxTokens: 128,
        },
      ],
      oauth: {
        name: "Fixture subscription",
        isSubscription: true,
        login: async () => {
          throw new Error("This fixture never logs in");
        },
        getApiKey: (credential) => credential.access,
        refreshToken: async (credential) => {
          if (credential.refresh === "fixture-revoked") throw new Error("Fixture grant revoked");
          if (!credential.refresh.startsWith("fixture-"))
            throw new Error("Real credentials are forbidden in this fixture");
          return {
            ...credential,
            access: `${credential.access}-renewed`,
            refresh: `${credential.refresh}-renewed`,
            expires: Date.now() + 3600_000,
          };
        },
      },
      streamSimple: (model, _context, options) => {
        const stream = createAssistantMessageEventStream();
        const access = options?.apiKey;
        if (!access?.startsWith("fixture-"))
          throw new Error("Real credentials are forbidden in this fixture");
        const message: AssistantMessage = {
          role: "assistant",
          api: model.api,
          provider: model.provider,
          model: model.id,
          content: [{ type: "text", text: access }],
          stopReason: "stop",
          timestamp: Date.now(),
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
        };
        stream.push({ type: "start", partial: message });
        stream.push({ type: "done", reason: "stop", message });
        stream.end(message);
        return stream;
      },
    });
  }
}
