import assert from "node:assert/strict";
import { mock } from "bun:test";
import { Window } from "happy-dom";
import { billingDashboard, billingUser } from "./billingFixture";
const browser = new Window({ url: "http://extension-frame.test/workspace.html" });
for (const name of ["window", "document", "navigator", "localStorage", "HTMLElement", "Element", "Node", "Event"]) {
  Object.defineProperty(globalThis, name, { configurable: true, value: name === "window" ? browser : (browser as any)[name] });
}
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { setApiTransport, apiStorageNamespace } = await import("../../client/src/lib/apiTransport");
const { loadOfflineUser } = await import("../../client/src/lib/offlineSession");
let workspace: any;
mock.module("../../client/src/WorkspaceApp", () => ({ default(props: any) { workspace = props; return createElement("div", null, "Workspace"); } }));
const requests: string[] = [], opened: string[] = [];
let connected = 0, loggedOut = 0;
const extension = { serverUrl: "https://margin.example", userId: billingUser.id, onConnect() { connected++; }, async onLogout() { loggedOut++; }, openExternal(url: string) { opened.push(url); } };
const delegated = (async (input) => {
  const path = String(input); requests.push(path);
  if (path === "/api/auth/session") return Response.json({ user: billingUser });
  if (path === "/api/billing/dashboard") return Response.json(billingDashboard);
  throw new Error(`Unexpected extension API: ${path}`);
}) as typeof fetch;
setApiTransport({ serverUrl: extension.serverUrl, fetch: delegated });
const { default: App } = await import("../../client/src/App");
const container = browser.document.createElement("div"); browser.document.body.append(container);
const root = createRoot(container as unknown as Element);
const checks: string[] = [];
try {
  await act(async () => root.render(createElement(App, { extension })));
  for (let count = 0; count < 20 && !workspace; count++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
  assert.ok(workspace);
  assert.equal(workspace.user.id, billingUser.id);
  assert.equal(workspace.storageNamespace, apiStorageNamespace(billingUser.id));
  assert.notEqual(workspace.storageNamespace, billingUser.id);
  assert.equal(loadOfflineUser()?.id, billingUser.id);
  setApiTransport({ serverUrl: "https://other.example", fetch: delegated });
  assert.equal(loadOfflineUser(), null);
  setApiTransport({ serverUrl: extension.serverUrl, fetch: delegated });
  checks.push("server-scoped offline identities and storage preserve the real authenticated account ID");
  await act(async () => {
    await workspace.onAddMoney(500); await workspace.onStartSubscription(); await workspace.onManageBilling();
    workspace.onOpenWebsiteSettings("api-keys");
    await assert.rejects(workspace.onUpdateProfile({ displayName: "Changed", email: "changed@example.com" }), /website/);
    await assert.rejects(workspace.onChangePassword({ currentPassword: "old", password: "new" }), /website/);
    await assert.rejects(workspace.onUpdateApiKeys({ keys: { openai: "fixture" } }), /website/);
  });
  assert.ok(opened.every((url) => new URL(url).origin === extension.serverUrl));
  assert.equal(new URL(opened[0]).searchParams.get("settings"), "billing");
  assert.equal(new URL(opened[3]).searchParams.get("settings"), "api-keys");
  assert.ok(requests.every((path) => ["/api/auth/session", "/api/billing/dashboard"].includes(path)));
  checks.push("billing and account changes open website settings without submitting credentials through extension APIs");
  await act(async () => { workspace.onLogout(); await Promise.resolve(); });
  assert.equal(loggedOut, 1); assert.equal(loadOfflineUser(), null);
  const button = [...container.querySelectorAll("button")].find((item) => item.textContent === "Connect Margin Chat");
  assert.ok(button); assert.equal(container.querySelector('input[type="password"]'), null);
  await act(async () => button.click()); assert.equal(connected, 1);
  checks.push("logout uses the extension session and disconnected workspaces direct sign-in to extension settings");
  // A previous account's offline identity must not open under new extension settings.
  const { rememberOfflineUser } = await import("../../client/src/lib/offlineSession");
  rememberOfflineUser(billingUser);
  setApiTransport({ serverUrl: extension.serverUrl, fetch: (async () => { throw new TypeError("Offline"); }) as typeof fetch });
  workspace = null;
  await act(async () => root.render(createElement(App, { key: "other-account", extension: { ...extension, userId: "another-account" } })));
  assert.equal(workspace, null);
  assert.match(container.textContent ?? "", /Connect your workspace/);
  checks.push("switching extension accounts offline never exposes the previous account's workspace");
  console.log(JSON.stringify({ checks }));
} finally { await act(async () => root.unmount()); setApiTransport(null); await browser.happyDOM.close(); }
