import assert from "node:assert/strict";
import { Window } from "happy-dom";

const browser = new Window({ url: "http://notification-toast.test" });
for (const name of ["window", "document", "navigator", "HTMLElement", "Element", "Node", "Document", "DocumentFragment", "MutationObserver", "Event", "MouseEvent", "KeyboardEvent", "FocusEvent"]) {
  const value = name === "window" ? browser : (browser as any)[name];
  if (value !== undefined) Object.defineProperty(globalThis, name, { configurable: true, value });
}
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const { act, createElement } = await import("../../client/node_modules/react/index.js");
const { createRoot } = await import("../../client/node_modules/react-dom/client.js");
const { default: NotificationToast } = await import("../../client/src/components/NotificationToast");
const container = browser.document.createElement("div");
const outside = browser.document.createElement("button");
outside.textContent = "Outside";
browser.document.body.append(container, outside);
const root = createRoot(container as unknown as Element);
let now = 100_000, nextTimer = 1;
const originalNow = Date.now;
const originalSetTimeout = browser.setTimeout.bind(browser);
const originalClearTimeout = browser.clearTimeout.bind(browser);
const timers = new Map<number, { due: number; callback: () => void }>();
Date.now = () => now;
browser.setTimeout = ((callback: () => void, delay: number) => {
  const id = nextTimer++;
  timers.set(id, { due: now + delay, callback });
  return id;
}) as typeof browser.setTimeout;
browser.clearTimeout = ((id: number) => { timers.delete(id); }) as typeof browser.clearTimeout;
async function advance(milliseconds: number) {
  await act(async () => {
    const target = now + milliseconds;
    for (;;) {
      const due = [...timers.entries()].filter(([, timer]) => timer.due <= target).sort((a, b) => a[1].due - b[1].due)[0];
      if (!due) break;
      now = due[1].due;
      timers.delete(due[0]);
      due[1].callback();
    }
    now = target;
  });
}
const toast = () => container.querySelector('.notification-toast');
const dismissals: string[] = [];
const checks: string[] = [];
const render = async (message: string | null, extra: Record<string, unknown> = {}) => {
  await act(async () => { root.render(createElement(NotificationToast, { message, onDismiss: () => dismissals.push(message!), ...extra })); });
};
try {
  await render("Saved");
  assert.equal(timers.size, 1);
  await advance(3000);
  await render("Saved", { onDismiss: () => dismissals.push("latest callback") });
  await advance(4999);
  assert(toast());
  await advance(1);
  assert.equal(toast(), null);
  assert.deepEqual(dismissals, ["latest callback"]);
  await render("Saved");
  await advance(10000);
  assert.equal(toast(), null);
  assert.equal(dismissals.length, 1);
  checks.push("8-second timeout survives rerenders, uses latest callback, and stays dismissed");

  await render("Imported");
  assert(toast());
  await advance(1000);
  await act(async () => { toast()!.dispatchEvent(new browser.MouseEvent("mouseover", { bubbles: true })); });
  assert.equal(timers.size, 0);
  await advance(20000);
  assert(toast());
  const close = container.querySelector<HTMLButtonElement>('[aria-label="Dismiss notification"]')!;
  await act(async () => { close.focus(); });
  await act(async () => { toast()!.dispatchEvent(new browser.MouseEvent("mouseout", { bubbles: true, relatedTarget: outside })); });
  assert.equal(timers.size, 0);
  await advance(20000);
  assert(toast());
  await act(async () => { outside.focus(); });
  assert.equal(timers.size, 1);
  await advance(6999);
  assert(toast());
  await advance(1);
  assert.equal(toast(), null);
  assert.deepEqual(dismissals, ["latest callback", "Imported"]);
  checks.push("hover and focus pause independently and resume only the remaining time");

  await render("Copied");
  await act(async () => { container.querySelector('p')!.click(); });
  assert.equal(toast(), null);
  await advance(8000);
  assert.equal(dismissals.filter((value) => value === "Copied").length, 1);
  await render("Exported");
  await act(async () => { container.querySelector<HTMLButtonElement>('[aria-label="Dismiss notification"]')!.click(); });
  assert.equal(toast(), null);
  assert.equal(dismissals.filter((value) => value === "Exported").length, 1);
  let actionCalls = 0;
  await render("Folder saved", { action: { label: "Open folder", onClick() { actionCalls++; } } });
  await act(async () => { container.querySelector<HTMLButtonElement>('.notification-toast-action')!.click(); });
  assert.equal(actionCalls, 1);
  assert.equal(toast(), null);
  assert.equal(dismissals.filter((value) => value === "Folder saved").length, 1);
  assert.equal(timers.size, 0);
  checks.push("content, close, and action clicks dismiss once, with actions still invoked");

  await render("Waiting");
  await advance(2000);
  await render("New message");
  await advance(7999);
  assert.equal(container.querySelector('p')?.textContent, "New message");
  await render(null);
  assert.equal(toast(), null);
  assert.equal(timers.size, 0);
  await render("Unmount");
  assert.equal(timers.size, 1);
  await act(async () => { root.unmount(); });
  assert.equal(timers.size, 0);
  assert(!dismissals.includes("Waiting"));
  assert(!dismissals.includes("New message"));
  assert(!dismissals.includes("Unmount"));
  checks.push("new messages reopen with a fresh timer; cleared messages and unmount clean up silently");
  console.log(JSON.stringify({ checks }));
} finally {
  Date.now = originalNow;
  browser.setTimeout = originalSetTimeout;
  browser.clearTimeout = originalClearTimeout;
  await browser.happyDOM.close();
}
