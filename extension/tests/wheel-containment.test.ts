import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";

const browser = new Window();
Object.assign(globalThis, { getComputedStyle: browser.getComputedStyle.bind(browser) });
const { containWheelScrolling, wheelHasScrollTarget } = await import("../src/wheel-containment");
afterEach(() => { browser.document.body.innerHTML = ""; });

function scroller(scrollTop: number) {
  const box = browser.document.createElement("div");
  box.style.overflowY = "auto";
  Object.defineProperties(box, { scrollHeight: { value: 500 }, clientHeight: { value: 100 } });
  box.scrollTop = scrollTop;
  const child = browser.document.createElement("p");
  box.append(child);
  browser.document.body.append(box);
  return child as unknown as Element;
}

test("a document that can still scroll keeps the wheel", () => {
  expect(wheelHasScrollTarget(scroller(0), 0, 40)).toBe(true);
  expect(wheelHasScrollTarget(scroller(200), 0, -40)).toBe(true);
});

test("a wheel nothing can use is stopped before it scrolls the page", () => {
  expect(wheelHasScrollTarget(scroller(400), 0, 40)).toBe(false);
  expect(wheelHasScrollTarget(scroller(0), 0, -40)).toBe(false);
  const card = browser.document.createElement("div");
  browser.document.body.append(card);
  const stop = containWheelScrolling(browser as unknown as Window & typeof globalThis);
  const wheel = new browser.WheelEvent("wheel", { deltaY: 40, bubbles: true, cancelable: true });
  card.dispatchEvent(wheel);
  expect(wheel.defaultPrevented).toBe(true);
  const zoom = new browser.WheelEvent("wheel", { deltaY: 40, bubbles: true, cancelable: true });
  Object.defineProperty(zoom, "ctrlKey", { value: true }); // happy-dom ignores ctrlKey in the init
  card.dispatchEvent(zoom);
  expect(zoom.defaultPrevented).toBe(false);
  stop();
});
