import assert from "node:assert/strict";
import { mock } from "bun:test";
import { Window } from "happy-dom";
import { billingDashboard, billingUser } from "./billingFixture";

const scenario = process.argv[2];
const isPortalReturn = scenario.startsWith("portal");
const requiresLogin = scenario === "login" || scenario === "portal-login";
const query = isPortalReturn ? "billing=return" : scenario === "canceled" ? "checkout=canceled" : scenario === "missing" ? "checkout=success" : `checkout=${scenario === "subscription" ? "subscription_success" : "topup_success"}&session_id=cs_test`;
const browser = new Window({ url: `http://billing-return.test/?inbox=1&${query}#preserved` });
for (const name of ["window", "document", "navigator", "localStorage", "HTMLElement", "Element", "Node", "Text", "Document", "DocumentFragment", "MutationObserver", "Event", "MouseEvent", "KeyboardEvent"]) {
  const value = name === "window" ? browser : (browser as any)[name];
  if (value !== undefined) Object.defineProperty(globalThis, name, { configurable: true, value });
}
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
let workspaceProps: any;
let authProps: any;
mock.module("../../client/src/WorkspaceApp", () => ({ default(props: any) { workspaceProps = props; return createElement("div", null, props.billingNotice?.message ?? "Workspace"); } }));
mock.module("../../client/src/components/AuthLanding", () => ({ default(props: any) { authProps = props; return createElement("div", null, "Sign in"); } }));
let confirmations = 0;
let dashboards = 0;
let settle!: (response: Response) => void;
let reject!: (error: Error) => void;
const pendingConfirmation = new Promise<Response>((resolve, failure) => { settle = resolve; reject = failure; });
globalThis.fetch = (async (url, init) => {
  if (url === "/api/auth/session") return Response.json({ user: requiresLogin ? null : billingUser });
  if (url === "/api/auth/login") return Response.json({ user: billingUser });
  if (url === "/api/billing/dashboard") {
    dashboards += 1;
    assert.equal(new Headers(init?.headers).get("X-Margin-Billing-User"), billingUser.id);
    return Response.json(isPortalReturn ? {
      ...billingDashboard,
      subscription: { ...billingDashboard.subscription, cancelAtPeriodEnd: true },
      user: { ...billingUser, billing: { ...billingUser.billing, cancelAtPeriodEnd: true } },
    } : billingDashboard);
  }
  if (url === "/api/billing/checkout/confirm") {
    confirmations += 1;
    assert.equal(new Headers(init?.headers).get("X-Margin-Billing-User"), billingUser.id);
    assert.deepEqual(JSON.parse(String(init?.body)), { sessionId: "cs_test" });
    return await pendingConfirmation;
  }
  throw new Error(`Unexpected request: ${url}`);
}) as typeof fetch;

const { default: App } = await import("../../client/src/App");
const container = browser.document.createElement("div");
browser.document.body.append(container);
const root = createRoot(container as unknown as Element);
async function flushUntil(predicate: () => boolean) {
  for (let count = 0; count < 30 && !predicate(); count += 1) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
  }
  assert(predicate(), `Scenario ${scenario} did not finish. ${container.textContent}`);
}
try {
  await act(async () => { root.render(createElement(App)); });
  if (requiresLogin) {
    await flushUntil(() => Boolean(authProps));
    assert.equal(confirmations, 0);
    assert(browser.location.search.includes(isPortalReturn ? "billing=return" : "session_id"));
    await act(async () => { await authProps.onLogin({ email: billingUser.email, password: "fixture" }); });
  }
  await flushUntil(() => Boolean(workspaceProps));
  if (!isPortalReturn && scenario !== "missing" && scenario !== "canceled") {
    await flushUntil(() => confirmations > 0);
    assert.equal(workspaceProps.billingNotice, null, "Never show payment success from a URL before the server confirms it");
    await act(async () => {
      if (scenario === "failure") reject(new Error("Payment verification unavailable."));
      else settle(Response.json({ confirmed: scenario !== "pending", status: scenario === "pending" ? "unpaid" : "paid", purchaseKind: scenario === "subscription" ? "subscription" : "hosted_credits", user: billingUser }));
    });
  }
  if (isPortalReturn) {
    await flushUntil(() => !browser.location.search.includes("billing=") && Boolean(workspaceProps.billingDashboard));
    assert.equal(workspaceProps.billingNotice, null, "A portal return is not a payment confirmation");
    assert.equal(workspaceProps.user.billing.cancelAtPeriodEnd, true, "Refresh the account after a portal subscription change");
    assert.equal(workspaceProps.billingDashboard.subscription.cancelAtPeriodEnd, true);
  } else {
    await flushUntil(() => Boolean(workspaceProps.billingNotice) && !browser.location.search.includes("checkout="));
    assert.equal(workspaceProps.billingNotice.kind, ["missing", "failure"].includes(scenario) ? "error" : ["pending", "canceled"].includes(scenario) ? "info" : "success");
  }
  if (scenario === "pending") assert(workspaceProps.billingNotice.message.includes("not confirmed yet"));
  if (scenario === "failure") assert(!workspaceProps.billingNotice.message.includes("completed"));
  assert.equal(confirmations, isPortalReturn || ["missing", "canceled"].includes(scenario) ? 0 : 1);
  assert(workspaceProps.billingOpenRequest > 0);
  assert(dashboards > 0);
  assert.equal(workspaceProps.billingDashboard.balanceMicros, billingDashboard.balanceMicros);
  assert.equal(browser.location.search, "?inbox=1");
  assert.equal(browser.location.hash, "#preserved");
  console.log(JSON.stringify({ scenario, result: "pass" }));
} finally {
  await act(async () => { root.unmount(); });
  await browser.happyDOM.close();
}
