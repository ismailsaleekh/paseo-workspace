import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
  AccountIdentitySchema,
  AccountOperationSchema,
  SubscriptionProviderSchema,
} from "@getpaseo/protocol/subscription-accounts";

export const OAuthCredentialSchema = z
  .object({
    type: z.literal("oauth"),
    access: z.string().min(1),
    refresh: z.string().min(1),
    expires: z.number().finite(),
    clientId: z.string().optional(),
    idToken: z.string().optional(),
    scopes: z.array(z.string()).optional(),
  })
  .passthrough();
export type OAuthCredential = z.infer<typeof OAuthCredentialSchema>;
export const SavedGrantSchema = z.object({
  credential: OAuthCredentialSchema,
  identity: AccountIdentitySchema,
  reconnect: z.boolean(),
});
export type SavedGrant = z.infer<typeof SavedGrantSchema>;
export const SavedAccountSchema = z.object({
  id: z.string().uuid(),
  label: z.string().min(1).max(64),
  provider: SubscriptionProviderSchema,
  // Credentials live only in Pi's auth file (active provider or inactive saved slot).
  pi: z
    .object({
      identity: AccountIdentitySchema.nullable(),
      clientId: z.string().optional(),
      reconnect: z.boolean(),
    })
    .nullable(),
  // Non-secret registration survives sign-out; reauthorization must not create a new client.
  registration: z
    .object({ identity: AccountIdentitySchema, clientId: z.string().optional() })
    .optional(),
  codexIdentity: AccountIdentitySchema.optional(),
  // Codex owns its auth file; only the authenticated identity lives here.
  codex: z
    .object({
      identity: AccountIdentitySchema,
      reconnect: z.boolean(),
      profileId: z.string().uuid().optional(),
    })
    .nullable(),
});
export type SavedAccount = z.infer<typeof SavedAccountSchema>;
export const AccountStateSchema = z.object({
  version: z.literal(1),
  hostId: z.string().uuid(),
  accounts: z.array(SavedAccountSchema),
  resets: z.array(
    z.object({
      operation: AccountOperationSchema,
      creditId: z.string().nullable(),
      identity: AccountIdentitySchema,
    }),
  ),
});
export type AccountState = z.infer<typeof AccountStateSchema>;

/** Private account metadata and reset receipts. Pi credentials are never copied into this file. */
export class AccountStore {
  private tail: Promise<void> = Promise.resolve();
  private state: AccountState | null = null;
  private initialized = false;
  private loading: Promise<AccountState> | null = null;
  readonly directory: string;
  constructor(paseoHome: string) {
    this.directory = join(paseoHome, "subscription-accounts");
  }

  async load(): Promise<AccountState> {
    if (this.state) return structuredClone(this.state);
    this.loading ??= this.loadFile();
    try {
      return structuredClone(await this.loading);
    } finally {
      this.loading = null;
    }
  }

  private async loadFile(): Promise<AccountState> {
    await ensurePrivateDirectory(this.directory);
    const path = join(this.directory, "state.json");
    try {
      const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size > 2 * 1024 * 1024 || (stat.mode & 0o077) !== 0)
          throw new Error("Account storage must be a private regular file (0600)");
        const parsed = AccountStateSchema.parse(JSON.parse(await handle.readFile("utf8")));
        assertAccountState(parsed);
        this.state = parsed;
      } finally {
        await handle.close();
      }
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      if (this.initialized)
        throw new Error("Account metadata disappeared; restore its storage before continuing", {
          cause: error,
        });
      const initial: AccountState = {
        version: 1,
        hostId: randomUUID(),
        accounts: [],
        resets: [],
      };
      await this.save(initial);
      this.state = initial;
    }
    this.initialized = true;
    return structuredClone(this.state);
  }

  async mutate<T>(change: (state: AccountState) => Promise<T> | T): Promise<T> {
    const previous = this.tail;
    let release: () => void = () => {
      throw new Error("Account write queue was not initialized");
    };
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      const next = await this.load();
      const result = await change(next);
      const valid = AccountStateSchema.parse(next);
      assertAccountState(valid);
      try {
        await this.save(valid);
      } catch (error) {
        // A failed directory fsync may follow a successful rename. Re-read the authoritative file
        // rather than writing an older cached refresh token over the committed replacement.
        this.state = null;
        throw error;
      }
      this.state = valid;
      return result;
    } finally {
      release();
    }
  }

  private async save(state: AccountState): Promise<void> {
    const temporary = join(this.directory, `.state-${randomUUID()}`);
    try {
      const handle = await open(temporary, "wx", 0o600);
      try {
        await handle.writeFile(JSON.stringify(state));
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, join(this.directory, "state.json"));
      const directory = await open(this.directory, "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } finally {
      await rm(temporary, { force: true });
    }
  }
}

function assertAccountState(state: AccountState): void {
  const accounts = new Map<string, SavedAccount>();
  const codexProfiles = new Set<string>();
  const openaiRegistrations = new Set<string>();
  for (const account of state.accounts) {
    if (accounts.has(account.id)) throw new Error("Account storage contains duplicate account IDs");
    accounts.set(account.id, account);
    if (account.provider === "openai" && account.pi?.clientId) {
      if (openaiRegistrations.has(account.pi.clientId))
        throw new Error("Two saved accounts cannot own the same OpenAI registration");
      openaiRegistrations.add(account.pi.clientId);
    }
    if (account.codex) {
      if (account.provider !== "openai")
        throw new Error("Codex controls are attached to the wrong provider");
      const profile = account.codex.profileId ?? account.id;
      if (codexProfiles.has(profile))
        throw new Error("Two saved accounts cannot own the same Codex credentials");
      codexProfiles.add(profile);
    }
  }
  const resets = new Set<string>();
  for (const entry of state.resets) {
    if (entry.operation.kind !== "reset" || resets.has(entry.operation.id))
      throw new Error("Account reset receipts are inconsistent");
    resets.add(entry.operation.id);
  }
}

export async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const stat = await lstat(path);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (stat.mode & 0o077) !== 0 ||
    (process.getuid && stat.uid !== process.getuid())
  )
    throw new Error("Account directory must be owned by this user and private (0700)");
}
