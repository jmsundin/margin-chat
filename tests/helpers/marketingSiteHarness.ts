import assert from "node:assert/strict";
import { mock } from "bun:test";
import { Window } from "happy-dom";
import { billingUser } from "./billingFixture";

const browser = new Window({ url: "http://marketing.test/", settings: { navigator: { userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/140.0 Safari/537.36" } } });
for (const name of ["window", "document", "navigator", "localStorage", "history", "location", "HTMLElement", "Element", "Node", "Text", "Document", "DocumentFragment", "MutationObserver", "Event", "MouseEvent", "KeyboardEvent", "PopStateEvent"]) {
  const value = name === "window" ? browser : (browser as any)[name];
  if (value !== undefined) Object.defineProperty(globalThis, name, { configurable: true, value });
}
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
let auth: any;
mock.module("../../client/src/WorkspaceApp", () => ({ default(props: any) { return createElement("div", null, `Workspace ${props.user.id}`); } }));
mock.module("../../client/src/components/AuthLanding", () => ({ default(props: any) { auth = props; return createElement("div", null, `Sign in (${props.initialMode})`); } }));
let serverUser: typeof billingUser | null = null;
globalThis.fetch = (async (url) => {
  if (url === "/api/auth/session") return Response.json({ user: serverUser });
  if (url === "/api/auth/login") { serverUser = billingUser; return Response.json({ user: serverUser }); }
  if (url === "/api/auth/logout") { serverUser = null; return Response.json({ ok: true }); }
  if (url === "/api/billing/dashboard") return Response.json({});
  // Only the Mac build is published in this fixture.
  if (url === "/api/downloads/desktop") return Response.json({ available: true, version: "0.2.0", files: { mac: { href: "/api/downloads/desktop/mac" } } });
  throw new Error(`Unexpected request ${url}`);
}) as typeof fetch;

const { default: App } = await import("../../client/src/App");
const container = browser.document.createElement("div");
browser.document.body.append(container);
const root = createRoot(container as unknown as Element);
async function flushUntil(predicate: () => boolean, label: string) {
  for (let count = 0; count < 30 && !predicate(); count += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
  assert(predicate(), `${label}. Saw: ${container.textContent?.slice(0, 200)}`);
}
function link(text: string) {
  const match = [...container.querySelectorAll("a")].find((anchor) => anchor.textContent?.trim() === text);
  assert(match, `No link named ${text}`);
  return match as unknown as HTMLAnchorElement;
}
async function click(element: HTMLElement) {
  await act(async () => { element.dispatchEvent(new browser.MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }) as unknown as Event); });
}

try {
  await act(async () => { root.render(createElement(App)); });
  await flushUntil(() => container.textContent?.includes("Think in the margins.") ?? false, "Signed-out visitors should see the landing page");
  assert(container.textContent?.includes("Open the web app"), "Windows visitors are offered the web app");
  assert(container.textContent?.includes("Windows app is coming soon"));

  await click(link("Pricing"));
  assert.equal(browser.location.pathname, "/pricing");
  assert(container.textContent?.includes("Pay for the AI you use"));

  await click(link("Download"));
  assert.equal(browser.location.pathname, "/download");
  const selected = container.querySelector('[role="tab"][aria-selected="true"]');
  assert.equal(selected?.textContent, "Windows", "The download page preselects the visitor's system");
  const macTab = [...container.querySelectorAll('[role="tab"]')].find((tab) => tab.textContent === "macOS") as unknown as HTMLElement;
  await click(macTab);
  const macDownload = [...container.querySelectorAll("a")].find((anchor) => anchor.textContent?.trim() === "Download for macOS");
  assert.equal(macDownload?.getAttribute("href"), "/api/downloads/desktop/mac?from=download-page", "A published Mac build is offered from the server's list");
  const linuxTab = [...container.querySelectorAll('[role="tab"]')].find((tab) => tab.textContent === "Linux") as unknown as HTMLElement;
  await click(linuxTab);
  assert(container.textContent?.includes("The Linux app is on its way"), "Without a published build the Linux tab offers the web app");

  await act(async () => { browser.history.back(); });
  await flushUntil(() => browser.location.pathname === "/pricing" && (container.textContent?.includes("Pay for the AI you use") ?? false), "Back returns to pricing");

  await click(link("Log in"));
  assert.equal(browser.location.pathname, "/login");
  assert.equal(container.textContent, "Sign in (login)");

  await act(async () => { await auth.onLogin({ email: billingUser.email, password: "fixture" }); });
  await flushUntil(() => container.textContent === `Workspace ${billingUser.id}`, "Logging in opens the workspace");
  assert.equal(browser.location.pathname, "/", "The workspace lives at the root URL");
  console.log(JSON.stringify({ result: "pass" }));
} finally {
  await act(async () => { root.unmount(); });
  await browser.happyDOM.close();
}
