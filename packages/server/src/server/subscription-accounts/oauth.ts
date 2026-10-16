import { createHash, createPublicKey, randomBytes, verify } from "node:crypto";
import { createServer } from "node:http";
import { z } from "zod";
import type {
  AccountIdentity,
  AccountLoginChallenge,
  SubscriptionProvider,
} from "@getpaseo/protocol/subscription-accounts";
import type { OAuthCredential, SavedGrant } from "./store.js";

const OPENAI = "https://auth.openai.com";
const RESOURCE = "https://api.openai.com/v1";
const ANTHROPIC_CLIENT = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const ANTHROPIC_CALLBACK = "https://platform.claude.com/oauth/code/callback";
const DIRECT_SCOPE = "chatgpt.tokens.use.direct";
const TokenSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  expires_in: z.number().positive(),
  scope: z.string().optional(),
  id_token: z.string().optional(),
});
const ProfileSchema = z.object({
  account: z.object({
    uuid: z.string(),
    email: z.string(),
    has_claude_max: z.boolean().optional(),
    has_claude_pro: z.boolean().optional(),
  }),
  organization: z
    .object({
      uuid: z.string(),
      rate_limit_tier: z.string().optional(),
      subscription_status: z.string().optional(),
    })
    .optional(),
});
const ClaimsSchema = z.object({
  iss: z.literal(OPENAI),
  sub: z.string().min(1),
  aud: z.union([z.string(), z.array(z.string())]),
  azp: z.string().optional(),
  exp: z.number(),
  iat: z.number().optional(),
  nbf: z.number().optional(),
  nonce: z.string(),
  email: z.string().optional(),
});
const HeaderSchema = z.object({ alg: z.literal("RS256"), kid: z.string().min(1) });
const JwksSchema = z.object({
  keys: z.array(
    z.object({
      kty: z.literal("RSA"),
      kid: z.string(),
      n: z.string(),
      e: z.string(),
      alg: z.string().optional(),
      use: z.string().optional(),
    }),
  ),
});

export interface LoginProfile {
  identity: AccountIdentity;
  clientId?: string;
}

export interface LoginInteraction {
  signal: AbortSignal;
  challenge(value: AccountLoginChallenge): void;
  answer(signal: AbortSignal): Promise<string>;
}

/** Only provider URLs, bounded responses, and status-only failures: OAuth bodies can contain secrets. */
export async function providerJson(
  fetcher: typeof fetch,
  url: string,
  init: RequestInit,
): Promise<unknown> {
  const response = await fetcher(url, {
    ...init,
    redirect: "error",
    signal: AbortSignal.any([
      init.signal ?? new AbortController().signal,
      AbortSignal.timeout(30_000),
    ]),
  });
  if (!response.ok) throw new Error(`Provider request failed (${response.status})`);
  const text = await response.text();
  if (text.length > 1024 * 1024)
    throw new Error("Provider response exceeds the account-data limit");
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("Provider returned invalid account data");
  }
}

function parseJsonSegment(segment: string): unknown {
  try {
    return JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
  } catch {
    throw new Error("Invalid identity token");
  }
}

export class SubscriptionOAuth {
  constructor(
    private readonly fetcher: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  async login(
    provider: SubscriptionProvider,
    hostId: string,
    interaction: LoginInteraction,
    prior?: LoginProfile,
  ): Promise<SavedGrant> {
    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const grant =
      provider === "openai"
        ? await this.openaiLogin({ hostId, verifier, challenge, interaction, prior })
        : await this.claudeLogin(verifier, challenge, interaction);
    if (
      prior &&
      (grant.identity.subject !== prior.identity.subject ||
        grant.identity.workspace !== prior.identity.workspace)
    )
      throw new Error(
        "The signed-in identity does not match this saved account. Add it as a new account instead.",
      );
    return grant;
  }

  async refresh(
    provider: SubscriptionProvider,
    credential: OAuthCredential,
  ): Promise<OAuthCredential> {
    const signal = AbortSignal.timeout(30_000);
    if (provider === "openai") {
      if (!credential.clientId)
        throw new Error("Reconnect ChatGPT: the saved registration is missing");
      const token = await this.openaiToken(
        new URLSearchParams({
          grant_type: "refresh_token",
          client_id: credential.clientId,
          refresh_token: credential.refresh,
          resource: RESOURCE,
        }),
        signal,
      );
      return { ...credential, ...this.credential(token, credential.clientId) };
    }
    const token = TokenSchema.parse(
      await providerJson(this.fetcher, "https://platform.claude.com/v1/oauth/token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal,
        body: JSON.stringify({
          grant_type: "refresh_token",
          client_id: ANTHROPIC_CLIENT,
          refresh_token: credential.refresh,
        }),
      }),
    );
    return { ...credential, ...this.credential(token) };
  }

  async revoke(provider: SubscriptionProvider, credential: OAuthCredential): Promise<boolean> {
    // Claude's verified integration has no revocation endpoint. Report local-only sign-out.
    if (provider !== "openai" || !credential.clientId) return false;
    const discovery = z
      .object({ issuer: z.literal(OPENAI), revocation_endpoint: z.string().url() })
      .parse(await providerJson(this.fetcher, `${OPENAI}/.well-known/openid-configuration`, {}));
    if (new URL(discovery.revocation_endpoint).origin !== OPENAI)
      throw new Error("Unexpected revocation endpoint");
    const response = await this.fetcher(discovery.revocation_endpoint, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        token: credential.refresh,
        token_type_hint: "refresh_token",
        client_id: credential.clientId,
      }),
    });
    return response.status === 200;
  }

  private async openaiToken(body: URLSearchParams, signal: AbortSignal) {
    return TokenSchema.parse(
      await providerJson(this.fetcher, `${OPENAI}/api/accounts/oauth/token`, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body,
        signal,
      }),
    );
  }

  private credential(token: z.infer<typeof TokenSchema>, clientId?: string): OAuthCredential {
    const scopes = token.scope?.split(/\s+/).filter(Boolean);
    if (clientId && !scopes?.includes(DIRECT_SCOPE))
      throw new Error("ChatGPT plan usage was not authorized");
    return {
      type: "oauth",
      access: token.access_token,
      refresh: token.refresh_token,
      expires: this.now() + token.expires_in * 1000 - 180_000,
      ...(clientId ? { clientId } : {}),
      ...(scopes ? { scopes } : {}),
      ...(token.id_token ? { idToken: token.id_token } : {}),
    };
  }

  private async openaiLogin(input: {
    hostId: string;
    verifier: string;
    challenge: string;
    interaction: LoginInteraction;
    prior?: LoginProfile;
  }): Promise<SavedGrant> {
    const { interaction, prior } = input;
    const state = randomBytes(32).toString("base64url");
    const nonce = randomBytes(32).toString("base64url");
    const callback = await openCallback(state);
    const manual = new AbortController();
    try {
      const params = new URLSearchParams({
        client_id: prior?.clientId ?? "dynamic_agent_client",
        ext_agent_host_id: `urn:uuid:${input.hostId}`,
        response_type: "code",
        redirect_uri: callback.uri,
        resource: RESOURCE,
        scope: `openid profile email offline_access resource.invoke ${DIRECT_SCOPE}`,
        state,
        nonce,
        code_challenge: input.challenge,
        code_challenge_method: "S256",
      });
      if (!prior?.clientId) params.set("agent_name_hint", "Paseo Workspace");
      interaction.challenge({
        url: `${OPENAI}/api/accounts/authorize?${params}`,
        userCode: null,
        prompt: "Sign in in your browser. On a phone, paste the final redirect URL here.",
      });
      const response = await Promise.race([
        callback.result,
        interaction
          .answer(AbortSignal.any([interaction.signal, manual.signal]))
          .then((value) => validateCallback(value, callback.uri, state)),
      ]);
      interaction.signal.throwIfAborted();
      const issuedClient = response.searchParams.get("client_id") ?? prior?.clientId;
      if (
        !issuedClient ||
        issuedClient === "dynamic_agent_client" ||
        (prior?.clientId && prior.clientId !== issuedClient)
      )
        throw new Error("ChatGPT returned a different or incomplete registration");
      const code = response.searchParams.get("code");
      if (!code) throw new Error("ChatGPT did not return an authorization code");
      const token = await this.openaiToken(
        new URLSearchParams({
          grant_type: "authorization_code",
          client_id: issuedClient,
          code,
          code_verifier: input.verifier,
          redirect_uri: callback.uri,
          resource: RESOURCE,
        }),
        interaction.signal,
      );
      if (!token.id_token) throw new Error("ChatGPT did not return an identity token");
      const identity = await this.verifyIdentity(
        token.id_token,
        issuedClient,
        nonce,
        interaction.signal,
      );
      return { credential: this.credential(token, issuedClient), identity, reconnect: false };
    } finally {
      manual.abort();
      callback.close();
    }
  }

  private async verifyIdentity(
    token: string,
    client: string,
    nonce: string,
    signal: AbortSignal,
  ): Promise<AccountIdentity> {
    const parts = token.split(".");
    const [headerPart, payloadPart, signaturePart] = parts;
    if (parts.length !== 3 || !headerPart || !payloadPart || !signaturePart)
      throw new Error("Invalid identity token");
    const header = HeaderSchema.parse(parseJsonSegment(headerPart));
    const discovery = z
      .object({ issuer: z.literal(OPENAI), jwks_uri: z.string().url() })
      .parse(
        await providerJson(this.fetcher, `${OPENAI}/.well-known/openid-configuration`, { signal }),
      );
    if (new URL(discovery.jwks_uri).origin !== OPENAI)
      throw new Error("Unexpected identity verification endpoint");
    const keys = JwksSchema.parse(await providerJson(this.fetcher, discovery.jwks_uri, { signal }));
    const key = keys.keys.find(
      (value) =>
        value.kid === header.kid &&
        (!value.alg || value.alg === "RS256") &&
        (!value.use || value.use === "sig"),
    );
    if (
      !key ||
      !verify(
        "RSA-SHA256",
        Buffer.from(`${headerPart}.${payloadPart}`),
        createPublicKey({ key: { kty: key.kty, n: key.n, e: key.e }, format: "jwk" }),
        Buffer.from(signaturePart, "base64url"),
      )
    )
      throw new Error("ChatGPT identity signature verification failed");
    const claims = ClaimsSchema.parse(parseJsonSegment(payloadPart));
    const audiences = typeof claims.aud === "string" ? [claims.aud] : claims.aud;
    const now = this.now() / 1000;
    const requiresAuthorizedParty = claims.azp !== undefined || audiences.length > 1;
    if (
      !audiences.includes(client) ||
      (requiresAuthorizedParty && claims.azp !== client) ||
      claims.nonce !== nonce ||
      claims.exp <= now ||
      (claims.nbf !== undefined && claims.nbf > now + 30) ||
      (claims.iat !== undefined && claims.iat > now + 30)
    )
      throw new Error("ChatGPT identity validation failed");
    return { subject: claims.sub, email: claims.email ?? null, workspace: null, plan: null };
  }

  private async claudeLogin(
    verifier: string,
    challenge: string,
    interaction: LoginInteraction,
  ): Promise<SavedGrant> {
    const state = randomBytes(32).toString("base64url");
    const params = new URLSearchParams({
      code: "true",
      client_id: ANTHROPIC_CLIENT,
      response_type: "code",
      redirect_uri: ANTHROPIC_CALLBACK,
      scope:
        "org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload",
      code_challenge: challenge,
      code_challenge_method: "S256",
      state,
    });
    interaction.challenge({
      url: `https://claude.ai/oauth/authorize?${params}`,
      userCode: null,
      prompt: "Paste the code Claude shows after sign-in (code#state).",
    });
    const [code, returnedState, extra] = (await interaction.answer(interaction.signal))
      .trim()
      .split("#");
    if (!code || returnedState !== state || extra !== undefined)
      throw new Error("Claude authorization state does not match this login");
    const token = TokenSchema.parse(
      await providerJson(this.fetcher, "https://platform.claude.com/v1/oauth/token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: interaction.signal,
        body: JSON.stringify({
          grant_type: "authorization_code",
          client_id: ANTHROPIC_CLIENT,
          code,
          state,
          code_verifier: verifier,
          redirect_uri: ANTHROPIC_CALLBACK,
        }),
      }),
    );
    const credential = this.credential(token);
    const identity = await this.claudeIdentity(credential);
    return { credential, identity, reconnect: false };
  }

  async claudeIdentity(credential: OAuthCredential): Promise<AccountIdentity> {
    const profile = ProfileSchema.parse(
      await providerJson(this.fetcher, "https://api.anthropic.com/api/oauth/profile", {
        headers: {
          Authorization: `Bearer ${credential.access}`,
          "anthropic-beta": "oauth-2025-04-20",
        },
        signal: AbortSignal.timeout(5_000),
      }),
    );
    let plan: string | null = null;
    if (profile.account.has_claude_max) plan = "Max";
    else if (profile.account.has_claude_pro) plan = "Pro";
    return {
      subject: profile.account.uuid,
      email: profile.account.email,
      workspace: profile.organization?.uuid ?? null,
      plan,
    };
  }
}

class SignInDeclined extends Error {
  constructor() {
    super("Sign-in was declined by the provider");
    this.name = "SignInDeclined";
  }
}

export function validateCallback(value: string, expectedUri: string, state: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Paste the full redirect URL");
  }
  const expected = new URL(expectedUri);
  if (
    url.origin !== expected.origin ||
    url.pathname !== expected.pathname ||
    url.searchParams.get("state") !== state
  )
    throw new Error("OAuth callback does not match this login");
  if (url.searchParams.has("error")) throw new SignInDeclined();
  return url;
}

async function openCallback(
  state: string,
): Promise<{ uri: string; result: Promise<URL>; close(): void }> {
  let accept: (url: URL) => void = () => {
    throw new Error("Callback not initialized");
  };
  let decline: (error: SignInDeclined) => void = () => {
    throw new Error("Callback not initialized");
  };
  const result = new Promise<URL>((resolve, reject) => {
    accept = resolve;
    decline = reject;
  });
  void result.catch(() => undefined);
  let uri = "";
  const server = createServer((request, response) => {
    try {
      if (request.method !== "GET") throw new Error("Invalid callback method");
      const url = validateCallback(new URL(request.url ?? "", uri).href, uri, state);
      response.writeHead(200, {
        "Content-Type": "text/plain",
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
      });
      response.end("Sign-in received. Return to Paseo to finish.");
      accept(url);
    } catch (error) {
      const declined = error instanceof SignInDeclined;
      response.writeHead(declined ? 200 : 400, {
        "Content-Type": "text/plain",
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
      });
      response.end(
        declined
          ? "Sign-in declined. Return to Paseo."
          : "This callback does not match the pending Paseo login.",
      );
      if (declined) decline(error);
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Login callback unavailable");
  }
  uri = `http://127.0.0.1:${address.port}/auth/callback`;
  return {
    uri,
    result,
    close: () => {
      server.close();
      server.closeAllConnections();
    },
  };
}
