import { useCallback, useMemo, useState } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type {
  AccountOperation,
  AccountUsage,
  SubscriptionAccount,
  SubscriptionProvider,
} from "@getpaseo/protocol/subscription-accounts";
import type { ProviderUsage } from "@getpaseo/protocol/messages";
import { useIsCompactFormFactor } from "@/constants/layout";
import { SettingsSection } from "@/components/settings/headings/settings-section";
import { Button } from "@/components/ui/button";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { ProviderUsageCard } from "@/provider-usage/card";
import { confirmDialog } from "@/utils/confirm-dialog";
import { openExternalUrl } from "@/utils/open-external-url";
import { AccountsModel, type AccountsView } from "./model";

/** No chat controls are mounted elsewhere: this screen lives only inside host Settings. */
export function AccountsScreen({ model, state }: { model: AccountsModel; state: AccountsView }) {
  const refresh = useCallback(() => {
    void model.refresh(true);
  }, [model]);
  return (
    <View style={styles.stack} testID="subscription-accounts">
      <View style={styles.heading}>
        <Text style={styles.title}>Accounts & usage</Text>
        <Button
          size="sm"
          variant="outline"
          onPress={refresh}
          disabled={state.busy || state.status === "unavailable"}
        >
          Refresh
        </Button>
      </View>
      <Text style={styles.muted}>
        Accounts apply to Pi on this Mac, including terminal Pi. Standalone Claude and Codex tool
        logins stay separate.
      </Text>
      {state.error ? (
        <Text style={styles.error} accessibilityRole="alert">
          {state.error}
        </Text>
      ) : null}
      {state.status === "loading" ? <Text style={styles.muted}>Loading accounts…</Text> : null}
      {state.status === "ready" || state.status === "loading" ? (
        <>
          <AccountGroup provider="anthropic" model={model} state={state} />
          <AccountGroup provider="openai" model={model} state={state} />
        </>
      ) : null}
      {state.form ? <AddAccountForm key={state.form.provider} model={model} state={state} /> : null}
      {state.snapshot?.operations.map((operation) => (
        <OperationCard key={operation.id} model={model} operation={operation} busy={state.busy} />
      ))}
    </View>
  );
}

function AccountGroup({
  provider,
  model,
  state,
}: {
  provider: SubscriptionProvider;
  model: AccountsModel;
  state: AccountsView;
}) {
  const add = useCallback(() => model.add(provider), [model, provider]);
  const native = state.snapshot?.native.find((login) => login.provider === provider);
  const saveCurrent = useCallback(() => {
    void confirmDialog({
      title: "Save the existing Pi login?",
      message:
        "This preserves your current Mac Pi login so you can switch back to it. It stays active and its credentials stay on the Mac.",
      confirmLabel: "Save current login",
    })
      .then((confirmed) => (confirmed ? model.saveCurrent(provider) : false))
      .catch(model.reportError);
  }, [model, provider]);
  const trailing = useMemo(
    () => (
      <Button size="sm" variant="outline" onPress={add} disabled={state.busy}>
        Add account
      </Button>
    ),
    [add, state.busy],
  );
  const accounts =
    state.snapshot?.accounts.filter((account) => account.provider === provider) ?? [];
  return (
    <SettingsSection
      title={provider === "anthropic" ? "Claude subscriptions" : "OpenAI / ChatGPT subscriptions"}
      trailing={trailing}
    >
      {native?.error ? (
        <Text style={styles.error} accessibilityRole="alert">
          {native.error}
        </Text>
      ) : null}
      {native?.external ? (
        <View style={styles.stack}>
          <Text style={styles.muted}>
            An existing Pi login is active. Save it before switching to another account.
          </Text>
          <Button size="sm" variant="outline" onPress={saveCurrent} disabled={state.busy}>
            Save current Pi login
          </Button>
        </View>
      ) : null}
      {accounts.length ? (
        accounts.map((account) => (
          <AccountCard key={account.id} model={model} account={account} busy={state.busy} />
        ))
      ) : (
        <Text style={styles.muted}>
          {state.status === "loading" ? "Loading…" : "No saved accounts yet."}
        </Text>
      )}
    </SettingsSection>
  );
}

function AddAccountForm({ model, state }: { model: AccountsModel; state: AccountsView }) {
  const compact = useIsCompactFormFactor();
  const submit = useCallback(() => {
    void model.submitLogin();
  }, [model]);
  return (
    <View style={styles.card} testID="account-add-form">
      <Field label="Account label">
        <FormTextInput
          initialValue={state.form?.label ?? ""}
          onChangeText={model.setLabel}
          size={compact ? "md" : "sm"}
          placeholder="Personal or work"
          accessibilityLabel="Account label"
          autoCapitalize="none"
          autoCorrect={false}
          maxLength={64}
        />
      </Field>
      <View style={styles.actions}>
        <Button size="sm" onPress={submit} disabled={state.busy || !state.form?.label.trim()}>
          {state.form?.provider === "openai" ? "Continue with ChatGPT" : "Continue with Claude"}
        </Button>
        <Button size="sm" variant="ghost" onPress={model.cancelAdd}>
          Cancel
        </Button>
      </View>
    </View>
  );
}

function AccountCard({
  model,
  account,
  busy,
}: {
  model: AccountsModel;
  account: SubscriptionAccount;
  busy: boolean;
}) {
  let status = account.grants.length ? "Saved" : "Signed out";
  if (account.active) status = "Active";
  const pi = account.grants.find((grant) => grant.kind === "pi");
  const codex = account.grants.find((grant) => grant.kind === "codex");
  const activate = useCallback(() => {
    void model.use(account.id);
  }, [account.id, model]);
  const reconnect = useCallback(() => {
    void model.reconnect(account, "pi");
  }, [account, model]);
  const connectControls = useCallback(() => {
    void model.reconnect(account, "codex");
  }, [account, model]);
  const logout = useCallback(() => {
    void confirmDialog({
      title: `Sign out of ${account.label}?`,
      message:
        "This signs out this account's saved connections. If active, it also signs out the shared Pi login on this Mac, including terminal Pi. Other saved accounts and standalone Claude/Codex logins are unchanged.",
      confirmLabel: "Sign out",
      destructive: true,
    })
      .then((confirmed) => {
        if (confirmed) return model.logout(account.id);
        return false;
      })
      .catch(model.reportError);
  }, [account.id, account.label, model]);
  return (
    <View style={styles.card} testID={`subscription-account-${account.id}`}>
      <View style={styles.heading}>
        <Text style={styles.title}>{account.label}</Text>
        <Text style={account.active ? styles.active : styles.muted}>{status}</Text>
      </View>
      {account.grants.map((grant) => (
        <Text key={grant.kind} style={styles.muted} numberOfLines={2}>
          {grant.kind === "pi" ? "Pi" : "Codex controls"}:{" "}
          {grant.identity?.email ?? "Imported Pi login (profile details unavailable)"}
          {grant.identity?.plan ? ` · ${grant.identity.plan}` : ""}
          {grant.status === "reconnect" ? " · Reconnect required" : ""}
        </Text>
      ))}
      <View style={styles.actions}>
        <Button
          size="sm"
          onPress={activate}
          disabled={busy || account.active || pi?.status !== "connected"}
        >
          Use account
        </Button>
        <Button
          size="sm"
          variant="outline"
          onPress={reconnect}
          disabled={busy || pi?.identity === null}
        >
          {pi ? "Reconnect Pi" : "Connect Pi"}
        </Button>
        {account.provider === "openai" ? (
          <Button
            size="sm"
            variant="outline"
            onPress={connectControls}
            disabled={busy || pi?.identity === null}
          >
            {codex ? "Reconnect Codex controls" : "Connect usage & resets"}
          </Button>
        ) : null}
        {account.grants.length ? (
          <Button size="sm" variant="ghost" onPress={logout} disabled={busy}>
            Sign out
          </Button>
        ) : null}
      </View>
      {pi?.identity === null ? (
        <Text style={styles.muted}>
          To reconnect an imported login without verified profile details, add a new account. The
          imported login remains saved until you sign it out.
        </Text>
      ) : null}
      {account.usage.map((usage) => (
        <UsageCard key={usage.source} usage={usage} model={model} />
      ))}
      <BankedReset account={account} model={model} busy={busy} />
    </View>
  );
}

function BankedReset({
  account,
  model,
  busy,
}: {
  account: SubscriptionAccount;
  model: AccountsModel;
  busy: boolean;
}) {
  const usage = account.usage.find((item) => item.source === "codex");
  const identity = account.grants.find((grant) => grant.kind === "codex")?.identity;
  const reset = useCallback(() => {
    void confirmDialog({
      title: "Use one banked Codex reset?",
      message: `${account.label} · ${identity?.email ?? "Codex account"} · ${identity?.workspace ?? "workspace"}\n\nThis spends one earned reset. It does not change accounts or purchase credits. Pi's ChatGPT-sharing allowance is a separate scope.`,
      confirmLabel: "Use one reset",
    })
      .then((confirmed) =>
        confirmed ? model.reset(account.id, globalThis.crypto.randomUUID()) : false,
      )
      .catch(model.reportError);
  }, [account.id, account.label, identity, model]);
  if (!usage?.resets) return null;
  return (
    <View style={styles.stack}>
      <View style={styles.actions}>
        <Text style={styles.muted}>
          Banked resets: {usage.resets.available}
          {usage.error ? " (last reported)" : ""}
        </Text>
        <Button
          size="sm"
          variant="outline"
          onPress={reset}
          disabled={busy || usage.resets.available < 1 || Boolean(usage.error)}
        >
          Use one reset
        </Button>
      </View>
      {usage.resets.credits?.map((credit) => (
        <Text key={credit.id} style={styles.muted}>
          {credit.title ?? "Reset credit"}
          {credit.expiresAt ? ` · expires ${new Date(credit.expiresAt).toLocaleString()}` : ""}
        </Text>
      ))}
    </View>
  );
}

function UsageCard({ usage, model }: { usage: AccountUsage; model: AccountsModel }) {
  const open = useCallback(() => {
    if (usage.manageUrl) void openExternalUrl(usage.manageUrl).catch(model.reportError);
  }, [usage.manageUrl, model]);
  const normalized = useMemo<ProviderUsage>(
    () => ({
      providerId: usage.source === "claude" ? "claude" : "codex",
      displayName: usage.source === "claude" ? "Claude allowance" : "Codex allowance",
      status: usage.error ? "error" : "available",
      planLabel: null,
      fetchedAt: usage.fetchedAt,
      sourceLabel: usage.source === "codex" ? "Codex controls" : "Saved Claude account",
      error: usage.error,
      windows: usage.windows.map((window) => ({
        id: window.id,
        label: window.label,
        usedPct: window.usedPercent,
        resetsAt: window.resetsAt,
      })),
    }),
    [usage],
  );
  return (
    <View style={styles.stack}>
      {usage.source === "chatgpt-sharing" ? (
        <Text style={styles.muted}>
          {usage.error ?? "Pi uses ChatGPT plan sharing. Its allowance is separate from Codex."}
        </Text>
      ) : (
        <ProviderUsageCard usage={normalized} />
      )}
      {usage.manageUrl ? (
        <Button size="sm" variant="ghost" onPress={open}>
          Open provider usage
        </Button>
      ) : null}
    </View>
  );
}

function OperationCard({
  model,
  operation,
  busy,
}: {
  model: AccountsModel;
  operation: AccountOperation;
  busy: boolean;
}) {
  const [answer, setAnswer] = useState("");
  const compact = useIsCompactFormFactor();
  const open = useCallback(() => {
    if (operation.challenge?.url)
      void openExternalUrl(operation.challenge.url).catch(model.reportError);
  }, [operation.challenge?.url, model]);
  const submit = useCallback(() => {
    void model.answer(operation.id, answer).then((accepted) => {
      if (accepted) setAnswer("");
      return undefined;
    });
  }, [answer, model, operation.id]);
  const cancel = useCallback(() => {
    void model.cancel(operation.id);
  }, [model, operation.id]);
  const retry = useCallback(() => {
    void model.reset(operation.accountId, operation.id);
  }, [model, operation.accountId, operation.id]);
  return (
    <View style={styles.card} testID={`account-operation-${operation.id}`}>
      <Text style={styles.title}>
        {OPERATION_TITLES[operation.kind]} · {operation.state}
      </Text>
      {operation.message ? <Text style={styles.muted}>{operation.message}</Text> : null}
      {operation.challenge?.url ? (
        <Button size="sm" onPress={open}>
          Open sign-in page
        </Button>
      ) : null}
      {operation.challenge?.userCode ? (
        <Text selectable style={styles.title}>
          {operation.challenge.userCode}
        </Text>
      ) : null}
      {operation.state === "input" && operation.challenge?.prompt ? (
        <Field label={operation.challenge.prompt}>
          <FormTextInput
            key={operation.challenge.prompt}
            size={compact ? "md" : "sm"}
            onChangeText={setAnswer}
            initialValue=""
            autoCapitalize="none"
            autoCorrect={false}
            accessibilityLabel="Authorization reply"
            secureTextEntry
          />
          <Button size="sm" onPress={submit} disabled={busy || !answer.trim()}>
            Continue
          </Button>
        </Field>
      ) : null}
      {["pending", "input"].includes(operation.state) &&
      ["login", "activate"].includes(operation.kind) ? (
        <Button size="sm" variant="ghost" onPress={cancel} disabled={busy}>
          Cancel
        </Button>
      ) : null}
      {operation.kind === "reset" && operation.state === "unknown" ? (
        <Button size="sm" variant="outline" onPress={retry} disabled={busy}>
          Reconcile this reset attempt
        </Button>
      ) : null}
    </View>
  );
}

const OPERATION_TITLES: Record<AccountOperation["kind"], string> = {
  login: "Sign in",
  activate: "Account switch",
  logout: "Sign out",
  reset: "Banked reset",
};

const styles = StyleSheet.create((theme) => ({
  stack: { gap: theme.spacing[3] },
  card: {
    padding: theme.spacing[4],
    gap: theme.spacing[3],
    backgroundColor: theme.colors.surface0,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
  },
  heading: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
    flexWrap: "wrap",
  },
  actions: { flexDirection: "row", alignItems: "center", gap: theme.spacing[2], flexWrap: "wrap" },
  title: {
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
  },
  muted: { fontSize: theme.fontSize.sm, color: theme.colors.foregroundMuted },
  active: { fontSize: theme.fontSize.sm, color: theme.colors.foreground },
  error: { fontSize: theme.fontSize.sm, color: theme.colors.foreground },
}));
