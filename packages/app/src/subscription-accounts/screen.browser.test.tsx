import "@/styles/unistyles";
import React, { act, useSyncExternalStore } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { page } from "vitest/browser";
import type {
  AccountAction,
  AccountsSnapshot,
  SubscriptionAccount,
} from "@getpaseo/protocol/subscription-accounts";
import { AccountsModel, type AccountsClient } from "./model";
import { AccountsScreen } from "./screen";

const A = "00000000-0000-4000-8000-000000000001";
const B = "00000000-0000-4000-8000-000000000002";
const OP = "00000000-0000-4000-8000-000000000003";
function account(id: string, label: string, active: boolean): SubscriptionAccount {
  return {
    id,
    label,
    active,
    provider: "openai",
    grants: [
      {
        kind: "pi",
        status: "connected",
        identity: { subject: id, email: `${label}@example.com`, workspace: null, plan: "Pro" },
      },
      {
        kind: "codex",
        status: "connected",
        identity: {
          subject: id,
          email: `${label}@example.com`,
          workspace: `workspace-${label}`,
          plan: "Pro",
        },
      },
    ],
    usage: [
      {
        source: "codex",
        fetchedAt: "2026-10-16T12:00:00.000Z",
        error: null,
        manageUrl: null,
        windows: [{ id: "weekly", label: "Weekly", usedPercent: 42, resetsAt: null }],
        resets: { available: 2, credits: null },
      },
    ],
  };
}
class Host implements AccountsClient {
  actions: AccountAction[] = [];
  snapshot: AccountsSnapshot = {
    accounts: [account(A, "Personal", true), account(B, "Work", false)],
    operations: [],
    native: [
      { provider: "anthropic", external: false, error: null },
      { provider: "openai", external: false, error: null },
    ],
  };
  async readSubscriptionAccounts() {
    return this.snapshot;
  }
  async subscriptionAccountAction(action: AccountAction) {
    this.actions.push(action);
    if (action.kind === "activate")
      this.snapshot = {
        ...this.snapshot,
        accounts: this.snapshot.accounts.map((entry) => ({
          ...entry,
          active: entry.id === action.accountId,
        })),
      };
    if (action.kind === "answer")
      this.snapshot = {
        ...this.snapshot,
        operations: this.snapshot.operations.map((operation) => ({
          ...operation,
          state: "pending",
          challenge: null,
        })),
      };
    return null;
  }
}
function Screen({ model }: { model: AccountsModel }) {
  const state = useSyncExternalStore(model.subscribe, model.getState, model.getState);
  return <AccountsScreen model={model} state={state} />;
}
let container: HTMLDivElement;
let root: Root;
let model: AccountsModel;
let host: Host;
beforeEach(async () => {
  await page.viewport(800, 900);
  container = document.createElement("div");
  container.style.width = "100%";
  document.body.appendChild(container);
  root = createRoot(container);
  model = new AccountsModel();
  host = new Host();
  await act(async () => {
    model.connect(host);
    await model.refresh();
    root.render(<Screen model={model} />);
  });
});
afterEach(() => {
  act(() => root.unmount());
  model.close();
  container.remove();
  vi.restoreAllMocks();
});

test("saved and active accounts are separate; Set active sends only the chosen account", async () => {
  await expect
    .element(page.getByTestId(`subscription-account-${A}`).getByText("Active", { exact: true }))
    .toBeVisible();
  await expect
    .element(page.getByTestId(`subscription-account-${B}`).getByText("Saved", { exact: true }))
    .toBeVisible();
  await page
    .getByTestId(`subscription-account-${B}`)
    .getByRole("button", { name: "Use account", exact: true })
    .click();
  expect(host.actions).toEqual([{ kind: "activate", accountId: B }]);
  await expect
    .element(page.getByTestId(`subscription-account-${B}`).getByText("Active", { exact: true }))
    .toBeVisible();
  await expect.element(page.getByText(/including terminal Pi/).first()).toBeVisible();
});

test("the add form logs into the selected provider and never sends an empty label", async () => {
  await page.getByRole("button", { name: "Add account", exact: true }).first().click();
  await expect.element(page.getByRole("button", { name: "Continue with Claude" })).toBeDisabled();
  await page.getByRole("textbox", { name: "Account label" }).fill("Personal Claude");
  await page.getByRole("button", { name: "Continue with Claude" }).click();
  expect(host.actions).toEqual([
    { kind: "login", provider: "anthropic", label: "Personal Claude", grant: "pi" },
  ]);
});

test("banked reset needs confirmation naming the account and workspace", async () => {
  const confirmation = vi.spyOn(window, "confirm").mockReturnValue(false);
  const reset = page
    .getByTestId(`subscription-account-${B}`)
    .getByRole("button", { name: "Use one reset", exact: true });
  await reset.click();
  expect(host.actions).toEqual([]);
  expect(confirmation.mock.calls[0]?.[0]).toContain("Work");
  expect(confirmation.mock.calls[0]?.[0]).toContain("workspace-Work");
  confirmation.mockReturnValue(true);
  await reset.click();
  expect(host.actions).toHaveLength(1);
  expect(host.actions[0]).toMatchObject({ kind: "reset", accountId: B, confirm: true });
});

test("sign-out confirmation makes shared Pi scope explicit and cancellation does nothing", async () => {
  const confirmation = vi.spyOn(window, "confirm").mockReturnValue(false);
  await page
    .getByTestId(`subscription-account-${A}`)
    .getByRole("button", { name: "Sign out", exact: true })
    .click();
  expect(confirmation.mock.calls[0]?.[0]).toContain("including terminal Pi");
  expect(host.actions).toEqual([]);
});

test("authorization answers use the dedicated form and disappear when the challenge completes", async () => {
  host.snapshot = {
    ...host.snapshot,
    operations: [
      {
        id: OP,
        accountId: A,
        kind: "login",
        state: "input",
        expiresAt: null,
        challenge: { url: null, userCode: null, prompt: "Paste the authorization reply" },
        message: null,
      },
    ],
  };
  await act(async () => {
    await model.refresh();
  });
  // Password inputs have no implicit textbox role.
  await page.getByLabelText("Authorization reply").fill("fixture-one-time-code");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  expect(host.actions).toEqual([
    { kind: "answer", operationId: OP, answer: "fixture-one-time-code" },
  ]);
  await expect.element(page.getByLabelText("Authorization reply")).not.toBeInTheDocument();
  expect(JSON.stringify(model.getState())).not.toContain("fixture-one-time-code");
});

test("uncertain resets reconcile the existing operation and the page fits a phone width", async () => {
  await page.viewport(360, 800);
  host.snapshot = {
    ...host.snapshot,
    operations: [
      {
        id: OP,
        accountId: B,
        kind: "reset",
        state: "unknown",
        challenge: null,
        expiresAt: null,
        message: "Response lost. Reconcile this attempt.",
      },
    ],
  };
  await act(async () => {
    await model.refresh();
  });
  await page.getByRole("button", { name: "Reconcile this reset attempt" }).click();
  expect(host.actions).toEqual([{ kind: "reset", accountId: B, operationId: OP, confirm: true }]);
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(360);
});
