import assert from "node:assert/strict";
import { Window } from "happy-dom";

const browser = new Window({ url: "http://search.test/" });
for (const name of ["window", "document", "navigator", "HTMLElement", "Element", "Node", "Text", "Document", "DocumentFragment", "MutationObserver", "Event"]) {
  const value = name === "window" ? browser : (browser as any)[name];
  if (value !== undefined) Object.defineProperty(globalThis, name, { configurable: true, value });
}
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const { act, createElement } = await import("../../client/node_modules/react/index.js");
const { createRoot } = await import("../../client/node_modules/react-dom/client.js");
const { useJevSearch } = await import("../../client/src/lib/useJevSearch");
const originalFetch = globalThis.fetch;
const originalSetTimeout = globalThis.setTimeout;
const originalClearTimeout = globalThis.clearTimeout;
let timerId = -1;
const timers = new Map<number, { callback: () => unknown; ms: number }>();
globalThis.setTimeout = ((callback: () => unknown, ms: number, ...args: any[]) => {
  if (ms !== 500 && ms !== 10_000) return originalSetTimeout(callback, ms, ...args);
  const id = timerId--; timers.set(id, { callback, ms }); return id;
}) as any;
globalThis.clearTimeout = ((id: any) => { if (!timers.delete(id)) originalClearTimeout(id); }) as any;

let props: Parameters<typeof useJevSearch>[0] = { userId: "account-one", enabled: false, ready: true, active: true, serviceStatus: "ready",
  snapshot: { query: "reading", items: [{ id: "passage", sourceKind: "message", role: "assistant", title: "Reading", content: "The reading decision" }],
    facets: [{ id: "purpose:decision", label: "Decisions", itemIds: ["passage"] }] } };
let view: ReturnType<typeof useJevSearch>;
let hold = false;
const requests: Array<{ body: any; account: string | null; signal: AbortSignal; resolve?: (response: Response) => void }> = [];
const responseFor = () => Response.json({ available: true, scores: [{ id: "passage", score: 0.9, confidence: 0.9 }], suggestedFacetIds: ["purpose:decision"] });
globalThis.fetch = (async (url, init) => {
  assert.equal(url, "/api/jev/search", "Search reuses existing Jev availability instead of fetching status");
  const request = { body: JSON.parse(String(init?.body)), account: new Headers(init?.headers).get("X-Margin-Vault-User"), signal: init?.signal as AbortSignal,
    resolve: undefined as ((response: Response) => void) | undefined };
  requests.push(request);
  return hold ? await new Promise<Response>((resolve) => { request.resolve = resolve; }) : responseFor();
}) as typeof fetch;
function Harness() { view = useJevSearch(props); return createElement("div", null, view.status); }
const container = browser.document.createElement("div");
browser.document.body.append(container);
const root = createRoot(container as unknown as Element);
async function render() { await act(async () => { root.render(createElement(Harness)); }); }
async function flush(ms = 500) {
  await act(async () => {
    for (const [id, timer] of [...timers]) if (timer.ms === ms) { timers.delete(id); void timer.callback(); }
    await new Promise<void>((resolve) => originalSetTimeout(resolve, 0));
  });
}
function query(value: string) { props = { ...props, snapshot: { ...props.snapshot!, query: value } }; }
try {
  await render(); await flush();
  assert.equal(view!.status, "off"); assert.equal(requests.length, 0);
  props = { ...props, enabled: true, serviceStatus: "checking" }; await render(); await flush();
  assert.equal(view!.status, "checking"); assert.equal(requests.length, 0);
  props = { ...props, serviceStatus: "unconfigured" }; await render(); await flush();
  assert.equal(view!.status, "unconfigured"); assert.equal(requests.length, 0);
  props = { ...props, serviceStatus: "ready" }; await render();
  assert.equal(view!.status, "loading"); assert.deepEqual({ ...view!.scores }, {});
  query("read"); await render(); query("reading plans"); await render();
  assert.equal([...timers.values()].filter((timer) => timer.ms === 500).length, 1);
  await flush();
  assert.equal(requests.length, 1); assert.equal(requests[0].body.query, "reading plans");
  assert.equal(requests[0].account, "account-one"); assert.equal(view!.status, "ready");
  assert.equal(view!.scores.passage, 0.9); assert.equal(view!.analyzedCount, 1);
  assert.deepEqual(view!.suggestedFacetIds, ["purpose:decision"]);
  props = { ...props, snapshot: structuredClone(props.snapshot) }; await render(); await flush();
  assert.equal(requests.length, 1, "Equivalent snapshots do not restart work");

  hold = true; query("old query"); await render(); await flush();
  const old = requests.at(-1)!;
  query("new query"); await render();
  assert(old.signal.aborted); assert.deepEqual({ ...view!.scores }, {});
  await act(async () => { old.resolve!(responseFor()); });
  assert.equal(view!.status, "loading", "Transport ignoring abort cannot publish stale data");
  hold = false; await flush(); assert.equal(view!.status, "ready");
  const beforeReturn = requests.length;
  query("reading plans"); await render(); await flush();
  assert.equal(requests.length, beforeReturn, "Returning to a query reuses account-scoped judgments");

  hold = true; query("closing search"); await render(); await flush();
  const closing = requests.at(-1)!;
  props = { ...props, active: false }; await render();
  assert(closing.signal.aborted); assert.equal(view!.status, "off");
  assert.deepEqual({ ...view!.scores }, {});
  await act(async () => { closing.resolve!(responseFor()); });
  assert.equal(view!.status, "off");

  props = { ...props, active: true }; query("deadline"); await render(); await flush();
  const deadline = requests.at(-1)!;
  await flush(10_000);
  assert(deadline.signal.aborted); assert.equal(view!.status, "unavailable");
  await act(async () => { deadline.resolve!(responseFor()); });
  assert.equal(view!.status, "unavailable", "Late completion after deadline stays local fallback");

  query("account switch"); await render(); await flush();
  const previousAccount = requests.at(-1)!;
  props = { ...props, userId: "account-two", enabled: false }; await render();
  assert(previousAccount.signal.aborted); assert.equal(view!.status, "off");
  await act(async () => { previousAccount.resolve!(responseFor()); });
  assert.deepEqual({ ...view!.scores }, {});
  hold = false; props = { ...props, enabled: true }; query("reading plans"); await render(); await flush();
  assert.equal(requests.at(-1)!.account, "account-two", "Another account does not reuse the old cache");
  props = { ...props, pending: true }; await render(); await flush();
  assert.equal(view!.status, "paused"); assert.deepEqual({ ...view!.scores }, {});
  props = { ...props, pending: false, ready: false }; await render(); await flush();
  assert.equal(view!.status, "off");
  await act(async () => { root.unmount(); });
  assert.equal(timers.size, 0, "Unmount clears all search timers");
  console.log("Jev search hook checks passed");
} finally {
  globalThis.fetch = originalFetch;
  globalThis.setTimeout = originalSetTimeout;
  globalThis.clearTimeout = originalClearTimeout;
  await browser.happyDOM.abort();
}
