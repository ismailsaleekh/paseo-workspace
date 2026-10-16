import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import pino from "pino";
import { afterEach, expect, test } from "vitest";
import type { AccountIdentity, AccountUsage } from "@getpaseo/protocol/subscription-accounts";
import {
  AccountStore,
  type AccountState,
  type SavedAccount,
  type OAuthCredential,
} from "./store.js";
import { PiAuthFile } from "./pi-auth-file.js";
import { PiLogins } from "./pi-logins.js";
import { SubscriptionAccounts, type CodexAccountPort, type AccountOAuthPort } from "./service.js";

const homes: string[] = [];
const services: SubscriptionAccounts[] = [];
afterEach(async () => {
  for (const service of services.splice(0)) service.close();
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});
function saved(label: string): SavedAccount {
  return {
    id: randomUUID(),
    label,
    provider: "openai",
    pi: { clientId: `client-${label}`, identity: identity(label), reconnect: false },
    codex: { identity: { ...identity(label), workspace: `workspace-${label}` }, reconnect: false },
  };
}
function identity(label: string): AccountIdentity {
  return { subject: `user-${label}`, email: `${label}@example.com`, workspace: null, plan: "pro" };
}
function credential(label: string): OAuthCredential {
  return {
    type: "oauth",
    access: `access-${label}`,
    refresh: `refresh-${label}`,
    expires: Date.now() + 3600_000,
    clientId: `client-${label}`,
  };
}
class FaultStore extends AccountStore {
  failWrites = false;
  override mutate<T>(change: (state: AccountState) => T | Promise<T>): Promise<T> {
    if (this.failWrites) return Promise.reject(new Error("Fixture metadata write failed"));
    return super.mutate(change);
  }
}

class ControlFixture implements CodexAccountPort {
  readonly reads: string[] = [];
  readonly resets: string[] = [];
  readonly renewals: string[] = [];
  readonly spent = new Set<string>();
  available = 3;
  loseReply = false;
  loginIdentity: AccountIdentity | null = null;
  afterLogin = (): void => {};
  afterSpend = (): void => {};
  readonly signedOut: string[] = [];
  blockUsage: Promise<void> = Promise.resolve();
  async login(): Promise<AccountIdentity> {
    if (!this.loginIdentity) throw new Error("Login not used in this fixture");
    this.afterLogin();
    return this.loginIdentity;
  }
  async logout(id: string): Promise<void> {
    this.signedOut.push(id);
  }
  async usage(accountId: string): Promise<AccountUsage> {
    this.reads.push(accountId);
    await this.blockUsage;
    return {
      source: "codex",
      fetchedAt: new Date().toISOString(),
      error: null,
      manageUrl: null,
      windows: [{ id: "weekly", label: "Weekly", usedPercent: 35, resetsAt: null }],
      resets: { available: this.available, credits: null },
    };
  }
  async redeem(accountId: string, _identity: AccountIdentity, operationId: string) {
    const key = `${accountId}:${operationId}`;
    this.resets.push(key);
    if (this.spent.has(key)) return "alreadyRedeemed" as const;
    this.spent.add(key);
    this.available -= 1;
    this.afterSpend();
    if (this.loseReply) {
      this.loseReply = false;
      throw new Error("Response lost AFTER consuming credit");
    }
    return "reset" as const;
  }
  readonly oauth: AccountOAuthPort = {
    login: async () => {
      throw new Error("Not used in this test");
    },
    refresh: async (_provider, token) => {
      this.renewals.push(token.refresh);
      return {
        ...token,
        access: `${token.access}-renewed`,
        refresh: `${token.refresh}-renewed`,
        expires: Date.now() + 3600_000,
      };
    },
    claudeIdentity: async () => identity("claude"),
    revoke: async () => true,
  };
}
async function setup() {
  const home = await mkdtemp(join(tmpdir(), "paseo-account-service-"));
  homes.push(home);
  const store = new FaultStore(home);
  const a = saved("A"),
    b = saved("B");
  await store.mutate((state) => {
    state.accounts.push(a, b);
  });
  const auth = new PiAuthFile(join(home, "pi", "auth.json"), process.env.PASEO_TEST_PI_BIN ?? "pi");
  await auth.change((records) => {
    records.openai = credential("A");
    records[`paseo.subscription.${b.id}`] = credential("B");
  });
  const fixture = new ControlFixture();
  const logins = new PiLogins({ store, auth, oauth: fixture.oauth, env: {} });
  const options = {
    store,
    logins,
    oauth: fixture.oauth,
    codex: fixture,
    logger: pino({ level: "silent" }),
  };
  const service = new SubscriptionAccounts(options);
  services.push(service);
  return { home, store, auth, a, b, fixture, service, logins, options };
}
async function operationState(service: SubscriptionAccounts, id: string | null) {
  return (await service.read()).operations.find((operation) => operation.id === id);
}

test("switching parks the latest native Pi token, preserves inactive accounts and never exports credentials", async () => {
  const { home, store, auth, a, b, service, fixture } = await setup();
  await auth.change((records) => {
    records.openai = { ...credential("A"), access: "fresh-access-A", refresh: "fresh-refresh-A" };
  });
  const expectedB = await auth.read((records) => records[`paseo.subscription.${b.id}`]);
  const id = await service.action({ kind: "activate", accountId: b.id });
  await expect.poll(async () => (await operationState(service, id))?.state).toBe("complete");
  const values = await auth.read((records) => records);
  expect(values.openai).toEqual(expectedB);
  expect(values[`paseo.subscription.${a.id}`]).toMatchObject({
    access: "fresh-access-A",
    refresh: "fresh-refresh-A",
  });
  expect(values).not.toHaveProperty(`paseo.subscription.${b.id}`);
  const view = await service.read(true);
  expect(view.accounts.find((account) => account.id === a.id)?.grants).toHaveLength(2);
  expect(view.accounts.find((account) => account.id === b.id)?.active).toBe(true);
  expect(JSON.stringify(view)).not.toContain("access-");
  expect(JSON.stringify(view)).not.toContain("refresh-");
  expect(JSON.stringify(await store.load())).not.toContain("fresh-refresh");
  await expect.poll(() => fixture.reads.includes(b.id)).toBe(true);
  expect((await stat(join(home, "subscription-accounts/state.json"))).mode & 0o077).toBe(0);
});

test("renewals of an inactive login share the native file lock and rotate only once", async () => {
  const { auth, b, logins, fixture } = await setup();
  await auth.change((records) => {
    records[`paseo.subscription.${b.id}`] = { ...credential("B"), expires: 1 };
  });
  const results = await Promise.all([
    logins.credential(b.id),
    logins.credential(b.id),
    logins.credential(b.id),
  ]);
  expect(fixture.renewals).toEqual(["refresh-B"]);
  expect(results.map((token) => token.refresh)).toEqual(Array(3).fill("refresh-B-renewed"));
  expect(await auth.read((records) => records.openai)).toMatchObject({ access: "access-A" });
});

test("a terminal login change is visible, cannot be parked under the wrong identity, and requires explicit saving", async () => {
  const { auth, b, logins, service } = await setup();
  await auth.change((records) => {
    records.openai = credential("external");
  });
  expect((await service.read()).native).toContainEqual({
    provider: "openai",
    external: true,
    error: null,
  });
  await expect(logins.activate(b.id)).rejects.toThrow("Save the existing Pi login");
  expect(await auth.read((records) => records.openai)).toMatchObject({ access: "access-external" });
  await service.action({ kind: "save_current", provider: "openai", confirm: true });
  const imported = (await service.read()).accounts.find((account) => account.active);
  expect(imported?.label).toBe("Existing OpenAI login");
  expect(imported?.grants[0]?.identity).toBeNull();
  await logins.activate(b.id);
  expect(await auth.read((records) => records[`paseo.subscription.${imported?.id}`])).toMatchObject(
    { access: "access-external" },
  );
});

test("OpenAI registrations with the same identity/email stay separate by issued client ID", async () => {
  const { a, store, auth, logins } = await setup();
  const another = { ...saved("Another workspace"), pi: null, codex: null };
  await logins.save(another, {
    credential: credential("workspace-2"),
    identity: identity("A"),
    reconnect: false,
  });
  expect((await store.load()).accounts).toHaveLength(3);
  await logins.activate(another.id);
  expect(await auth.read((records) => records.openai)).toMatchObject({
    clientId: "client-workspace-2",
  });
  expect(await auth.read((records) => records[`paseo.subscription.${a.id}`])).toMatchObject({
    clientId: "client-A",
  });
});

test("a confirmed reset persists its receipt and concurrent duplicate clicks spend once", async () => {
  const { a, store, service, fixture } = await setup();
  const operationId = randomUUID();
  const action = { kind: "reset" as const, accountId: a.id, operationId, confirm: true as const };
  await Promise.all([service.action(action), service.action(action)]);
  await expect
    .poll(async () => (await operationState(service, operationId))?.state)
    .toBe("complete");
  await service.action(action);
  expect(fixture.resets).toEqual([`${a.id}:${operationId}`]);
  expect((await store.load()).resets[0]?.operation.message).toBe("reset");
  await expect
    .poll(
      async () =>
        (await service.read()).accounts[0]?.usage.find((usage) => usage.source === "codex")?.resets
          ?.available,
    )
    .toBe(2);
});

test("consume-then-lost-reply blocks a second spend and reconciles the SAME attempt after restart", async () => {
  const { a, b, service, fixture, options } = await setup();
  fixture.loseReply = true;
  const operationId = randomUUID();
  const action = { kind: "reset" as const, accountId: a.id, operationId, confirm: true as const };
  await service.action(action);
  await expect
    .poll(async () => (await operationState(service, operationId))?.state)
    .toBe("unknown");
  expect(fixture.available).toBe(2);
  service.close();
  const restarted = new SubscriptionAccounts(options);
  services.push(restarted);
  await restarted.start();
  await expect(restarted.action({ ...action, operationId: randomUUID() })).rejects.toThrow(
    "existing reset attempt",
  );
  await expect(restarted.action({ ...action, accountId: b.id })).rejects.toThrow("another account");
  await restarted.action(action);
  await expect
    .poll(async () => (await operationState(restarted, operationId))?.state)
    .toBe("complete");
  expect((await operationState(restarted, operationId))?.message).toBe("alreadyRedeemed");
  expect(fixture.available).toBe(2);
  expect(fixture.spent.size).toBe(1);
});

test("an unresolved reset cannot be retried against a reconnected different workspace", async () => {
  const { a, store, service, fixture } = await setup();
  fixture.loseReply = true;
  const operationId = randomUUID();
  const action = { kind: "reset" as const, accountId: a.id, operationId, confirm: true as const };
  await service.action(action);
  await expect
    .poll(async () => (await operationState(service, operationId))?.state)
    .toBe("unknown");
  await store.mutate((state) => {
    const account = state.accounts.find((entry) => entry.id === a.id);
    if (!account?.codex) throw new Error("Missing fixture connection");
    account.codex.identity.workspace = "different-workspace";
  });
  await expect(service.action(action)).rejects.toThrow("another authenticated identity/workspace");
  expect(fixture.spent.size).toBe(1);
});

test("logout clears only the requested credential, keeps the others saved and retains reconnect identity", async () => {
  const { a, b, store, auth, service } = await setup();
  const operation = await service.action({ kind: "logout", accountId: a.id, confirm: true });
  await expect.poll(async () => (await operationState(service, operation))?.state).toBe("complete");
  expect(await auth.read((records) => records.openai)).toBeUndefined();
  expect(await auth.read((records) => records[`paseo.subscription.${b.id}`])).toMatchObject({
    access: "access-B",
  });
  expect((await service.read()).accounts.find((account) => account.id === a.id)?.grants).toEqual(
    [],
  );
  expect(
    (await store.load()).accounts.find((account) => account.id === a.id)?.pi?.identity,
  ).toEqual(identity("A"));
});

test("usage refresh never holds the account snapshot hostage", async () => {
  const { service, fixture } = await setup();
  let release: () => void = () => {
    throw new Error("Fixture not initialized");
  };
  fixture.blockUsage = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    expect((await service.read(true)).accounts).toHaveLength(2);
  } finally {
    release();
  }
});

test("a cancelled switch does not move the active credential", async () => {
  const { auth, b, logins } = await setup();
  const before = await readFile(auth.path, "utf8");
  const controller = new AbortController();
  controller.abort();
  await expect(logins.activate(b.id, controller.signal)).rejects.toThrow();
  expect(await readFile(auth.path, "utf8")).toBe(before);
});

test("a reset receipt write failure stays uncertain and reuses the persisted pre-dispatch key", async () => {
  const { store, service, fixture, a } = await setup();
  fixture.afterSpend = () => {
    store.failWrites = true;
  };
  const operationId = randomUUID();
  const action = { kind: "reset" as const, accountId: a.id, operationId, confirm: true as const };
  await service.action(action);
  await expect
    .poll(async () => (await operationState(service, operationId))?.state)
    .toBe("unknown");
  expect(fixture.available).toBe(2);
  expect((await store.load()).resets[0]?.operation.state).toBe("pending");
  store.failWrites = false;
  fixture.afterSpend = () => {};
  await service.action(action);
  await expect
    .poll(async () => (await operationState(service, operationId))?.state)
    .toBe("complete");
  expect(fixture.available).toBe(2);
  expect(fixture.spent.size).toBe(1);
});

test("a staged Codex login is cleared if saving the connection fails", async () => {
  const { store, service, fixture, auth } = await setup();
  const before = await readFile(auth.path, "utf8");
  fixture.loginIdentity = identity("new-controls");
  fixture.afterLogin = () => {
    store.failWrites = true;
  };
  const operation = await service.action({
    kind: "login",
    provider: "openai",
    grant: "codex",
    label: "New controls",
  });
  await expect.poll(async () => (await operationState(service, operation))?.state).toBe("failed");
  expect(fixture.signedOut).toContain(operation);
  expect((await store.load()).accounts).toHaveLength(2);
  expect(await readFile(auth.path, "utf8")).toBe(before);
});

test("active logout refuses ambient API-key fallback without touching the credential file", async () => {
  const { auth, store, fixture, a } = await setup();
  const logins = new PiLogins({
    store,
    auth,
    oauth: fixture.oauth,
    env: { OPENAI_API_KEY: "fixture-ambient" },
  });
  const before = await readFile(auth.path, "utf8");
  await expect(logins.logout(a.id)).rejects.toThrow("API-key/auth environment overrides");
  expect(await readFile(auth.path, "utf8")).toBe(before);
});
