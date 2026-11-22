import { expect, test } from "bun:test";
import { Window } from "happy-dom";

const browser = new Window({ url: "http://rediscover-waits.test", width: 390, height: 664 });
for (const name of ["window", "document", "HTMLElement", "Element", "getComputedStyle", "localStorage"]) {
  const value = name === "window" ? browser : (browser as any)[name];
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: name === "getComputedStyle" ? value.bind(browser) : value });
}
const { rediscoverShouldWait } = await import("../client/src/components/RediscoverCard");

test("the Rediscover card waits while a page tip, the phone sidebar, a note sheet, search or a dialog shows", () => {
  const root = document.createElement("div");
  expect(rediscoverShouldWait(root)).toBe(false);
  for (const html of ['<p class="feature-hint"></p>', '<button class="workspace-mobile-backdrop"></button>', '<div class="note-sheet"></div>',
    '<div class="vault-search-backdrop"></div>', '<div role="dialog" aria-modal="true"></div>']) {
    root.innerHTML = html;
    expect(rediscoverShouldWait(root)).toBe(true);
  }
  root.innerHTML = '<div role="dialog"></div><p class="document-body"></p>';
  expect(rediscoverShouldWait(root)).toBe(false);
});
