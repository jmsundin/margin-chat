import { describe, expect, test } from "bun:test";
import { Window } from "happy-dom";

const browser = new Window({ url: "http://long-press.test" });
for (const name of ["window", "document", "HTMLElement", "Element", "Event"]) {
  const value = name === "window" ? browser : (browser as any)[name];
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
}
const { watchLongPress, LONG_PRESS_MS, LONG_PRESS_SETTLE_MS } = await import("../client/src/lib/longPress");

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
function touch(target: Element, type: string, points: Array<[number, number]>) {
  const event = new (browser as any).Event(type, { bubbles: true });
  Object.defineProperty(event, "touches", { value: points.map(([clientX, clientY]) => ({ clientX, clientY })) });
  target.dispatchEvent(event);
}
function setup(enabled = () => true) {
  document.body.innerHTML = `<div id="editor"><p id="text">Some words</p><a id="link" href="/x">a link</a></div>`;
  const presses: Array<{ x: number; y: number }> = [];
  const stop = watchLongPress(document.getElementById("editor") as HTMLElement, { enabled, onLongPress: ({ x, y }) => presses.push({ x, y }) });
  return { presses, stop, text: document.getElementById("text")!, link: document.getElementById("link")! };
}

describe("press and hold opens the app's menu at that spot", () => {
  test("a hold, then lifting the finger, fires once at the press point", async () => {
    const { presses, text, stop } = setup();
    touch(text, "touchstart", [[40, 60]]);
    await wait(LONG_PRESS_MS + 20);
    expect(presses).toEqual([]); // not while the finger is still down
    touch(text, "touchend", []);
    await wait(LONG_PRESS_SETTLE_MS + 20);
    expect(presses).toEqual([{ x: 40, y: 60 }]);
    stop();
  });

  test("a quick tap does nothing", async () => {
    const { presses, text, stop } = setup();
    touch(text, "touchstart", [[40, 60]]);
    await wait(100);
    touch(text, "touchend", []);
    await wait(LONG_PRESS_MS + LONG_PRESS_SETTLE_MS);
    expect(presses).toEqual([]);
    stop();
  });

  test("a finger that moves is scrolling, not holding", async () => {
    const { presses, text, stop } = setup();
    touch(text, "touchstart", [[40, 60]]);
    touch(text, "touchmove", [[40, 90]]);
    await wait(LONG_PRESS_MS + 20);
    touch(text, "touchend", []);
    await wait(LONG_PRESS_SETTLE_MS + 20);
    expect(presses).toEqual([]);
    stop();
  });

  test("a finger that drifts a few pixels while holding still counts as a hold", async () => {
    const { presses, text, stop } = setup();
    touch(text, "touchstart", [[40, 60]]);
    touch(text, "touchmove", [[48, 67]]);
    await wait(LONG_PRESS_MS + 20);
    touch(text, "touchend", []);
    await wait(LONG_PRESS_SETTLE_MS + 20);
    expect(presses).toEqual([{ x: 40, y: 60 }]);
    stop();
  });

  test("the press tells the caller what the finger is on", async () => {
    document.body.innerHTML = `<div id="page"><p id="text">Words</p></div>`;
    const seen: Array<string | undefined> = [];
    const stop = watchLongPress(document.getElementById("page") as HTMLElement, { enabled: (target) => { seen.push(target?.id); return true; }, onLongPress: () => {} });
    touch(document.getElementById("text")!, "touchstart", [[1, 1]]);
    touch(document.getElementById("text")!, "touchend", []);
    expect(seen).toEqual(["text"]);
    stop();
  });

  test("iOS cancelling the touch after the hold still counts as the lift", async () => {
    const { presses, text, stop } = setup();
    touch(text, "touchstart", [[10, 20]]);
    await wait(LONG_PRESS_MS + 20);
    touch(text, "touchcancel", []);
    await wait(LONG_PRESS_SETTLE_MS + 20);
    expect(presses).toEqual([{ x: 10, y: 20 }]);
    stop();
  });

  test("links keep the phone's own menu, two fingers are a pinch, and it stays off when disabled", async () => {
    const link = setup();
    touch(link.link, "touchstart", [[5, 5]]);
    await wait(LONG_PRESS_MS + 20);
    touch(link.link, "touchend", []);
    touch(link.text, "touchstart", [[5, 5], [50, 50]]);
    await wait(LONG_PRESS_MS + 20);
    touch(link.text, "touchend", []);
    await wait(LONG_PRESS_SETTLE_MS + 20);
    expect(link.presses).toEqual([]);
    link.stop();

    const off = setup(() => false);
    touch(off.text, "touchstart", [[5, 5]]);
    await wait(LONG_PRESS_MS + 20);
    touch(off.text, "touchend", []);
    await wait(LONG_PRESS_SETTLE_MS + 20);
    expect(off.presses).toEqual([]);
    off.stop();
  });
});
