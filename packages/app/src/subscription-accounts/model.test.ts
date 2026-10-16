import { afterEach, expect, test } from "vitest";
import type { AccountAction, AccountsSnapshot } from "@getpaseo/protocol/subscription-accounts";
import { AccountsModel, type AccountsClient } from "./model";

const models: AccountsModel[] = [];
afterEach(() => {
  for (const instance of models.splice(0)) instance.close();
});
const empty = (): AccountsSnapshot => ({ accounts: [], operations: [], native: [] });
function model() {
  const value = new AccountsModel();
  models.push(value);
  return value;
}

class Host implements AccountsClient {
  readonly actions: AccountAction[] = [];
  reads = 0;
  snapshot = empty();
  async readSubscriptionAccounts(): Promise<AccountsSnapshot> {
    this.reads += 1;
    return this.snapshot;
  }
  async subscriptionAccountAction(action: AccountAction): Promise<string | null> {
    this.actions.push(action);
    return null;
  }
}

test("account form is explicit, validates its label and sends only the selected provider", async () => {
  const client = new Host(),
    page = model();
  page.connect(client);
  await page.refresh();
  page.add("anthropic");
  await page.submitLogin();
  expect(client.actions).toEqual([]);
  expect(page.getState().error).toBe("Enter an account label");
  page.setLabel("  Personal  ");
  await page.submitLogin();
  expect(client.actions).toEqual([
    { kind: "login", provider: "anthropic", grant: "pi", label: "Personal" },
  ]);
  expect(page.getState().form).toBeNull();
});

test("an old host's late response cannot replace the reconnected host's state", async () => {
  let resolveOld: (snapshot: AccountsSnapshot) => void = () => {
    throw new Error("Not initialized");
  };
  const pending = new Promise<AccountsSnapshot>((resolve) => {
    resolveOld = resolve;
  });
  const old: AccountsClient = {
    readSubscriptionAccounts: () => pending,
    subscriptionAccountAction: async () => null,
  };
  const current = new Host();
  current.snapshot = { ...empty(), native: [{ provider: "openai", external: true, error: null }] };
  const page = model();
  page.connect(old);
  page.connect(current);
  await page.refresh();
  resolveOld({ ...empty(), native: [{ provider: "anthropic", external: true, error: null }] });
  await pending;
  expect(page.getState().snapshot?.native).toEqual([
    { provider: "openai", external: true, error: null },
  ]);
});

test("offline actions do not run, and reconnect keeps the form without persisting login answers", async () => {
  const client = new Host(),
    page = model();
  page.connect(client);
  await page.refresh();
  page.add("openai");
  page.setLabel("Work");
  page.connect(null);
  expect(await page.answer("00000000-0000-4000-8000-000000000001", "secret-code")).toBe(false);
  expect(client.actions).toEqual([]);
  expect(JSON.stringify(page.getState())).not.toContain("secret-code");
  page.connect(client);
  await page.refresh();
  expect(page.getState().form).toEqual({ provider: "openai", label: "Work" });
});

test("reconciling a reset uses the original operation ID rather than generating another spend", async () => {
  const client = new Host(),
    page = model();
  page.connect(client);
  await page.refresh();
  const accountId = "00000000-0000-4000-8000-000000000001";
  const operationId = "00000000-0000-4000-8000-000000000002";
  await page.reset(accountId, operationId);
  await page.reset(accountId, operationId);
  expect(client.actions).toEqual([
    { kind: "reset", accountId, operationId, confirm: true },
    { kind: "reset", accountId, operationId, confirm: true },
  ]);
});
