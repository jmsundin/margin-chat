import assert from "node:assert/strict";
import { mock } from "bun:test";
import { Window } from "happy-dom";
import { billingUser } from "./billingFixture";

const browser = new Window({ url: "http://returning.test/" });
for (const name of ["window", "document", "navigator", "localStorage", "history", "location", "HTMLElement", "Element", "Node", "Text", "Document", "DocumentFragment", "MutationObserver", "Event", "MouseEvent", "KeyboardEvent", "PopStateEvent"]) {
  const value = name === "window" ? browser : (browser as any)[name];
  if (value !== undefined) Object.defineProperty(globalThis, name, { configurable: true, value });
}
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
mock.module("../../client/src/WorkspaceApp", () => ({ default(props: any) { return createElement("div", null, `Workspace ${props.user.id}`); } }));
mock.module("../../client/src/components/AuthLanding", () => ({ default(props: any) { return createElement("div", null, `Sign in (${props.initialMode}): ${props.errorMessage}`); } }));
// The session check stays unanswered until the test answers it, like a slow server.
let answerSession: (user: typeof billingUser | null) => void = () => undefined;
globalThis.fetch = (async (url) => {
  if (url === "/api/auth/session") return new Promise((resolve) => { answerSession = (user) => resolve(Response.json({ user })); });
  if (url === "/api/billing/dashboard") return Response.json({});
  throw new Error(`Unexpected request ${url}`);
}) as typeof fetch;

const { loadOfflineUser, rememberOfflineUser } = await import("../../client/src/lib/offlineSession");
rememberOfflineUser(billingUser);
const { default: App } = await import("../../client/src/App");
const container = browser.document.createElement("div");
browser.document.body.append(container);
const root = createRoot(container as unknown as Element);
async function flushUntil(predicate: () => boolean, label: string) {
  for (let count = 0; count < 30 && !predicate(); count += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
  assert(predicate(), `${label}. Saw: ${container.textContent?.slice(0, 200)}`);
}

try {
  await act(async () => { root.render(createElement(App)); });
  assert.equal(container.textContent, `Workspace ${billingUser.id}`, "A returning visitor sees the workspace before the session check answers");

  // The saved sign-in has ended on the server: the visitor is asked to sign in again.
  await act(async () => { answerSession(null); });
  await flushUntil(() => container.textContent?.startsWith("Sign in (login)") ?? false, "An ended session leads to sign-in");
  assert.equal(browser.location.pathname, "/login");
  assert(container.textContent?.includes("Your session expired"));
  assert.equal(loadOfflineUser(), null, "The ended sign-in is forgotten on this device");
  console.log(JSON.stringify({ result: "pass" }));
} finally {
  await act(async () => { root.unmount(); });
  await browser.happyDOM.close();
}
