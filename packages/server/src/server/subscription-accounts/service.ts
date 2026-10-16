import { randomUUID } from "node:crypto";
import type { Logger } from "pino";
import { z } from "zod";
import type {
  AccountAction,
  AccountIdentity,
  AccountOperation,
  AccountsSnapshot,
  AccountUsage,
  SubscriptionAccount,
  SubscriptionProvider,
} from "@getpaseo/protocol/subscription-accounts";
import { ClaudeQuotaProvider } from "../../services/quota-fetcher/providers/claude.js";
import { AccountStore, type OAuthCredential, type SavedAccount, type SavedGrant } from "./store.js";
import type { LoginInteraction, LoginProfile } from "./oauth.js";
import type { ResetOutcome } from "./codex.js";
import type { PiLogins } from "./pi-logins.js";

interface ActiveOperation {
  view: AccountOperation;
  controller: AbortController;
  answer: ((value: string) => void) | null;
}
export interface CodexAccountPort {
  login(accountId: string, interaction: LoginInteraction): Promise<AccountIdentity>;
  usage(accountId: string, identity: AccountIdentity, signal: AbortSignal): Promise<AccountUsage>;
  redeem(
    accountId: string,
    identity: AccountIdentity,
    operationId: string,
    creditId: string | undefined,
    signal: AbortSignal,
  ): Promise<ResetOutcome>;
  logout(accountId: string, signal: AbortSignal): Promise<void>;
}
export interface AccountOAuthPort {
  login(
    provider: SubscriptionProvider,
    hostId: string,
    interaction: LoginInteraction,
    prior?: LoginProfile,
  ): Promise<SavedGrant>;
  refresh(provider: SubscriptionProvider, credential: OAuthCredential): Promise<OAuthCredential>;
  revoke(provider: SubscriptionProvider, credential: OAuthCredential): Promise<boolean>;
  claudeIdentity(credential: OAuthCredential): Promise<AccountIdentity>;
}
export interface SubscriptionAccountsOptions {
  store: AccountStore;
  logins: PiLogins;
  oauth: AccountOAuthPort;
  codex: CodexAccountPort;
  logger: Logger;
  now?: () => number;
}

/** Account forms, usage reads and confirmed reset receipts; no agent/runtime lifecycle ownership. */
export class SubscriptionAccounts {
  private readonly operations = new Map<string, ActiveOperation>();
  private readonly usage = new Map<string, AccountUsage[]>();
  private refresh: Promise<void> | null = null;
  private readonly usageAttempted = new Map<string, number>();
  private readonly now: () => number;
  private readonly codexTails = new Map<string, Promise<unknown>>();
  private actionTail: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: SubscriptionAccountsOptions) {
    this.now = options.now ?? Date.now;
  }

  async start(): Promise<void> {
    await this.options.store.mutate((state) => {
      for (const reset of state.resets) {
        if (reset.operation.state === "pending") {
          reset.operation.state = "unknown";
          reset.operation.message =
            "Host restarted during this reset. Retry this same attempt to reconcile.";
        }
      }
    });
  }

  close(): void {
    for (const operation of this.operations.values()) operation.controller.abort();
  }

  async read(refresh = false): Promise<AccountsSnapshot> {
    const state = await this.options.store.load();
    if (
      refresh ||
      state.accounts.some(
        (account) => this.now() - (this.usageAttempted.get(account.id) ?? 0) >= 60_000,
      )
    ) {
      this.refresh ??= this.refreshUsage()
        .catch(() => {
          this.options.logger.warn("Account usage refresh failed; last reported values retained");
        })
        .finally(() => {
          this.refresh = null;
        });
    }
    const native = await this.options.logins.snapshot();
    const latest = await this.options.store.load();
    return {
      native: native.native,
      accounts: latest.accounts.map(
        (account): SubscriptionAccount => ({
          id: account.id,
          label: account.label,
          provider: account.provider,
          active: native.active.has(account.id),
          grants: [
            ...(account.pi && native.connected.has(account.id)
              ? [
                  {
                    kind: "pi" as const,
                    status: account.pi.reconnect ? ("reconnect" as const) : ("connected" as const),
                    identity: account.pi.identity,
                  },
                ]
              : []),
            ...(account.codex
              ? [
                  {
                    kind: "codex" as const,
                    status: account.codex.reconnect
                      ? ("reconnect" as const)
                      : ("connected" as const),
                    identity: account.codex.identity,
                  },
                ]
              : []),
          ],
          usage: this.usage.get(account.id) ?? [],
        }),
      ),
      operations: [...this.operations.values()]
        .map((operation) => operation.view)
        .concat(
          latest.resets
            .filter((entry) => !this.operations.has(entry.operation.id))
            .map((entry) => entry.operation),
        ),
    };
  }

  action(action: AccountAction): Promise<string | null> {
    const result = this.actionTail.then(
      () => this.handleAction(action),
      () => this.handleAction(action),
    );
    this.actionTail = result;
    return result;
  }

  private async handleAction(action: AccountAction): Promise<string | null> {
    if (action.kind === "save_current") {
      await this.options.logins.saveCurrent(action.provider);
      return null;
    }
    if (action.kind === "answer") {
      const operation = this.requireOperation(action.operationId);
      if (!operation.answer || operation.view.state !== "input")
        throw new Error("This sign-in is not waiting for input");
      operation.answer(action.answer);
      operation.answer = null;
      operation.view = { ...operation.view, state: "pending", challenge: null };
      return operation.view.id;
    }
    if (action.kind === "cancel") {
      const operation = this.requireOperation(action.operationId);
      if (operation.view.kind === "reset" || operation.view.kind === "logout")
        throw new Error("A submitted reset or sign-out cannot be cancelled; check its outcome");
      operation.controller.abort();
      return operation.view.id;
    }
    if (action.kind === "reset") return this.reset(action);
    const accountId =
      action.kind === "login" ? (action.accountId ?? randomUUID()) : action.accountId;
    if (
      [...this.operations.values()].some(
        (entry) =>
          entry.view.accountId === accountId && ["pending", "input"].includes(entry.view.state),
      )
    )
      throw new Error("Finish or cancel this account's current operation first");
    const operation = this.createOperation(action.kind, accountId);
    this.launch(operation, async () => {
      if (action.kind === "login") await this.login(operation, action);
      else if (action.kind === "activate") await this.activate(operation);
      else await this.logout(operation);
    });
    return operation.view.id;
  }

  private createOperation(
    kind: AccountOperation["kind"],
    accountId: string,
    id: string = randomUUID(),
  ): ActiveOperation {
    if (
      [...this.operations.values()].filter((operation) =>
        ["pending", "input"].includes(operation.view.state),
      ).length >= 8
    )
      throw new Error("Too many account operations are open");
    const operation: ActiveOperation = {
      view: {
        id,
        kind,
        accountId,
        state: "pending",
        challenge: null,
        message: null,
        expiresAt: kind === "login" ? new Date(this.now() + 15 * 60_000).toISOString() : null,
      },
      controller: new AbortController(),
      answer: null,
    };
    this.operations.set(id, operation);
    return operation;
  }

  private launch(operation: ActiveOperation, work: () => Promise<void>): void {
    const deadline = setTimeout(() => operation.controller.abort(), 15 * 60_000);
    deadline.unref();
    void work()
      .then(
        () => {
          operation.view = { ...operation.view, state: "complete", challenge: null };
          return undefined;
        },
        (error: unknown) => {
          operation.view = {
            ...operation.view,
            state: operation.controller.signal.aborted ? "cancelled" : "failed",
            challenge: null,
            message: safeMessage(error),
          };
        },
      )
      .finally(() => {
        clearTimeout(deadline);
        operation.answer = null;
        this.trimOperations();
      });
  }

  private interaction(operation: ActiveOperation): LoginInteraction {
    return {
      signal: operation.controller.signal,
      challenge: (challenge) => {
        operation.view = {
          ...operation.view,
          state: challenge.prompt ? "input" : "pending",
          challenge,
        };
      },
      answer: (signal) => {
        signal.throwIfAborted();
        return new Promise<string>((resolve, reject) => {
          const abort = () => {
            operation.answer = null;
            reject(new Error("Sign-in cancelled"));
          };
          operation.answer = (answer) => {
            signal.removeEventListener("abort", abort);
            resolve(answer);
          };
          signal.addEventListener("abort", abort, { once: true });
        });
      },
    };
  }

  private async login(
    operation: ActiveOperation,
    action: Extract<AccountAction, { kind: "login" }>,
  ): Promise<void> {
    const state = await this.options.store.load();
    const prior = action.accountId ? await this.account(action.accountId) : undefined;
    const replacedCodex = prior?.codex;
    if (prior && prior.provider !== action.provider)
      throw new Error("Account provider cannot be changed");
    if (state.accounts.length >= 32 && !prior)
      throw new Error("The host already has 32 saved accounts");
    if (action.grant === "codex" && action.provider !== "openai")
      throw new Error("Codex controls belong to an OpenAI account");
    if (
      !prior &&
      state.accounts.some(
        (entry) =>
          entry.provider === action.provider &&
          entry.label.toLowerCase() === action.label.trim().toLowerCase(),
      )
    )
      throw new Error("Use a distinct label for this saved account");
    operation.view.message = `${action.label.trim()} · ${action.grant === "pi" ? "Pi subscription access" : "Codex usage and reset controls"}`;
    const interaction = this.interaction(operation);
    const account: SavedAccount = prior ?? {
      id: operation.view.accountId,
      label: action.label.trim(),
      provider: action.provider,
      pi: null,
      codex: null,
    };
    if (!account.label) throw new Error("Enter a label for this account");
    if (action.grant === "pi") {
      await this.loginPi(account, state.hostId, interaction);
    } else {
      account.codex = await this.loginControls(account, operation, interaction);
      account.codexIdentity = account.codex.identity;
    }
    this.usage.delete(account.id);
    if (action.grant === "codex" && replacedCodex) {
      try {
        await this.serialCodex(account.id, () =>
          this.options.codex.logout(
            replacedCodex.profileId ?? account.id,
            AbortSignal.timeout(30_000),
          ),
        );
      } catch {
        this.options.logger.warn(
          "Previous Codex connection was cleared locally; remote sign-out was not confirmed",
        );
      }
    }
    operation.view.message = "Account saved. Use account to make it active.";
  }

  private async loginPi(
    account: SavedAccount,
    hostId: string,
    interaction: LoginInteraction,
  ): Promise<void> {
    await this.options.logins.ready();
    if (account.pi && !account.pi.identity)
      throw new Error(
        "This imported Pi login has no verified identity. Add a new account to sign in; the imported login will stay saved.",
      );
    const grant = await this.options.oauth.login(
      account.provider,
      hostId,
      interaction,
      account.registration,
    );
    if (account.codex)
      await confirmAccountLink(grant.identity, account.codex.identity, account.label, interaction);
    interaction.signal.throwIfAborted();
    await this.options.logins.save(account, grant, interaction.signal);
  }

  private async loginControls(
    account: SavedAccount,
    operation: ActiveOperation,
    interaction: LoginInteraction,
  ): Promise<NonNullable<SavedAccount["codex"]>> {
    if (account.pi && !account.pi.identity)
      throw new Error(
        "Add a verified Pi sign-in before linking Codex controls; this imported login has no verified profile details",
      );
    // Stage reauthentication separately, so a wrong browser identity cannot replace a saved login.
    const profileId = operation.view.id;
    try {
      const identity = await this.options.codex.login(profileId, interaction);
      const expected = account.codex?.identity ?? account.codexIdentity;
      if (expected && !sameIdentity(expected, identity))
        throw new Error("Codex sign-in does not match this saved account");
      const piIdentity = account.pi?.identity ?? account.registration?.identity;
      if (piIdentity) await confirmAccountLink(piIdentity, identity, account.label, interaction);
      const connection = { identity, reconnect: false, profileId };
      await this.options.store.mutate((state) => {
        interaction.signal.throwIfAborted();
        const existing = state.accounts.find((entry) => entry.id === account.id);
        if (existing) {
          existing.codex = connection;
          existing.codexIdentity = identity;
        } else state.accounts.push({ ...account, codex: connection, codexIdentity: identity });
      });
      return connection;
    } catch (error) {
      try {
        // A rename may have succeeded before a durability error; never delete a committed login.
        const saved = (await this.options.store.load()).accounts.find(
          (entry) => entry.id === account.id,
        );
        if (saved?.codex?.profileId !== profileId)
          await this.options.codex.logout(profileId, AbortSignal.timeout(30_000));
      } catch {
        this.options.logger.warn("Incomplete Codex login cleanup failed");
      }
      throw error;
    }
  }

  private async activate(operation: ActiveOperation): Promise<void> {
    operation.controller.signal.throwIfAborted();
    await this.options.logins.activate(operation.view.accountId, operation.controller.signal);
    operation.view.message =
      "Active Pi login changed for this Mac, including terminal Pi. Current requests finish normally; subsequent requests use this account.";
  }

  private async logout(operation: ActiveOperation): Promise<void> {
    const account = await this.account(operation.view.accountId);
    const credential = account.pi ? await this.options.logins.logout(account.id) : null;
    {
      const removedCodex = await this.options.store.mutate((state) => {
        const stored = state.accounts.find((entry) => entry.id === account.id);
        if (!stored) throw new Error("Account disappeared during sign-out");
        const codex = stored.codex;
        stored.codex = null;
        return codex;
      });
      let revoked = false;
      if (credential) {
        try {
          revoked = await this.options.oauth.revoke(account.provider, credential);
        } catch {
          revoked = false;
        }
      }
      if (removedCodex) {
        try {
          await this.serialCodex(account.id, () =>
            this.options.codex.logout(
              removedCodex.profileId ?? account.id,
              operation.controller.signal,
            ),
          );
        } catch {
          revoked = false;
        }
      }
      this.usage.delete(account.id);
      operation.view.message = revoked
        ? "Signed out; the OpenAI renewable session was revoked."
        : "Signed out locally. Remote revocation was not confirmed; use provider settings to revoke access.";
    }
  }

  private async reset(action: Extract<AccountAction, { kind: "reset" }>): Promise<string> {
    const state = await this.options.store.load();
    const previous = state.resets.find((entry) => entry.operation.id === action.operationId);
    if (
      previous &&
      (previous.operation.accountId !== action.accountId ||
        previous.creditId !== (action.creditId ?? null))
    )
      throw new Error("Reset attempt belongs to another account or credit");
    if (
      previous?.operation.state === "complete" ||
      this.operations.get(action.operationId)?.view.state === "pending"
    )
      return action.operationId;
    if (
      state.resets.some(
        (entry) =>
          entry.operation.accountId === action.accountId &&
          entry.operation.id !== action.operationId &&
          ["pending", "unknown"].includes(entry.operation.state),
      )
    )
      throw new Error("Resolve the existing reset attempt before spending another credit");
    const account = await this.account(action.accountId);
    if (!account.codex || account.provider !== "openai")
      throw new Error("Connect Codex controls for this account first");
    const identity = account.codex.identity;
    if (previous && !sameIdentity(previous.identity, identity))
      throw new Error(
        "This reset attempt belongs to another authenticated identity/workspace; reconnect its original account",
      );
    const codexProfile = account.codex.profileId ?? account.id;
    const operation = this.createOperation("reset", account.id, action.operationId);
    // Durable before dispatch. Restarts/retries preserve this exact account-bound idempotency key.
    await this.options.store.mutate((next) => {
      const row = next.resets.find((entry) => entry.operation.id === action.operationId);
      if (row) row.operation = operation.view;
      else
        next.resets.push({
          operation: operation.view,
          creditId: action.creditId ?? null,
          identity,
        });
    });
    void this.serialCodex(account.id, async () => {
      const signal = AbortSignal.timeout(90_000);
      let dispatched = false;
      try {
        if (!previous || previous.operation.state === "failed") {
          const usage = await this.options.codex.usage(codexProfile, identity, signal);
          if (!usage.resets || usage.resets.available < 1)
            throw new Error("No available banked reset was reported");
          if (
            action.creditId &&
            !usage.resets.credits?.some((credit) => credit.id === action.creditId)
          )
            throw new Error("The selected credit is no longer available");
        }
        dispatched = true;
        const outcome = await this.options.codex.redeem(
          codexProfile,
          identity,
          action.operationId,
          action.creditId,
          signal,
        );
        const completed: AccountOperation = {
          ...operation.view,
          state: "complete",
          message: outcome,
        };
        // Publish completion only after its receipt is durable.
        await this.saveReset(completed);
        operation.view = completed;
        const usage = await this.options.codex.usage(codexProfile, identity, signal);
        this.usage.set(account.id, [sharingUsage(), usage]);
      } catch (error) {
        if (operation.view.state !== "complete") {
          operation.view = {
            ...operation.view,
            state: dispatched ? "unknown" : "failed",
            message: dispatched
              ? `${safeMessage(error)} Retry this same attempt to reconcile; do not start a new reset.`
              : `${safeMessage(error)} No reset request was sent.`,
          };
          await this.saveReset(operation.view);
        } else operation.view.message = `${operation.view.message}; refreshed limits unavailable`;
      }
    }).catch(() => {
      operation.view = {
        ...operation.view,
        state: "unknown",
        message: "Reset receipt could not be saved. Do not initiate another reset.",
      };
    });
    return operation.view.id;
  }

  private saveReset(operation: AccountOperation): Promise<void> {
    return this.options.store.mutate((state) => {
      const row = state.resets.find((entry) => entry.operation.id === operation.id);
      if (!row) throw new Error("Reset receipt is missing");
      row.operation = operation;
    });
  }

  private async refreshUsage(): Promise<void> {
    const native = await this.options.logins.snapshot();
    for (const account of (await this.options.store.load()).accounts) {
      const previous = this.usage.get(account.id) ?? [];
      this.usageAttempted.set(account.id, this.now());
      try {
        if (account.provider === "anthropic" && account.pi && native.connected.has(account.id)) {
          const token = await this.options.logins.credential(account.id);
          const provider = new ClaudeQuotaProvider({
            logger: this.options.logger,
            credentials: async () => ({
              oauth: {
                accessToken: token.access,
                ...(account.pi?.identity?.plan
                  ? { subscriptionType: account.pi.identity.plan }
                  : {}),
              },
            }),
          });
          const result = await provider.fetchUsage();
          if (result.status !== "available")
            throw new Error("Claude usage unavailable; check sign-in");
          this.usage.set(account.id, [
            {
              source: "claude",
              fetchedAt: new Date(this.now()).toISOString(),
              error: null,
              manageUrl: "https://claude.ai/settings/usage",
              resets: null,
              windows: result.windows.map((window) => ({
                id: window.id,
                label: window.label,
                usedPercent: window.usedPct ?? null,
                resetsAt: window.resetsAt ?? null,
              })),
            },
          ]);
        } else if (account.provider === "openai") {
          const renewalError = native.connected.has(account.id)
            ? await this.renewPiLogin(account.id)
            : null;
          const codex = account.codex;
          const usage = codex
            ? await this.serialCodex(account.id, () =>
                this.options.codex.usage(
                  codex.profileId ?? account.id,
                  codex.identity,
                  AbortSignal.timeout(60_000),
                ),
              )
            : null;
          this.usage.set(account.id, [sharingUsage(renewalError), ...(usage ? [usage] : [])]);
        } else this.usage.set(account.id, []);
      } catch (error) {
        const source = account.provider === "anthropic" ? "claude" : "codex";
        const old = previous.find((value) => value.source === source);
        this.usage.set(account.id, [
          ...(account.provider === "openai" ? [sharingUsage()] : []),
          {
            ...(old ?? { source, fetchedAt: null, manageUrl: null, windows: [], resets: null }),
            error: safeMessage(error),
          },
        ]);
      }
    }
  }

  private async renewPiLogin(id: string): Promise<string | null> {
    try {
      await this.options.logins.credential(id);
      return null;
    } catch (error) {
      return `Pi sign-in could not be renewed: ${safeMessage(error)} Retry or reconnect this account.`;
    }
  }

  private async account(id: string): Promise<SavedAccount> {
    const account = (await this.options.store.load()).accounts.find((entry) => entry.id === id);
    if (!account) throw new Error("Saved account not found");
    return account;
  }

  private serialCodex<T>(id: string, task: () => Promise<T>): Promise<T> {
    const previous = this.codexTails.get(id) ?? Promise.resolve();
    const next = previous.then(task, task);
    this.codexTails.set(id, next);
    const finished = () => {
      if (this.codexTails.get(id) === next) this.codexTails.delete(id);
    };
    void next.then(finished, finished);
    return next;
  }

  private requireOperation(id: string): ActiveOperation {
    const operation = this.operations.get(id);
    if (!operation) throw new Error("Account operation expired; start again");
    return operation;
  }

  private trimOperations(): void {
    const finished = [...this.operations].filter(([, value]) =>
      ["complete", "failed", "cancelled"].includes(value.view.state),
    );
    for (const [id] of finished.slice(0, Math.max(0, finished.length - 32)))
      this.operations.delete(id);
  }
}

async function confirmAccountLink(
  pi: AccountIdentity,
  codex: AccountIdentity,
  label: string,
  interaction: LoginInteraction,
): Promise<void> {
  if (pi.email && codex.email && pi.email.toLowerCase() !== codex.email.toLowerCase())
    throw new Error("Pi and Codex are signed in to different email accounts");
  interaction.challenge({
    url: null,
    userCode: null,
    prompt: `Confirm that Codex ${codex.email ?? "account"} / ${codex.workspace ?? "workspace"} belongs with Pi ${pi.email ?? label}. Type LINK to connect the controls. Their quota scopes remain separate.`,
  });
  if ((await interaction.answer(interaction.signal)).trim() !== "LINK")
    throw new Error("Account linking was not confirmed");
}

function sameIdentity(a: AccountIdentity, b: AccountIdentity): boolean {
  return a.subject === b.subject && a.workspace === b.workspace;
}
function safeMessage(error: unknown): string {
  if (error instanceof z.ZodError)
    return "Provider account data changed format; update the host integration";
  return error instanceof Error ? error.message : "Account operation failed";
}
function sharingUsage(renewalError: string | null = null): AccountUsage {
  return {
    source: "chatgpt-sharing",
    fetchedAt: null,
    error: [
      renewalError,
      "Pi uses ChatGPT plan sharing. Its exact allowance is not exposed by the verified integration; Codex counters below are a separate scope.",
    ]
      .filter(Boolean)
      .join(" "),
    manageUrl: "https://chatgpt.com/settings/usage",
    windows: [],
    resets: null,
  };
}
