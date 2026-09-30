import assert from "node:assert/strict";
import { Window } from "happy-dom";

const browser = new Window({ url: "http://app-updates.test" });
for (const name of ["window", "document", "navigator", "localStorage", "HTMLElement", "Element", "Node", "Text", "Event"]) {
  Object.defineProperty(globalThis, name, { configurable: true, value: name === "window" ? browser : (browser as any)[name] });
}
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
Object.defineProperty(browser.document, "readyState", { configurable: true, value: "complete" });
Object.defineProperty(browser.document, "visibilityState", { configurable: true, value: "visible" });
let online = true;
Object.defineProperty(browser.navigator, "onLine", { configurable: true, get: () => online });

class Worker extends browser.EventTarget {
  state = "installing";
  setState(state: string) { this.state = state; this.dispatchEvent(new browser.Event("statechange")); }
}
let checks = 0;
let registrations = 0;
let rejectCheck = false;
const registration = Object.assign(new browser.EventTarget(), {
  active: null as Worker | null,
  waiting: null as Worker | null,
  installing: null as Worker | null,
  async update() { checks++; if (rejectCheck) throw new Error("offline"); },
});
Object.defineProperty(browser.navigator, "serviceWorker", { value: Object.assign(new browser.EventTarget(), {
  async register(url: string, options: object) {
    registrations++;
    assert.equal(url, "/sw.js");
    assert.deepEqual(options, { updateViaCache: "none" });
    return registration;
  },
}) });
let interval: (() => void) | undefined;
let intervalDelay: number | undefined;
let cleared = 0;
browser.setInterval = ((callback: () => void, delay: number) => { interval = callback; intervalDelay = delay; return 42; }) as any;
browser.clearInterval = (() => { interval = undefined; cleared++; }) as any;

const { watchAppUpdates, UPDATE_CHECK_INTERVAL, APP_VERSION_STORAGE_KEY } = await import("../../client/src/lib/appUpdates");
const seen: unknown[] = [];
const stop = watchAppUpdates((worker) => seen.push(worker));
await Promise.resolve();
assert.equal(intervalDelay, UPDATE_CHECK_INTERVAL);
assert.equal(seen.length, 0);
const first = new Worker();
registration.installing = first;
registration.dispatchEvent(new browser.Event("updatefound"));
first.setState("installed");
assert.equal(seen.length, 0, "First installation is not an update");
registration.active = first;
const next = new Worker();
registration.installing = next;
registration.dispatchEvent(new browser.Event("updatefound"));
registration.waiting = next;
next.setState("installed");
assert.deepEqual(seen, [next]);

await interval!();
assert.equal(checks, 1);
Object.defineProperty(browser.document, "visibilityState", { configurable: true, value: "hidden" });
await interval!();
assert.equal(checks, 1, "Hidden tabs do not poll");
Object.defineProperty(browser.document, "visibilityState", { configurable: true, value: "visible" });
online = false;
await interval!();
assert.equal(checks, 1);
online = true;
rejectCheck = true;
await interval!();
rejectCheck = false;
browser.dispatchEvent(new browser.Event("online"));
await Promise.resolve();
assert.equal(checks, 3, "Failed checks can retry");
stop();
const checksAfterStop = checks;
browser.document.dispatchEvent(new browser.Event("visibilitychange"));
assert.equal(checks, checksAfterStop);
assert.equal(cleared, 1);

// A registration resolving after StrictMode cleanup must attach no listeners.
const stopEarly = watchAppUpdates(() => { throw new Error("Disposed watcher notified"); });
stopEarly();
await Promise.resolve();
assert.equal(interval, undefined);

const { act, createElement, StrictMode } = await import("react");
const { createRoot } = await import("react-dom/client");
const { default: AppUpdateNotice } = await import("../../client/src/components/AppUpdateNotice");
const container = browser.document.createElement("div");
browser.document.body.append(container);
let root = createRoot(container as unknown as Element);
const oldCommit = "a".repeat(40);
const commit = "b".repeat(40);
registration.waiting = null;
registration.installing = null;
browser.localStorage.setItem(APP_VERSION_STORAGE_KEY, oldCommit);
const render = async () => { await act(async () => { root.render(createElement(StrictMode, null, createElement(AppUpdateNotice, { commit }))); }); };
await render();
assert.match(container.textContent!, /App updated/);
assert.match(container.textContent!, /Loaded version bbbbbbb/);
assert.equal(container.querySelector("code")?.title, commit);
await act(async () => { (container.querySelector('[aria-label="Dismiss update notification"]') as any).click(); });
assert.equal(browser.localStorage.getItem(APP_VERSION_STORAGE_KEY), commit);
assert.equal(container.querySelector('[role="status"]'), null);
assert.match(container.textContent!, /Version bbbbbbb/);

await act(async () => { root.unmount(); });
root = createRoot(container as unknown as Element);
registration.waiting = next;
await render();
assert.match(container.textContent!, /Update ready/);
assert.match(container.textContent!, /Loaded version bbbbbbb/, "Waiting worker never changes loaded version");
assert.match(container.textContent!, /Restart all open tabs/);
assert.equal([...container.querySelectorAll("button")].some((button) => button.textContent === "Restart now"), true);
await act(async () => { (container.querySelector('[aria-label="Dismiss update notification"]') as any).click(); });
await act(async () => { registration.dispatchEvent(new browser.Event("updatefound")); });
assert.equal(container.querySelector('[role="status"]'), null, "Same waiting update stays dismissed");
await act(async () => { root.unmount(); });
registration.waiting = null;
root = createRoot(container as unknown as Element);
await render();
assert.equal(container.querySelector('[role="status"]'), null, "Acknowledged loaded version does not notify on every visit");
await act(async () => { (container.querySelector("button") as any).click(); });
assert.match(container.textContent!, /App version loaded/);
await act(async () => { root.unmount(); });
assert.ok(registrations > 0);

const { registerAppUpdateGuard, isAppUpdateLocked } = await import("../../client/src/lib/appUpdateSafety");
const { listenForAppRestart, requestAppRestart } = await import("../../client/src/lib/appUpdateRestart");
const serviceWorker = (browser.navigator as any).serviceWorker;
const target = Object.assign(new Worker(), { scriptURL: "http://app-updates.test/sw.js" });
let reloads = 0;
Object.defineProperty(browser.location, "reload", { value: () => { reloads++; } });
let flushes = 0;
let blocked: string | null = "An unsent draft is open";
let saveFailure = false;
let safeToReload = true;
const unregister = registerAppUpdateGuard("test-workspace", {
  check: () => blocked,
  canReload: () => safeToReload,
  flush: async () => { if (saveFailure) throw new Error("Disk full"); flushes++; },
});
let status: string | null = null;
const stopRestart = listenForAppRestart((value) => { status = value; });
const send = async (type: string, id: string) => {
  const channel = new MessageChannel();
  const reply = new Promise<any>((resolve) => {
    channel.port1.onmessage = (event) => { channel.port1.close(); resolve(event.data); };
  });
  serviceWorker.dispatchEvent(new browser.MessageEvent("message", { data: { type, id }, source: target as any, ports: [channel.port2] as any }));
  return reply;
};
serviceWorker.dispatchEvent(new browser.Event("controllerchange"));
assert.equal(reloads, 0, "First installation does not reload");
assert.match((await send("MARGIN_PREPARE_UPDATE", "blocked")).error, /unsent draft/);
assert.equal(flushes, 0);
assert.equal(isAppUpdateLocked(), false);
blocked = null;
saveFailure = true;
assert.match((await send("MARGIN_PREPARE_UPDATE", "failed-save")).error, /Disk full/);
assert.equal(isAppUpdateLocked(), false);
saveFailure = false;
assert.deepEqual(await send("MARGIN_PREPARE_UPDATE", "cancelled"), { ready: true });
assert.equal(isAppUpdateLocked(), true);
serviceWorker.dispatchEvent(new browser.MessageEvent("message", { data: { type: "MARGIN_CANCEL_UPDATE", id: "cancelled" }, source: target as any }));
assert.equal(isAppUpdateLocked(), false);
assert.match((await send("MARGIN_COMMIT_UPDATE", "cancelled")).error, /expired/);

assert.deepEqual(await send("MARGIN_PREPARE_UPDATE", "restart"), { ready: true });
assert.equal(isAppUpdateLocked(), true);
assert.deepEqual(await send("MARGIN_COMMIT_UPDATE", "restart"), { ready: true });
assert.match(status!, /Restarting/);
assert.equal(flushes, 3, "Preparation and commit both await durable saves");
serviceWorker.controller = target;
safeToReload = false;
serviceWorker.dispatchEvent(new browser.Event("controllerchange"));
assert.equal(reloads, 0, "Work arriving after commit blocks reload");
assert.equal(isAppUpdateLocked(), false);
safeToReload = true;
assert.deepEqual(await send("MARGIN_PREPARE_UPDATE", "retry"), { ready: true });
assert.deepEqual(await send("MARGIN_COMMIT_UPDATE", "retry"), { ready: true });
assert.equal(reloads, 0, "An already-active worker still waits for every tab to commit");
serviceWorker.dispatchEvent(new browser.MessageEvent("message", { data: { type: "MARGIN_RELOAD_UPDATE", id: "retry" }, source: target as any }));
serviceWorker.dispatchEvent(new browser.Event("controllerchange"));
serviceWorker.dispatchEvent(new browser.Event("controllerchange"));
assert.equal(reloads, 1, "Only the prepared worker can trigger one reload");
stopRestart();
unregister();
assert.equal(isAppUpdateLocked(), false);

await assert.rejects(requestAppRestart({ postMessage(_message: any, ports: MessagePort[]) {
  ports[0].postMessage({ error: "Another tab is busy" }); ports[0].close();
} } as any), /Another tab is busy/);
await requestAppRestart({ postMessage(_message: any, ports: MessagePort[]) {
  ports[0].postMessage({ ready: true }); ports[0].close();
} } as any);
await browser.happyDOM.close();
console.log("pass");
