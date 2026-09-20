import assert from "node:assert/strict";
import { Window } from "happy-dom";
import { billingDashboard, billingUser } from "./billingFixture";

const browser = new Window({ url: "http://billing.test" });
for (const name of ["window", "document", "navigator", "HTMLElement", "HTMLInputElement", "Element", "Node", "Text", "Document", "DocumentFragment", "MutationObserver", "Event", "MouseEvent", "KeyboardEvent"]) {
  const value = name === "window" ? browser : (browser as any)[name];
  if (value !== undefined) Object.defineProperty(globalThis, name, { configurable: true, value });
}
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { default: BillingDashboard } = await import("../../client/src/components/BillingDashboard");
const { default: ProfileModal } = await import("../../client/src/components/ProfileModal");
const container = browser.document.createElement("div");
browser.document.body.append(container);
const root = createRoot(container as unknown as Element);
const checks: string[] = [];
const intervals = new Map<number, () => void>();
let intervalId = 0;
browser.setInterval = ((callback: () => void, delay: number) => {
  assert.equal(delay, 30_000);
  intervals.set(++intervalId, callback);
  return intervalId;
}) as any;
browser.clearInterval = ((id: number) => intervals.delete(id)) as any;
let refreshes = 0;
let portals = 0;
let subscriptions = 0;
const topups: number[] = [];
const callbacks = {
  onRefresh() { refreshes += 1; },
  onAddMoney(cents: number) { topups.push(cents); },
  onManageBilling() { portals += 1; },
  onStartSubscription() { subscriptions += 1; },
};
const props = {
  ...callbacks, user: billingUser, data: billingDashboard, loading: false,
  errorMessage: null, checkoutErrorMessage: null, isSubmitting: false,
};
function button(text: string) {
  const element = [...container.querySelectorAll("button")].find((item) => item.textContent === text);
  assert(element, `Button ${text} should exist`);
  return element;
}
async function enterAmount(value: string) {
  await act(async () => {
    const input = container.querySelector("#billing-topup-amount")!;
    Object.getOwnPropertyDescriptor(browser.HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new browser.Event("input", { bubbles: true }));
  });
  await act(async () => { container.querySelector("form")!.dispatchEvent(new browser.Event("submit", { bubbles: true, cancelable: true })); });
}

try {
  await act(async () => { root.render(createElement(BillingDashboard, props)); });
  assert.equal(refreshes, 1);
  await act(async () => { browser.dispatchEvent(new browser.Event("focus")); });
  await act(async () => { button("Refresh balance").click(); });
  assert.equal(refreshes, 3);
  checks.push("open, focus and manual refresh");

  await enterAmount("20.001");
  assert.deepEqual(topups, []);
  assert(container.querySelector("#billing-topup-error")?.textContent?.includes("two decimal places"));
  await enterAmount("5.01");
  assert.deepEqual(topups, [501]);
  assert.equal(container.querySelector("#billing-topup-error"), null);
  checks.push("exact cents and inline validation");

  await act(async () => { button("Manage subscription").click(); button("Stripe billing & invoices").click(); });
  assert.equal(portals, 2);
  await act(async () => {
    root.render(createElement(BillingDashboard, { ...props, data: { ...billingDashboard, subscription: { ...billingDashboard.subscription, status: "canceled" } } }));
  });
  await act(async () => { button("Subscribe for $20.00/month").click(); });
  assert.equal(subscriptions, 1);
  checks.push("Stripe subscription and portal actions");

  assert.equal(intervals.size, 1);
  await act(async () => { for (const tick of intervals.values()) tick(); });
  assert.equal(refreshes, 4);
  Object.defineProperty(browser.document, "visibilityState", { configurable: true, value: "hidden" });
  await act(async () => { for (const tick of intervals.values()) tick(); });
  assert.equal(refreshes, 4);
  Object.defineProperty(browser.document, "visibilityState", { configurable: true, value: "visible" });
  checks.push("periodic refresh only while visible");

  await act(async () => {
    root.render(createElement(BillingDashboard, { ...props,
      data: { ...billingDashboard, transactions: [{ ...billingDashboard.transactions[2], receiptUrl: "javascript:alert(1)" }] },
      notice: { kind: "info", message: "Your payment is not confirmed yet." }, errorMessage: "Network unavailable.",
    }));
  });
  assert.equal(container.querySelectorAll("a").length, 0);
  assert(container.querySelector('[role="status"]')?.textContent?.includes("not confirmed yet"));
  assert(container.textContent?.includes("last successful refresh"));
  checks.push("safe receipt links and honest pending/error states");

  const profileProps = {
    ...callbacks, user: billingUser, billingDashboard, billingDashboardLoading: false, billingDashboardError: null, billingNotice: null,
    onRefreshBilling: callbacks.onRefresh, billingErrorMessage: null, billingSubmitting: false,
    cloudSyncEnabled: false, cloudSyncStatus: "local" as const, cloudBackupMatchesLocal: false, cloudBackupSizeBytes: 0,
    errorMessage: null, isOpen: true, isSaving: false,
    localDirectoryStatus: { supported: false, directoryName: null, connected: false, permission: "prompt" },
    vault: {} as any, onBackupToCloud: async () => {}, onChooseLocalDirectory: async () => {}, onClearLocalDirectory: async () => {},
    onClose() {}, onLogout() {}, onSaveApiKeys: async () => billingUser.apiKeys, onSave() {},
  };
  await act(async () => { root.render(createElement(ProfileModal, profileProps as any)); });
  assert.equal(intervals.size, 0);
  await act(async () => { button("Billing").click(); });
  assert.equal(container.querySelector('#profile-tab-billing')?.getAttribute("aria-selected"), "true");
  const beforeUserRefresh = refreshes;
  await act(async () => {
    root.render(createElement(ProfileModal, { ...profileProps, user: { ...billingUser, apiKeys: { ...billingUser.apiKeys }, billing: { ...billingUser.billing, creditBalanceMicros: 12_000_000 } } } as any));
  });
  assert.equal(container.querySelector('#profile-tab-billing')?.getAttribute("aria-selected"), "true");
  assert.equal(refreshes, beforeUserRefresh);
  checks.push("account refresh preserves active tab without refresh loop");

  await act(async () => { root.render(createElement(ProfileModal, { ...profileProps, isOpen: false } as any)); });
  assert.equal(intervals.size, 0);
  const afterClose = refreshes;
  await act(async () => { browser.dispatchEvent(new browser.Event("focus")); });
  assert.equal(refreshes, afterClose);
  checks.push("closing profile removes refresh listeners and timers");

  console.log(JSON.stringify({ checks }));
} finally {
  await act(async () => { root.unmount(); });
  await browser.happyDOM.close();
}
