import { z } from "zod";

export const SubscriptionProviderSchema = z.enum(["anthropic", "openai"]);
export type SubscriptionProvider = z.infer<typeof SubscriptionProviderSchema>;
export const AccountGrantSchema = z.enum(["pi", "codex"]);
export type AccountGrant = z.infer<typeof AccountGrantSchema>;

export const AccountIdentitySchema = z.object({
  subject: z.string(),
  email: z.string().nullable(),
  workspace: z.string().nullable(),
  plan: z.string().nullable(),
});
export type AccountIdentity = z.infer<typeof AccountIdentitySchema>;

export const AccountUsageSchema = z.object({
  source: z.enum(["claude", "codex", "chatgpt-sharing"]),
  fetchedAt: z.string().nullable(),
  error: z.string().nullable(),
  manageUrl: z.string().nullable(),
  windows: z.array(
    z.object({
      id: z.string(),
      label: z.string(),
      usedPercent: z.number().nullable(),
      resetsAt: z.string().nullable(),
    }),
  ),
  resets: z
    .object({
      available: z.number().int().nonnegative(),
      credits: z
        .array(
          z.object({
            id: z.string(),
            title: z.string().nullable(),
            expiresAt: z.string().nullable(),
          }),
        )
        .nullable(),
    })
    .nullable(),
});
export type AccountUsage = z.infer<typeof AccountUsageSchema>;

export const SubscriptionAccountSchema = z.object({
  id: z.string().uuid(),
  label: z.string(),
  provider: SubscriptionProviderSchema,
  active: z.boolean(),
  grants: z.array(
    z.object({
      kind: AccountGrantSchema,
      status: z.enum(["connected", "reconnect"]),
      identity: AccountIdentitySchema.nullable(),
    }),
  ),
  usage: z.array(AccountUsageSchema),
});
export type SubscriptionAccount = z.infer<typeof SubscriptionAccountSchema>;

export const AccountLoginChallengeSchema = z.object({
  url: z.string().nullable(),
  userCode: z.string().nullable(),
  prompt: z.string().nullable(),
});
export type AccountLoginChallenge = z.infer<typeof AccountLoginChallengeSchema>;
export const AccountOperationSchema = z.object({
  id: z.string().uuid(),
  kind: z.enum(["login", "activate", "logout", "reset"]),
  accountId: z.string().uuid(),
  state: z.enum(["pending", "input", "complete", "failed", "cancelled", "unknown"]),
  challenge: AccountLoginChallengeSchema.nullable(),
  message: z.string().nullable(),
  expiresAt: z.string().nullable(),
});
export type AccountOperation = z.infer<typeof AccountOperationSchema>;

export const AccountsSnapshotSchema = z.object({
  accounts: z.array(SubscriptionAccountSchema),
  operations: z.array(AccountOperationSchema),
  native: z.array(
    z.object({
      provider: SubscriptionProviderSchema,
      external: z.boolean(),
      error: z.string().nullable(),
    }),
  ),
});
export type AccountsSnapshot = z.infer<typeof AccountsSnapshotSchema>;

export const AccountsReadRequestSchema = z.object({
  type: z.literal("subscription.accounts.read.request"),
  requestId: z.string(),
  refresh: z.boolean().optional(),
});
export const AccountActionSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("save_current"),
    provider: SubscriptionProviderSchema,
    confirm: z.literal(true),
  }),
  z.object({
    kind: z.literal("login"),
    provider: SubscriptionProviderSchema,
    label: z.string().min(1).max(64),
    accountId: z.string().uuid().optional(),
    grant: AccountGrantSchema,
  }),
  z.object({
    kind: z.literal("answer"),
    operationId: z.string().uuid(),
    answer: z.string().min(1).max(8192),
  }),
  z.object({ kind: z.literal("cancel"), operationId: z.string().uuid() }),
  z.object({ kind: z.literal("activate"), accountId: z.string().uuid() }),
  z.object({ kind: z.literal("logout"), accountId: z.string().uuid(), confirm: z.literal(true) }),
  z.object({
    kind: z.literal("reset"),
    accountId: z.string().uuid(),
    operationId: z.string().uuid(),
    creditId: z.string().min(1).optional(),
    confirm: z.literal(true),
  }),
]);
export type AccountAction = z.infer<typeof AccountActionSchema>;
export const AccountsActionRequestSchema = z.object({
  type: z.literal("subscription.accounts.action.request"),
  requestId: z.string(),
  action: AccountActionSchema,
});
export const AccountsReadResponseSchema = z.object({
  type: z.literal("subscription.accounts.read.response"),
  payload: z.object({
    requestId: z.string(),
    snapshot: AccountsSnapshotSchema.nullable(),
    error: z.string().nullable(),
  }),
});
export const AccountsActionResponseSchema = z.object({
  type: z.literal("subscription.accounts.action.response"),
  payload: z.object({
    requestId: z.string(),
    operationId: z.string().uuid().nullable(),
    error: z.string().nullable(),
  }),
});
