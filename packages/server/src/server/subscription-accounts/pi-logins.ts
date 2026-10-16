import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import type {
  AccountIdentity,
  SubscriptionProvider,
} from "@getpaseo/protocol/subscription-accounts";
import {
  AccountStore,
  OAuthCredentialSchema,
  type OAuthCredential,
  type SavedAccount,
  type SavedGrant,
} from "./store.js";
import type { SubscriptionOAuth } from "./oauth.js";
import { PiAuthFile, type PiAuthRecords } from "./pi-auth-file.js";

export interface PiLoginSnapshot {
  connected: Set<string>;
  active: Set<string>;
  native: { provider: SubscriptionProvider; external: boolean; error: string | null }[];
}
export interface PiLoginsOptions {
  store: AccountStore;
  auth: PiAuthFile;
  oauth: Pick<SubscriptionOAuth, "refresh" | "claudeIdentity">;
  env: NodeJS.ProcessEnv;
  explicitKey?: boolean;
}
const PROVIDERS = ["anthropic", "openai"] as const;
const AUTH_ENV = {
  anthropic: [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_OAUTH_TOKEN",
    "ANTHROPIC_FEDERATION_RULE_ID",
    "ANTHROPIC_IDENTITY_TOKEN_FILE",
  ],
  openai: ["OPENAI_API_KEY"],
};

function slot(id: string): string {
  return `paseo.subscription.${id}`;
}
function sameRegistration(account: SavedAccount, grant: SavedGrant): boolean {
  // SIWC binds workspaces to issued clients. One subject/email can own several registrations.
  if (account.provider === "openai") return account.pi?.clientId === grant.credential.clientId;
  return account.pi?.identity ? identityMatches(account.pi.identity, grant.identity) : false;
}
function identityMatches(a: AccountIdentity, b: AccountIdentity): boolean {
  return a.subject === b.subject && a.workspace === b.workspace;
}
function stored(value: unknown): OAuthCredential {
  const credential = OAuthCredentialSchema.safeParse(value);
  if (!credential.success)
    throw new Error("Pi's current login is not a supported subscription credential");
  return credential.data;
}

/** Active and inactive credentials move within ONE Pi auth-file transaction; metadata has no tokens. */
export class PiLogins {
  private claudeProfile: { access: string; identity: AccountIdentity } | null = null;
  constructor(private readonly options: PiLoginsOptions) {}

  async ready(): Promise<void> {
    await this.options.auth.ready();
  }

  async snapshot(): Promise<PiLoginSnapshot> {
    let renewalFailed = false;
    try {
      await this.refreshCurrentClaude();
    } catch {
      renewalFailed = true;
    }
    const accounts = (await this.options.store.load()).accounts;
    return this.options.auth.read(async (records) => {
      const view: PiLoginSnapshot = { connected: new Set(), active: new Set(), native: [] };
      for (const account of accounts) {
        if (records[slot(account.id)] !== undefined) {
          stored(records[slot(account.id)]);
          view.connected.add(account.id);
        }
      }
      for (const provider of PROVIDERS) {
        try {
          if (provider === "anthropic" && renewalFailed) throw new Error("Claude renewal failed");
          const id = await this.activeAccount(provider, records, accounts);
          if (id) {
            view.connected.add(id);
            view.active.add(id);
          }
          view.native.push({
            provider,
            external: records[provider] !== undefined && !id,
            error: null,
          });
        } catch {
          view.native.push({
            provider,
            external: false,
            error:
              "Pi's current login could not be verified. Check its sign-in and retry; no credentials were changed.",
          });
        }
      }
      return view;
    });
  }

  async saveCurrent(provider: SubscriptionProvider): Promise<void> {
    await this.assertNoOverrides(provider);
    if (provider === "anthropic") await this.refreshCurrentClaude();
    await this.options.auth.read(async (records) => {
      const state = await this.options.store.load();
      if (await this.activeAccount(provider, records, state.accounts)) return;
      const credential = stored(records[provider]);
      const identity = provider === "anthropic" ? await this.profile(credential) : null;
      if (provider === "openai" && !credential.clientId)
        throw new Error(
          "This OpenAI login predates the supported Pi sign-in format; add a new account instead",
        );
      await this.options.store.mutate((next) => {
        if (next.accounts.length >= 32) throw new Error("The host already has 32 saved accounts");
        const label = `Existing ${provider === "anthropic" ? "Claude" : "OpenAI"} login`;
        const count = next.accounts.filter((account) => account.label.startsWith(label)).length;
        next.accounts.push({
          id: randomUUID(),
          label: count ? `${label} ${count + 1}` : label,
          provider,
          pi: { identity, clientId: credential.clientId, reconnect: false },
          codex: null,
          ...(identity ? { registration: { identity, clientId: credential.clientId } } : {}),
        });
      });
    });
  }

  async save(account: SavedAccount, grant: SavedGrant, signal?: AbortSignal): Promise<void> {
    if (account.provider === "openai" && !grant.credential.clientId)
      throw new Error("OpenAI's issued client ID is missing");
    if (account.provider === "anthropic") await this.refreshCurrentClaude();
    await this.options.auth.change(async (records) => {
      const accounts = (await this.options.store.load()).accounts;
      const active = await this.activeAccount(account.provider, records, accounts);
      if (active === account.id) await this.assertNoOverrides(account.provider);
      await this.options.store.mutate((state) => {
        signal?.throwIfAborted();
        const existing = state.accounts.find((entry) => entry.id === account.id);
        const duplicate = state.accounts.find(
          (entry) =>
            entry.id !== account.id &&
            entry.provider === account.provider &&
            sameRegistration(entry, grant),
        );
        if (duplicate)
          throw new Error(
            `This account is already saved as ${duplicate.label}; reconnect it instead`,
          );
        const updated = existing ?? account;
        updated.pi = {
          identity: grant.identity,
          clientId: grant.credential.clientId,
          reconnect: false,
        };
        updated.registration = { identity: grant.identity, clientId: grant.credential.clientId };
        if (!existing) state.accounts.push(updated);
      });
      records[active === account.id ? account.provider : slot(account.id)] = grant.credential;
    });
  }

  async activate(id: string, signal?: AbortSignal): Promise<void> {
    await this.credential(id);
    await this.options.auth.change(async (records) => {
      const accounts = (await this.options.store.load()).accounts;
      const account = this.account(accounts, id);
      await this.assertNoOverrides(account.provider);
      const active = await this.activeAccount(account.provider, records, accounts);
      if (active === id) return;
      if (records[account.provider] !== undefined && !active)
        throw new Error(
          "Save the existing Pi login on this page before switching. It has not been overwritten.",
        );
      const credential = stored(records[slot(id)]);
      signal?.throwIfAborted();
      if (active) records[slot(active)] = records[account.provider];
      records[account.provider] = credential;
      delete records[slot(id)];
    });
  }

  async credential(id: string): Promise<OAuthCredential> {
    const requested = this.account((await this.options.store.load()).accounts, id);
    if (requested.provider === "anthropic") await this.refreshCurrentClaude();
    return this.options.auth.change(async (records) => {
      const accounts = (await this.options.store.load()).accounts;
      const account = this.account(accounts, id);
      const key = await this.key(account, records, accounts);
      const credential = await this.renew(account.provider, stored(records[key]));
      records[key] = credential;
      return credential;
    });
  }

  async logout(id: string): Promise<OAuthCredential | null> {
    return this.options.auth.change(async (records) => {
      const accounts = (await this.options.store.load()).accounts;
      const account = this.account(accounts, id);
      const active = await this.activeAccount(account.provider, records, accounts);
      if (active === id) await this.assertNoOverrides(account.provider);
      const key = active === id ? account.provider : slot(id);
      if (records[key] === undefined) return null;
      const credential = stored(records[key]);
      delete records[key];
      return credential;
    });
  }

  private async key(
    account: SavedAccount,
    records: PiAuthRecords,
    accounts: SavedAccount[],
  ): Promise<string> {
    if (records[slot(account.id)] !== undefined) return slot(account.id);
    if ((await this.activeAccount(account.provider, records, accounts)) === account.id)
      return account.provider;
    throw new Error("Reconnect this account; its Pi login is no longer stored");
  }

  private account(accounts: SavedAccount[], id: string): SavedAccount {
    const account = accounts.find((entry) => entry.id === id);
    if (!account?.pi) throw new Error("Connect Pi for this saved account first");
    return account;
  }

  private async activeAccount(
    provider: SubscriptionProvider,
    records: PiAuthRecords,
    accounts: SavedAccount[],
  ): Promise<string | null> {
    if (records[provider] === undefined) return null;
    const credential = stored(records[provider]);
    if (provider === "openai") {
      if (!credential.clientId) throw new Error("Pi's OpenAI login has no registration ID");
      return (
        accounts.find(
          (account) =>
            account.provider === provider && account.pi?.clientId === credential.clientId,
        )?.id ?? null
      );
    }
    const identity = await this.profile(credential);
    return (
      accounts.find(
        (account) =>
          account.provider === provider &&
          account.pi?.identity &&
          identityMatches(account.pi.identity, identity),
      )?.id ?? null
    );
  }

  private async profile(credential: OAuthCredential): Promise<AccountIdentity> {
    if (this.claudeProfile?.access === credential.access) return this.claudeProfile.identity;
    const identity = await this.options.oauth.claudeIdentity(credential);
    this.claudeProfile = { access: credential.access, identity };
    return identity;
  }

  private async refreshCurrentClaude(): Promise<void> {
    const required = await this.options.auth.read((records) => {
      const value = OAuthCredentialSchema.safeParse(records.anthropic);
      return value.success && value.data.expires <= Date.now() + 5 * 60_000;
    });
    if (!required) return;
    await this.options.auth.change(async (records) => {
      if (records.anthropic === undefined) return;
      records.anthropic = await this.renew("anthropic", stored(records.anthropic));
    });
  }

  private async renew(
    provider: SubscriptionProvider,
    credential: OAuthCredential,
  ): Promise<OAuthCredential> {
    if (credential.expires > Date.now() + 5 * 60_000) return credential;
    // Pi's file lock also covers this renewal, so it cannot race a native Pi refresh.
    return this.options.oauth.refresh(provider, credential);
  }

  private async assertNoOverrides(provider: SubscriptionProvider): Promise<void> {
    if (this.options.explicitKey)
      throw new Error("Remove Pi's --api-key option before managing subscription logins");
    if (AUTH_ENV[provider].some((name) => this.options.env[name]))
      throw new Error(
        "Remove Pi's API-key/auth environment overrides before managing subscription logins; logout must not fall back to them",
      );
    let content: string;
    try {
      content = await readFile(join(dirname(this.options.auth.path), "models.json"), "utf8");
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
      throw error;
    }
    const configuration = z
      .object({ providers: z.record(z.string(), z.unknown()).optional() })
      .parse(JSON.parse(content));
    const entry = configuration.providers?.[provider];
    if (entry === undefined) return;
    const override = z
      .object({
        apiKey: z.unknown().optional(),
        headers: z.record(z.string(), z.unknown()).optional(),
      })
      .parse(entry);
    const credentialHeaders = Object.keys(override.headers ?? {}).some((header) =>
      /^(authorization|x-api-key|api-key|cookie)$/i.test(header),
    );
    if (override.apiKey !== undefined || credentialHeaders)
      throw new Error(
        "Remove this provider's models.json credential overrides before managing subscription logins",
      );
  }
}
