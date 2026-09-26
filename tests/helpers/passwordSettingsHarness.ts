import assert from "node:assert/strict";
import { mock } from "bun:test";
import { Window } from "happy-dom";
import { billingDashboard, billingUser } from "./billingFixture";

const scenario = process.argv[2];
const browser = new Window({
  url: `http://password-settings.test/${scenario === "reset-confirm" ? "?reset_token=emailed-token" : ""}`,
});
for (const name of ["window", "document", "navigator", "localStorage", "HTMLElement", "HTMLInputElement", "Element", "Node", "Text", "Document", "DocumentFragment", "MutationObserver", "Event", "MouseEvent", "KeyboardEvent"]) {
  const value = name === "window" ? browser : (browser as any)[name];
  if (value !== undefined) Object.defineProperty(globalThis, name, { configurable: true, value });
}
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const container = browser.document.createElement("div");
browser.document.body.append(container);
const root = createRoot(container as unknown as Element);

function input(label: string) {
  const element = [...container.querySelectorAll("label")]
    .find((item) => item.querySelector("span")?.textContent?.trim() === label)?.querySelector("input");
  assert(element, `Input ${label} should exist`);
  return element;
}

function button(text: string) {
  const element = [...container.querySelectorAll("button")].find((item) => item.textContent?.trim() === text);
  assert(element, `Button ${text} should exist`);
  return element;
}

async function enter(label: string, value: string) {
  await act(async () => {
    const element = input(label);
    Object.getOwnPropertyDescriptor(browser.HTMLInputElement.prototype, "value")!.set!.call(element, value);
    element.dispatchEvent(new browser.Event("input", { bubbles: true }));
  });
}

async function submit(label: string) {
  await act(async () => {
    const form = input(label).closest("form");
    assert(form, `Input ${label} should belong to a form`);
    form.dispatchEvent(new browser.Event("submit", { bubbles: true, cancelable: true }));
  });
}

async function click(text: string) {
  await act(async () => { button(text).click(); });
}

async function flushUntil(predicate: () => boolean) {
  for (let count = 0; count < 30 && !predicate(); count += 1) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
  }
  assert(predicate(), `Scenario ${scenario} did not finish. ${container.textContent}`);
}

try {
  if (scenario === "profile") {
    const { default: ProfileModal } = await import("../../client/src/components/ProfileModal");
    const changes: Array<{ currentPassword: string; password: string }> = [];
    let closes = 0;
    let logouts = 0;
    let profileSaves = 0;
    let settle!: () => void;
    let fail!: (error: Error) => void;
    const profileProps = {
      user: billingUser, billingDashboard: null, billingDashboardLoading: false, billingDashboardError: null,
      onRefreshBilling() {}, onAddMoney() {}, onManageBilling() {}, onStartSubscription() {},
      billingErrorMessage: null, billingSubmitting: false,
      cloudSyncEnabled: false, cloudSyncStatus: "local" as const, cloudBackupMatchesLocal: false, cloudBackupSizeBytes: 0,
      errorMessage: null, isOpen: true, isSaving: false,
      localDirectoryStatus: { supported: false, directoryName: null, connected: false, permission: "prompt" },
      vault: {} as any, onBackupToCloud: async () => {}, onChooseLocalDirectory: async () => {}, onClearLocalDirectory: async () => {},
      onClose() { closes += 1; }, onLogout() { logouts += 1; }, onSaveApiKeys: async () => billingUser.apiKeys,
      onSave() { profileSaves += 1; },
      onChangePassword(args: { currentPassword: string; password: string }) {
        changes.push(args);
        return new Promise<void>((resolve, reject) => { settle = resolve; fail = reject; });
      },
    };
    await act(async () => { root.render(createElement(ProfileModal, profileProps as any)); });
    assert.equal(container.querySelector("#profile-tab-account")?.getAttribute("aria-selected"), "true");
    assert.equal(input("Current password").getAttribute("autocomplete"), "current-password");
    assert.equal(input("New password").getAttribute("autocomplete"), "new-password");
    assert.equal(input("Confirm new password").type, "password");

    await enter("Current password", " current password ");
    await enter("New password", "new-password");
    await enter("Confirm new password", "different-password");
    await submit("Current password");
    assert.equal(changes.length, 0, "Mismatched passwords must not reach the server");
    assert(container.querySelector('[role="alert"]')?.textContent?.includes("match"));

    for (const password of ["short", "x".repeat(201)]) {
      await enter("New password", password);
      await enter("Confirm new password", password);
      await submit("Current password");
      assert.equal(changes.length, 0, "Out-of-range passwords must not reach the server");
      assert(container.querySelector('[role="alert"]'));
    }

    await enter("New password", " new password ");
    await enter("Confirm new password", " new password ");
    await submit("Current password");
    assert.deepEqual(changes, [{ currentPassword: " current password ", password: " new password " }]);
    assert(input("Current password").disabled);
    assert(input("New password").disabled);
    assert(input("Confirm new password").disabled);
    assert(input("Current password").closest("form")?.querySelector('button[type="submit"]')?.disabled);
    for (const label of ["Log out", "Save changes", "Cancel", "Billing", "Open billing dashboard"]) {
      assert(button(label).disabled, `${label} must wait for the password change`);
      await click(label);
    }
    const closeButton = container.querySelector<HTMLButtonElement>('button[aria-label="Close profile"]')!;
    assert(closeButton.disabled);
    await act(async () => {
      closeButton.click();
      container.querySelector<HTMLElement>(".thread-dialog-backdrop")!.click();
      browser.document.dispatchEvent(new browser.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    await submit("Display name");
    assert.equal(closes, 1, "The profile backdrop dismisses even during a pending password change");
    assert.equal(logouts, 0, "Logout must wait for the password change session cookie");
    assert.equal(profileSaves, 0, "Profile edits must wait for the password change");
    assert.equal(container.querySelector("#profile-tab-account")?.getAttribute("aria-selected"), "true");
    await act(async () => { fail(new Error("Current password is incorrect.")); });
    assert(container.querySelector('[role="alert"]')?.textContent?.includes("Current password is incorrect."));
    assert.equal(container.querySelector('[role="status"]'), null);
    assert.equal(button("Change password").disabled, false);
    for (const label of ["Log out", "Cancel", "Billing", "Open billing dashboard"]) assert.equal(button(label).disabled, false);
    assert.equal(closeButton.disabled, false);

    await enter("Current password", "correct-current-password");
    await submit("Current password");
    await act(async () => { settle(); });
    assert.equal(changes.length, 2);
    assert(container.querySelector('[role="status"]')?.textContent?.toLowerCase().includes("password"));
    assert.equal(container.querySelector('[role="alert"]'), null);
    for (const label of ["Current password", "New password", "Confirm new password"]) assert.equal(input(label).value, "");

    await enter("Current password", "unsaved-current-password");
    await enter("New password", "unsaved-new-password");
    await enter("Confirm new password", "unsaved-new-password");
    await act(async () => { root.render(createElement(ProfileModal, { ...profileProps, isOpen: false } as any)); });
    assert.equal(container.querySelectorAll('input[type="password"]').length, 0);
    await act(async () => { root.render(createElement(ProfileModal, profileProps as any)); });
    for (const label of ["Current password", "New password", "Confirm new password"]) assert.equal(input(label).value, "");
    assert.equal(container.querySelector('[role="status"]'), null);
    await click("Billing");
    assert.equal(container.querySelector("#profile-tab-billing")?.getAttribute("aria-selected"), "true");
    await click("Account");
    await click("Log out");
    await click("Cancel");
    assert.equal(logouts, 1);
    assert.equal(closes, 2);

    await enter("Current password", "current-password");
    await enter("New password", "replacement-password");
    await enter("Confirm new password", "replacement-password");
    await act(async () => { root.render(createElement(ProfileModal, { ...profileProps, isSaving: true } as any)); });
    assert(button("Change password").disabled);
    await submit("Current password");
    assert.equal(changes.length, 2, "Saving a profile blocks a simultaneous password change");
  } else {
    const requests: Array<{ url: string; body: unknown }> = [];
    let sessionRequests = 0;
    let workspaceProps: any;
    mock.module("../../client/src/WorkspaceApp", () => ({
      default(props: any) { workspaceProps = props; return createElement("div", { "data-workspace": "true" }, "Workspace"); },
    }));
    const offlineIdentityKey = "margin-chat-offline-identity";
    if (scenario === "reset-confirm") browser.localStorage.setItem(offlineIdentityKey, JSON.stringify(billingUser));
    let settle!: (response: Response) => void;
    globalThis.fetch = (async (url, init) => {
      if (url === "/api/auth/session") {
        sessionRequests += 1;
        return Response.json({ user: scenario === "change-session" ? billingUser : null });
      }
      if (url === "/api/billing/dashboard") return Response.json(billingDashboard);
      requests.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return await new Promise<Response>((resolve) => { settle = resolve; });
    }) as typeof fetch;
    const { default: App } = await import("../../client/src/App");
    await act(async () => { root.render(createElement(App)); });

    if (scenario === "change-session") {
      await flushUntil(() => Boolean(workspaceProps));
      await act(async () => {
        const change = workspaceProps.onChangePassword({ currentPassword: "wrong-password", password: "replacement-password" });
        settle(Response.json({ error: "Current password is incorrect." }, { status: 400 }));
        await assert.rejects(change, /Current password is incorrect/);
      });
      assert(container.querySelector("[data-workspace]"), "An incorrect current password should keep the profile open");
      assert(browser.localStorage.getItem(offlineIdentityKey));
      await act(async () => {
        const change = workspaceProps.onChangePassword({ currentPassword: "old-password", password: "replacement-password" });
        settle(Response.json({ error: "Your session expired. Sign in again." }, { status: 401 }));
        await assert.rejects(change, /Your session expired/);
      });
      assert.equal(container.querySelector("[data-workspace]"), null);
      assert(container.querySelector('[role="alert"]')?.textContent?.includes("Your session expired"));
      assert.equal(browser.localStorage.getItem(offlineIdentityKey), null);
    } else if (scenario === "reset-request") {
      await flushUntil(() => Boolean(container.querySelector(".auth-mode-switch")));
      await click("Log in");
      await enter("Email", billingUser.email);
      await click("Forgot password?");
      assert.equal(input("Email").value, billingUser.email);
      await submit("Email");
      assert.deepEqual(requests, [{ url: "/api/auth/password-reset/request", body: { email: billingUser.email } }]);
      assert(input("Email").disabled);
      assert(container.querySelector('button[type="submit"]')?.disabled);
      assert.equal(container.querySelector('[role="status"]'), null);
      await act(async () => { settle(Response.json({ error: "Password reset email could not be sent. Please try again." }, { status: 503 })); });
      await flushUntil(() => Boolean(container.querySelector('[role="alert"]')));
      assert(container.querySelector('[role="alert"]')?.textContent?.includes("could not be sent"));
      assert.equal(container.querySelector('[role="status"]'), null, "Failed email delivery must not show the sent notice");
      assert.equal(button("Continue").disabled, false);

      await submit("Email");
      await act(async () => { settle(Response.json({ ok: true })); });
      await flushUntil(() => Boolean(container.querySelector('[role="status"]')));
      assert(container.querySelector('[role="status"]')?.textContent?.includes("If an account exists"));
      assert.equal(container.querySelector('[role="alert"]'), null);

      await submit("Email");
      assert.equal(container.querySelector('[role="status"]'), null, "A new request must clear a previous sent notice");
      await act(async () => { settle(Response.json({ error: "Email service unavailable." }, { status: 503 })); });
      assert.equal(container.querySelector('[role="status"]'), null);
      assert(container.querySelector('[role="alert"]')?.textContent?.includes("Email service unavailable."));
    } else if (scenario === "reset-confirm") {
      await flushUntil(() => Boolean(container.querySelector('input[autocomplete="new-password"]')));
      await enter("New password", "replacement-password");
      await enter("Confirm new password", "mismatched-password");
      await submit("New password");
      assert.equal(requests.length, 0);
      assert(container.querySelector('[role="alert"]')?.textContent?.includes("match"));
      await enter("Confirm new password", "replacement-password");
      await submit("New password");
      assert.deepEqual(requests, [{ url: "/api/auth/password-reset/confirm", body: { password: "replacement-password", token: "emailed-token" } }]);
      assert(input("New password").disabled);
      assert(input("Confirm new password").disabled);
      assert(container.querySelector('button[type="submit"]')?.disabled);
      await act(async () => { settle(Response.json({ error: "Reset link is invalid or expired." }, { status: 400 })); });
      assert(container.querySelector('[role="alert"]')?.textContent?.includes("invalid or expired"));
      assert.equal(container.querySelector('[role="status"]'), null);
      assert.equal(button("Update password").disabled, false);
      assert.equal(browser.location.search, "?reset_token=emailed-token");

      await submit("New password");
      await act(async () => { settle(Response.json({ ok: true })); });
      await flushUntil(() => Boolean(container.querySelector('input[autocomplete="current-password"]')));
      assert.equal(browser.location.search, "");
      assert(container.querySelector('[role="status"]')?.textContent?.includes("Password updated"));
      assert.equal(input("Password").value, "");
      assert.equal(container.querySelectorAll('input[autocomplete="new-password"]').length, 0);
      assert.equal(requests.length, 2);
      assert.equal(browser.localStorage.getItem(offlineIdentityKey), null, "Resetting the password clears the previous offline identity");
      assert.equal(sessionRequests, 0, "Removing the reset token must not restart session hydration");

      await enter("Email", billingUser.email);
      await enter("Password", "replacement-password");
      await submit("Email");
      assert.equal(sessionRequests, 0, "Beginning a new login must not race a stale session check");
      assert.deepEqual(requests.at(-1), { url: "/api/auth/login", body: { email: billingUser.email, password: "replacement-password" } });
      await act(async () => { settle(Response.json({ user: billingUser })); });
      await flushUntil(() => Boolean(container.querySelector("[data-workspace]")));
      assert.equal(sessionRequests, 0);
    } else {
      throw new Error(`Unknown scenario ${scenario}`);
    }
  }
  console.log(JSON.stringify({ scenario, result: "pass" }));
} finally {
  await act(async () => { root.unmount(); });
  await browser.happyDOM.close();
}
