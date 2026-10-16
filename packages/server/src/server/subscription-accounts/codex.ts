import { spawn } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import type { Logger } from "pino";
import { z } from "zod";
import type { AccountIdentity, AccountUsage } from "@getpaseo/protocol/subscription-accounts";
import { CodexAppServerClient } from "../agent/providers/codex/app-server-transport.js";
import type { ManagedProcessRegistry } from "../managed-processes/managed-processes.js";
import { ensurePrivateDirectory } from "./store.js";
import type { LoginInteraction } from "./oauth.js";

const WindowSchema = z.object({
  usedPercent: z.number().nullable().optional(),
  windowDurationMins: z.number().nullable().optional(),
  resetsAt: z.number().nullable().optional(),
});
const LimitSchema = z.object({
  limitId: z.string().nullable().optional(),
  limitName: z.string().nullable().optional(),
  primary: WindowSchema.nullable().optional(),
  secondary: WindowSchema.nullable().optional(),
});
const LimitsSchema = z.object({
  accountId: z.string().nullable().optional(),
  rateLimits: LimitSchema.nullable().optional(),
  rateLimitsByLimitId: z.record(z.string(), LimitSchema).nullable().optional(),
  rateLimitResetCredits: z
    .object({
      availableCount: z.number().int().nonnegative(),
      credits: z
        .array(
          z.object({
            id: z.string(),
            title: z.string().nullable().optional(),
            expiresAt: z.number().nullable().optional(),
            status: z.string(),
          }),
        )
        .nullable()
        .optional(),
    })
    .nullable()
    .optional(),
});
const ResetOutcomeSchema = z.object({
  outcome: z.enum(["reset", "alreadyRedeemed", "nothingToReset", "noCredit"]),
});
export type ResetOutcome = z.infer<typeof ResetOutcomeSchema>["outcome"];
const AccountSchema = z.object({
  account: z.object({
    type: z.literal("chatgpt"),
    email: z.string().nullable(),
    planType: z.string(),
  }),
});
const SavedAuthSchema = z.object({
  auth_mode: z.literal("chatgpt"),
  tokens: z.object({ id_token: z.string(), account_id: z.string() }),
});
const ClaimsSchema = z.object({
  sub: z.string(),
  email: z.string().optional(),
  "https://api.openai.com/auth": z
    .object({ chatgpt_user_id: z.string().optional(), chatgpt_account_id: z.string().optional() })
    .optional(),
});

type AccountMethod =
  | "account/read"
  | "account/login/start"
  | "account/logout"
  | "account/rateLimits/read"
  | "account/rateLimitResetCredit/consume";

/** A short-lived control connection in one isolated Codex profile. It never starts a model turn. */
export class CodexAccounts {
  constructor(
    private readonly root: string,
    private readonly logger: Logger,
    private readonly processes: ManagedProcessRegistry,
  ) {}

  private directory(accountId: string): string {
    return join(this.root, z.string().uuid().parse(accountId), "codex");
  }

  async login(accountId: string, interaction: LoginInteraction): Promise<AccountIdentity> {
    return this.withClient(accountId, interaction.signal, async (client) => {
      const completed = new Promise<void>((resolve, reject) => {
        client.setNotificationHandler((method, value) => {
          if (method !== "account/login/completed") return;
          const parsed = z.object({ success: z.boolean() }).safeParse(value);
          if (parsed.success && parsed.data.success) resolve();
          else reject(new Error("Codex sign-in did not complete"));
        });
        client.setUnexpectedTerminationHandler(() =>
          reject(new Error("Codex sign-in connection closed")),
        );
      });
      // Attach a rejection observer before awaiting start: startup can close the child first.
      void completed.catch(() => {});
      const login = z
        .object({
          type: z.literal("chatgptDeviceCode"),
          loginId: z.string(),
          userCode: z.string(),
          verificationUrl: z.string().url(),
        })
        .parse(await this.request(client, "account/login/start", { type: "chatgptDeviceCode" }));
      if (new URL(login.verificationUrl).origin !== "https://auth.openai.com")
        throw new Error("Unexpected Codex sign-in URL");
      interaction.challenge({ url: login.verificationUrl, userCode: login.userCode, prompt: null });
      await waitFor(completed, interaction.signal);
      return this.identity(client, accountId);
    });
  }

  async usage(
    accountId: string,
    expected: AccountIdentity,
    signal: AbortSignal,
  ): Promise<AccountUsage> {
    return this.withClient(accountId, signal, async (client) => {
      await this.checkIdentity(client, accountId, expected);
      const result = LimitsSchema.parse(await this.request(client, "account/rateLimits/read"));
      if (result.accountId && result.accountId !== expected.workspace)
        throw new Error("Codex quota belongs to a different workspace");
      return codexUsage(result);
    });
  }

  async redeem(
    accountId: string,
    expected: AccountIdentity,
    operationId: string,
    creditId: string | undefined,
    signal: AbortSignal,
  ): Promise<ResetOutcome> {
    return this.withClient(accountId, signal, async (client) => {
      await this.checkIdentity(client, accountId, expected);
      return ResetOutcomeSchema.parse(
        await this.request(client, "account/rateLimitResetCredit/consume", {
          idempotencyKey: operationId,
          ...(creditId ? { creditId } : {}),
        }),
      ).outcome;
    });
  }

  async logout(accountId: string, signal: AbortSignal): Promise<void> {
    try {
      await this.withClient(accountId, signal, (client) => this.request(client, "account/logout"));
    } finally {
      await rm(join(this.directory(accountId), "auth.json"), { force: true });
    }
  }

  private async checkIdentity(
    client: CodexAppServerClient,
    id: string,
    expected: AccountIdentity,
  ): Promise<void> {
    const identity = await this.identity(client, id);
    if (identity.subject !== expected.subject || identity.workspace !== expected.workspace)
      throw new Error("Codex identity changed; reconnect this saved account");
  }

  private async identity(
    client: CodexAppServerClient,
    accountId: string,
  ): Promise<AccountIdentity> {
    // The official CLI authenticates the token. Decode only its owned identity record, never a
    // pasted JWT. Cross-check the CLI account/read response before exposing a display identity.
    const account = AccountSchema.parse(
      await this.request(client, "account/read", { refreshToken: true }),
    ).account;
    const saved = SavedAuthSchema.parse(
      JSON.parse(await readFile(join(this.directory(accountId), "auth.json"), "utf8")),
    );
    const payload = saved.tokens.id_token.split(".")[1];
    if (!payload) throw new Error("Codex saved identity is incomplete");
    const claims = ClaimsSchema.parse(
      JSON.parse(Buffer.from(payload, "base64url").toString("utf8")),
    );
    const auth = claims["https://api.openai.com/auth"];
    if (
      (claims.email &&
        account.email &&
        claims.email.toLowerCase() !== account.email.toLowerCase()) ||
      (auth?.chatgpt_account_id && auth.chatgpt_account_id !== saved.tokens.account_id)
    )
      throw new Error("Codex authenticated account does not match its saved identity");
    return {
      subject: auth?.chatgpt_user_id ?? claims.sub,
      email: account.email,
      workspace: saved.tokens.account_id,
      plan: account.planType,
    };
  }

  private async request(
    client: CodexAppServerClient,
    method: AccountMethod,
    params?: unknown,
  ): Promise<unknown> {
    try {
      return await client.request(method, params, 30_000);
    } catch {
      throw new Error(
        `Codex ${method} failed; check the connection and sign-in. The outcome may be unknown.`,
      );
    }
  }

  private async withClient<T>(
    accountId: string,
    signal: AbortSignal,
    run: (client: CodexAppServerClient) => Promise<T>,
  ): Promise<T> {
    signal.throwIfAborted();
    const directory = this.directory(accountId);
    const home = join(directory, "os-home");
    await ensurePrivateDirectory(directory);
    await ensurePrivateDirectory(home);
    const args = [
      "app-server",
      "-c",
      'forced_login_method="chatgpt"',
      "-c",
      'cli_auth_credentials_store="file"',
    ];
    const child = spawn("codex", args, {
      cwd: home,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        PATH: process.env.PATH,
        HOME: home,
        CODEX_HOME: directory,
        LANG: "en_US.UTF-8",
        NO_COLOR: "1",
      },
    });
    // This transport's ordinary traces include provider messages. Login flows must never log them.
    const client = new CodexAppServerClient(child, this.logger.child({}, { level: "silent" }));
    const abort = () => {
      child.kill("SIGTERM");
    };
    signal.addEventListener("abort", abort, { once: true });
    let recordId: string | undefined;
    try {
      if (!child.pid) throw new Error("Could not start the Codex account helper");
      recordId = (
        await this.processes.record({
          owner: { provider: "codex", kind: "subscription-accounts" },
          pid: child.pid,
          command: "codex",
          args,
        })
      ).id;
      signal.throwIfAborted();
      await client.request(
        "initialize",
        { clientInfo: { name: "paseo_workspace", title: "Paseo Workspace", version: "0.10.3" } },
        30_000,
      );
      client.notify("initialized", {});
      return await run(client);
    } finally {
      signal.removeEventListener("abort", abort);
      await client.dispose();
      if (recordId) await this.processes.remove(recordId);
    }
  }
}

export function codexUsage(result: z.infer<typeof LimitsSchema>): AccountUsage {
  const buckets =
    result.rateLimitsByLimitId ??
    (result.rateLimits ? { [result.rateLimits.limitId ?? "codex"]: result.rateLimits } : {});
  const windows: AccountUsage["windows"] = [];
  for (const [id, limit] of Object.entries(buckets)) {
    for (const slot of ["primary", "secondary"] as const) {
      const window = limit[slot];
      if (!window) continue;
      const duration = window.windowDurationMins;
      let label: string = slot;
      if (duration === 300) label = "5 hours";
      else if (duration === 10080) label = "Weekly";
      else if (duration) label = `${duration} minutes`;
      windows.push({
        id: `${id}:${slot}`,
        label: `${limit.limitName ?? id} · ${label}`,
        usedPercent: window.usedPercent ?? null,
        resetsAt: window.resetsAt ? new Date(window.resetsAt * 1000).toISOString() : null,
      });
    }
  }
  const credits = result.rateLimitResetCredits;
  return {
    source: "codex",
    fetchedAt: new Date().toISOString(),
    error: null,
    manageUrl: "https://chatgpt.com/codex/settings/usage",
    windows,
    resets: credits
      ? {
          available: credits.availableCount,
          credits:
            credits.credits
              ?.filter((credit) => credit.status === "available")
              .map((credit) => ({
                id: credit.id,
                title: credit.title ?? null,
                expiresAt: credit.expiresAt
                  ? new Date(credit.expiresAt * 1000).toISOString()
                  : null,
              })) ?? null,
        }
      : null,
  };
}

function waitFor<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(new Error("Sign-in cancelled"));
    signal.addEventListener("abort", abort, { once: true });
    void operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
