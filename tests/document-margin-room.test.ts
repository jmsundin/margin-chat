import { describe, expect, test } from "bun:test";
import { Window } from "happy-dom";

const browser = new Window({ url: "http://document-margin-room.test", width: 1440, height: 900 });
for (const name of ["window", "document", "HTMLElement", "Element", "getComputedStyle"]) {
  const value = name === "window" ? browser : (browser as any)[name];
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: name === "getComputedStyle" ? value.bind(browser) : value });
}
const { freeRoomRight } = await import("../client/src/components/DocumentMargin");

function box(element: Element, left: number, right: number, top = 0, bottom = 900) {
  (element as any).getBoundingClientRect = () => ({ left, right, top, bottom, width: right - left, height: bottom - top, x: left, y: top, toJSON() {} });
}
function layout(side: [number, number] | null) {
  document.body.innerHTML = `<div class="conversation-canvas"><div class="panel-slot" id="main"><aside class="document-margin"></aside></div>${side ? `<div class="panel-slot" id="side"></div>` : ""}</div>`;
  box(document.getElementById("main")!, 48, 888);
  const aside = document.querySelector<HTMLElement>(".document-margin")!;
  box(aside, 566, 886, 60, 880);
  if (side) box(document.getElementById("side")!, side[0], side[1]);
  return aside;
}

describe("room for an open margin note", () => {
  test("alone, it can widen toward the window's edge", () => {
    expect(freeRoomRight(layout(null))).toBe(1440 - 886 - 16);
  });
  test("with a document open beside it, it stops short of that document", () => {
    expect(freeRoomRight(layout([920, 1440]))).toBe(920 - 886 - 16);
  });
  test("a document beside it that already starts at the margin leaves no room", () => {
    expect(freeRoomRight(layout([890, 1440]))).toBe(0);
  });
});

describe("phone page-note tabs", () => {
  test("a tucked tab shows only the margin beside the text, less a small gap", async () => {
    const { tabPeekWidth, TAB_TEXT_GAP_PX, TAB_MIN_PEEK_PX } = await import("../client/src/components/DocumentMargin");
    expect(tabPeekWidth(389, 362)).toBe(27 - TAB_TEXT_GAP_PX);
    expect(tabPeekWidth(390, 388)).toBe(TAB_MIN_PEEK_PX);
  });
});
