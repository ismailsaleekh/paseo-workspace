import type {
  AccountAction,
  AccountsSnapshot,
  SubscriptionAccount,
  SubscriptionProvider,
} from "@getpaseo/protocol/subscription-accounts";

export interface AccountsClient {
  readSubscriptionAccounts(refresh?: boolean): Promise<AccountsSnapshot>;
  subscriptionAccountAction(action: AccountAction): Promise<string | null>;
}
export interface AccountsView {
  status: "loading" | "ready" | "unavailable" | "error";
  snapshot: AccountsSnapshot | null;
  error: string | null;
  busy: boolean;
  form: { provider: SubscriptionProvider; label: string } | null;
}

/** Screen lifetime and form state. No credentials or authorization codes are persisted. */
export class AccountsModel {
  private client: AccountsClient | null = null;
  private state: AccountsView = {
    status: "loading",
    snapshot: null,
    error: null,
    busy: false,
    form: null,
  };
  private listeners = new Set<() => void>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private generation = 0;
  private reading: Promise<void> | null = null;

  getState = (): AccountsView => this.state;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  connect(client: AccountsClient | null, unavailable?: string): void {
    this.generation += 1;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.client = client;
    this.reading = null;
    if (!client)
      this.publish({
        status: "unavailable",
        error: unavailable ?? "Connect to the Mac to manage accounts",
        busy: false,
      });
    else {
      this.publish({ status: this.state.snapshot ? "ready" : "loading", error: null });
      void this.refresh();
    }
  }

  close(): void {
    this.connect(null);
    this.listeners.clear();
  }
  add = (provider: SubscriptionProvider): void =>
    this.publish({ form: { provider, label: "" }, error: null });
  cancelAdd = (): void => this.publish({ form: null });
  setLabel = (label: string): void => {
    if (this.state.form) this.publish({ form: { ...this.state.form, label } });
  };
  reportError = (error: unknown): void =>
    this.publish({ error: error instanceof Error ? error.message : "Account action failed" });

  submitLogin = async (): Promise<void> => {
    const form = this.state.form;
    if (!form?.label.trim()) {
      this.reportError(new Error("Enter an account label"));
      return;
    }
    if (
      await this.perform({
        kind: "login",
        provider: form.provider,
        grant: "pi",
        label: form.label.trim(),
      })
    )
      this.publish({ form: null });
  };
  reconnect = (account: SubscriptionAccount, grant: "pi" | "codex"): Promise<boolean> =>
    this.perform({
      kind: "login",
      accountId: account.id,
      provider: account.provider,
      label: account.label,
      grant,
    });
  saveCurrent = (provider: SubscriptionProvider): Promise<boolean> =>
    this.perform({ kind: "save_current", provider, confirm: true });
  use = (accountId: string): Promise<boolean> => this.perform({ kind: "activate", accountId });
  logout = (accountId: string): Promise<boolean> =>
    this.perform({ kind: "logout", accountId, confirm: true });
  cancel = (operationId: string): Promise<boolean> => this.perform({ kind: "cancel", operationId });
  answer = (operationId: string, answer: string): Promise<boolean> =>
    this.perform({ kind: "answer", operationId, answer });
  reset = (accountId: string, operationId: string, creditId?: string): Promise<boolean> =>
    this.perform({
      kind: "reset",
      accountId,
      operationId,
      confirm: true,
      ...(creditId ? { creditId } : {}),
    });

  refresh = (force = false): Promise<void> => {
    if (this.reading) return this.reading;
    const client = this.client;
    if (!client) return Promise.resolve();
    const generation = this.generation;
    const read = client
      .readSubscriptionAccounts(force)
      .then(
        (snapshot) => {
          if (generation === this.generation)
            this.publish({ status: "ready", snapshot, error: null });
          return undefined;
        },
        (error: unknown) => {
          if (generation === this.generation) {
            this.reportError(error);
            this.publish({ status: this.state.snapshot ? "ready" : "error" });
          }
        },
      )
      .finally(() => {
        if (generation !== this.generation) return;
        this.reading = null;
        if (this.timer) clearTimeout(this.timer);
        const pending = this.state.snapshot?.operations.some((operation) =>
          ["pending", "input"].includes(operation.state),
        );
        this.timer = setTimeout(
          () => {
            this.timer = null;
            void this.refresh();
          },
          pending ? 1500 : 5_000,
        );
      });
    this.reading = read;
    return read;
  };

  private async perform(action: AccountAction): Promise<boolean> {
    const client = this.client;
    if (!client) {
      this.reportError(new Error("Connect to the Mac to manage accounts"));
      return false;
    }
    if (this.state.busy) return false;
    const generation = this.generation;
    this.publish({ busy: true, error: null });
    try {
      await client.subscriptionAccountAction(action);
      if (this.reading) await this.reading;
      if (generation !== this.generation) return false;
      await this.refresh();
      return true;
    } catch (error) {
      if (generation === this.generation) this.reportError(error);
      return false;
    } finally {
      if (generation === this.generation) this.publish({ busy: false });
    }
  }

  private publish(change: Partial<AccountsView>): void {
    this.state = { ...this.state, ...change };
    for (const listener of this.listeners) listener();
  }
}
