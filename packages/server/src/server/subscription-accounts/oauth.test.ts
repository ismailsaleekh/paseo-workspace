import { generateKeyPairSync, sign } from "node:crypto";
import { expect, test } from "vitest";
import {
  SubscriptionOAuth,
  validateCallback,
  type LoginInteraction,
  type LoginProfile,
} from "./oauth.js";

const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
const publicKey = pair.publicKey.export({ format: "jwk" });
const NOW = 1_800_000_000_000;
const HOST = "00000000-0000-4000-8000-000000000001";

class OpenAIFlow {
  url: URL | null = null;
  readonly calls: string[] = [];
  clientId = "issued-client";
  subject = "signed-in-subject";
  nonceOverride: string | null = null;
  tamper = false;
  audiences: string[] | null = null;
  authorizedParty: string | undefined;
  readonly interaction: LoginInteraction = {
    signal: new AbortController().signal,
    challenge: (challenge) => {
      if (challenge.url) this.url = new URL(challenge.url);
    },
    answer: async () => {
      if (!this.url) throw new Error("Login URL was not presented");
      const uri = this.url.searchParams.get("redirect_uri");
      if (!uri) throw new Error("Missing callback URI");
      const callback = new URL(uri);
      callback.searchParams.set("state", this.url.searchParams.get("state") ?? "");
      callback.searchParams.set("code", "fixture-authorization-code");
      callback.searchParams.set("client_id", this.clientId);
      return callback.href;
    },
  };
  readonly fetch: typeof fetch = async (input, init) => {
    const url = String(input);
    this.calls.push(url);
    if (url.endsWith("/.well-known/openid-configuration"))
      return Response.json({
        issuer: "https://auth.openai.com",
        jwks_uri: "https://auth.openai.com/keys",
        revocation_endpoint: "https://auth.openai.com/revoke",
      });
    if (url.endsWith("/keys"))
      return Response.json({
        keys: [{ ...publicKey, kid: "fixture-key", alg: "RS256", use: "sig" }],
      });
    if (url.endsWith("/revoke")) return new Response(null, { status: 200 });
    if (!url.endsWith("/api/accounts/oauth/token"))
      throw new Error(`Unexpected network request: ${url}`);
    if (!(init?.body instanceof URLSearchParams)) throw new Error("Expected OAuth form data");
    expect(init.body.get("client_id")).toBe(this.clientId);
    expect(init.body.get("resource")).toBe("https://api.openai.com/v1");
    const claims = {
      iss: "https://auth.openai.com",
      sub: this.subject,
      aud: this.audiences ?? this.clientId,
      azp: this.authorizedParty,
      exp: NOW / 1000 + 3600,
      nonce: this.nonceOverride ?? this.url?.searchParams.get("nonce"),
      email: "user@example.com",
    };
    const header = Buffer.from(JSON.stringify({ alg: "RS256", kid: "fixture-key" })).toString(
      "base64url",
    );
    const body = Buffer.from(JSON.stringify(claims)).toString("base64url");
    const signature = sign(
      "RSA-SHA256",
      Buffer.from(`${header}.${body}`),
      pair.privateKey,
    ).toString("base64url");
    return Response.json({
      access_token: "fixture-access",
      refresh_token: "fixture-refresh",
      expires_in: 3600,
      scope: "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct",
      id_token: `${header}.${body}.${this.tamper ? Buffer.alloc(256).toString("base64url") : signature}`,
    });
  };
}

test("ChatGPT login uses the returned registration and verifies identity without a model request", async () => {
  const flow = new OpenAIFlow();
  const grant = await new SubscriptionOAuth(flow.fetch, () => NOW).login(
    "openai",
    HOST,
    flow.interaction,
  );
  expect(flow.url?.searchParams.get("client_id")).toBe("dynamic_agent_client");
  expect(flow.url?.searchParams.get("ext_agent_host_id")).toBe(`urn:uuid:${HOST}`);
  expect(grant.identity).toEqual({
    subject: "signed-in-subject",
    email: "user@example.com",
    workspace: null,
    plan: null,
  });
  expect(grant.credential.clientId).toBe("issued-client");
  expect(grant.credential.type).toBe("oauth");
  expect(flow.calls.every((url) => url.startsWith("https://auth.openai.com/"))).toBe(true);
  expect(flow.calls).toHaveLength(3);
});

test("a retained registration survives logout and cannot reconnect as another identity", async () => {
  const flow = new OpenAIFlow();
  const prior: LoginProfile = {
    clientId: flow.clientId,
    identity: {
      subject: "signed-in-subject",
      email: "user@example.com",
      workspace: null,
      plan: null,
    },
  };
  const oauth = new SubscriptionOAuth(flow.fetch, () => NOW);
  await oauth.login("openai", HOST, flow.interaction, prior);
  expect(flow.url?.searchParams.get("client_id")).toBe(flow.clientId);
  expect(flow.url?.searchParams.has("agent_name_hint")).toBe(false);
  expect(flow.url?.searchParams.has("id_token_hint")).toBe(false);
  flow.subject = "another-user";
  await expect(oauth.login("openai", HOST, flow.interaction, prior)).rejects.toThrow(
    "does not match",
  );
});

test("signature and nonce validation reject untrusted identity claims", async () => {
  const badSignature = new OpenAIFlow();
  badSignature.tamper = true;
  await expect(
    new SubscriptionOAuth(badSignature.fetch, () => NOW).login(
      "openai",
      HOST,
      badSignature.interaction,
    ),
  ).rejects.toThrow("signature");
  const badNonce = new OpenAIFlow();
  badNonce.nonceOverride = "replayed-nonce";
  await expect(
    new SubscriptionOAuth(badNonce.fetch, () => NOW).login("openai", HOST, badNonce.interaction),
  ).rejects.toThrow("validation");
});

test("a multi-audience identity token must authorize this client", async () => {
  const flow = new OpenAIFlow();
  flow.audiences = [flow.clientId, "another-client"];
  flow.authorizedParty = "another-client";
  await expect(
    new SubscriptionOAuth(flow.fetch, () => NOW).login("openai", HOST, flow.interaction),
  ).rejects.toThrow("validation");
  flow.authorizedParty = flow.clientId;
  await expect(
    new SubscriptionOAuth(flow.fetch, () => NOW).login("openai", HOST, flow.interaction),
  ).resolves.toMatchObject({ identity: { subject: flow.subject } });
});

test("a valid browser denial terminates login; a wrong-state callback cannot cancel it", async () => {
  const flow = new OpenAIFlow();
  let browser = Promise.resolve();
  const interaction: LoginInteraction = {
    signal: new AbortController().signal,
    challenge: (challenge) => {
      if (!challenge.url) throw new Error("Missing authorization URL");
      const authorization = new URL(challenge.url);
      const uri = authorization.searchParams.get("redirect_uri");
      if (!uri) throw new Error("Missing redirect URI");
      browser = (async () => {
        const declined = new URL(uri);
        declined.searchParams.set("error", "access_denied");
        declined.searchParams.set("state", "wrong-state");
        expect((await fetch(declined)).status).toBe(400);
        declined.searchParams.set("state", authorization.searchParams.get("state") ?? "");
        expect((await fetch(declined)).status).toBe(200);
      })();
    },
    answer: (signal) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("Answer cancelled")), {
          once: true,
        });
      }),
  };
  await expect(
    new SubscriptionOAuth(flow.fetch, () => NOW).login("openai", HOST, interaction),
  ).rejects.toThrow("declined");
  await browser;
  expect(flow.calls).toEqual([]);
});

test("manual callback must match this exact attempt, including host, path, port and state", () => {
  const uri = "http://127.0.0.1:40000/auth/callback";
  expect(
    validateCallback(`${uri}?code=x&state=expected`, uri, "expected").searchParams.get("code"),
  ).toBe("x");
  expect(() => validateCallback(`${uri}?code=x&state=other`, uri, "expected")).toThrow("match");
  expect(() =>
    validateCallback("http://localhost:40000/auth/callback?code=x&state=expected", uri, "expected"),
  ).toThrow("match");
  expect(() =>
    validateCallback(`${uri}?error=access_denied&state=expected`, uri, "expected"),
  ).toThrow("declined");
});

test("provider failures never include response bodies or tokens in the returned error", async () => {
  const flow = new OpenAIFlow();
  const fetcher: typeof fetch = async () =>
    new Response("refresh_token=SECRET access_token=OTHER_SECRET", { status: 400 });
  const failed = new SubscriptionOAuth(fetcher, () => NOW).login("openai", HOST, flow.interaction);
  await expect(failed).rejects.toThrow("Provider request failed (400)");
  await expect(failed).rejects.not.toThrow("SECRET");
});
