import assert from "node:assert/strict";
import { mock } from "bun:test";
import { Window } from "happy-dom";
import { billingDashboard, billingUser } from "./billingFixture";

const browser = new Window({ url: "http://billing-race.test/" });
for (const name of ["window", "document", "navigator", "localStorage", "HTMLElement", "Element", "Node", "Text", "Document", "DocumentFragment", "MutationObserver", "Event", "MouseEvent", "KeyboardEvent"]) {
  const value = name === "window" ? browser : (browser as any)[name];
  if (value !== undefined) Object.defineProperty(globalThis, name, { configurable: true, value });
}
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
let workspace: any;
let auth: any;
mock.module("../../client/src/WorkspaceApp", () => ({ default(props: any) { workspace = props; return createElement("div", null, props.user.id); } }));
mock.module("../../client/src/components/AuthLanding", () => ({ default(props: any) { auth = props; return createElement("div", null, "Sign in"); } }));
const otherUser = { ...billingUser, id: "other-user", email: "other@example.test" };
let serverUser = billingUser;
let deferDashboard = false;
const pendingDashboards: Array<(response: Response) => void> = [];
let settleCheckout!: (response: Response) => void;
const checkout = new Promise<Response>((resolve) => { settleCheckout = resolve; });
const redirects: string[] = [];
Object.defineProperty(browser.location, "assign", { configurable: true, value: (url: string) => redirects.push(url) });
globalThis.fetch = (async (url, init) => {
  if (url === "/api/auth/session") return Response.json({ user: serverUser });
  if (url === "/api/auth/logout") return Response.json({ ok: true });
  if (url === "/api/auth/login") { serverUser = otherUser; return Response.json({ user: serverUser }); }
  if (url === "/api/billing/dashboard") {
    assert.equal(new Headers(init?.headers).get("X-Margin-Billing-User"), serverUser.id);
    if (deferDashboard) return await new Promise<Response>((resolve) => { pendingDashboards.push(resolve); });
    return Response.json({ ...billingDashboard, user: serverUser });
  }
  if (url === "/api/billing/topup") {
    assert.equal(new Headers(init?.headers).get("X-Margin-Billing-User"), billingUser.id);
    return await checkout;
  }
  throw new Error(`Unexpected request ${url}`);
}) as typeof fetch;
const { default: App } = await import("../../client/src/App");
const container = browser.document.createElement("div");
browser.document.body.append(container);
const root = createRoot(container as unknown as Element);
async function flushUntil(predicate: () => boolean) {
  for (let count = 0; count < 30 && !predicate(); count += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
  assert(predicate(), "App did not reach the expected account state");
}
try {
  await act(async () => { root.render(createElement(App)); });
  await flushUntil(() => Boolean(workspace?.billingDashboard));
  deferDashboard = true;
  let olderRefresh!: Promise<void>;
  let newerRefresh!: Promise<void>;
  await act(async () => { olderRefresh = workspace.onRefreshBilling(); newerRefresh = workspace.onRefreshBilling(); });
  assert.equal(pendingDashboards.length, 2);
  await act(async () => { pendingDashboards[1](Response.json({ ...billingDashboard, balanceMicros: 12_000_000 })); await newerRefresh; });
  await act(async () => { pendingDashboards[0](Response.json({ ...billingDashboard, balanceMicros: 10_000_000 })); await olderRefresh; });
  assert.equal(workspace.billingDashboard.balanceMicros, 12_000_000, "An older response must not replace the latest balance");

  let staleCheckout!: Promise<void>;
  let staleRefresh!: Promise<void>;
  await act(async () => { staleCheckout = workspace.onAddMoney(1200); staleRefresh = workspace.onRefreshBilling(); });
  await act(async () => { workspace.onLogout(); });
  await flushUntil(() => container.textContent === "Sign in");
  deferDashboard = false;
  await act(async () => { await auth.onLogin({ email: otherUser.email, password: "fixture" }); });
  await flushUntil(() => workspace.user.id === otherUser.id && workspace.billingDashboard?.user?.id === otherUser.id);
  await act(async () => {
    pendingDashboards[2](Response.json({ ...billingDashboard, balanceMicros: 999_000_000 }));
    settleCheckout(Response.json({ url: "https://checkout.stripe.com/old-account" }));
    await Promise.all([staleCheckout, staleRefresh]);
  });
  assert.equal(workspace.user.id, otherUser.id);
  assert.equal(workspace.billingDashboard.user.id, otherUser.id);
  assert.equal(workspace.billingDashboard.balanceMicros, billingDashboard.balanceMicros);
  assert.deepEqual(redirects, [], "A checkout started by the previous account must not redirect the new account");
  console.log(JSON.stringify({ result: "pass" }));
} finally {
  await act(async () => { root.unmount(); });
  await browser.happyDOM.close();
}
