import assert from "node:assert/strict";
import { Window } from "happy-dom";
const browser = new Window({ url: "http://document-margin.test" });
for (const name of ["window", "document", "navigator", "HTMLElement", "Element", "Node", "Event", "PointerEvent", "WheelEvent", "MutationObserver", "getComputedStyle"]) {
  const value = name === "window" ? browser : (browser as any)[name];
  Object.defineProperty(globalThis, name, { configurable: true, value: name === "getComputedStyle" ? value.bind(browser) : value });
}
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const { act, createElement, useRef } = await import("react");
const { createRoot } = await import("react-dom/client");
const { default: DocumentMargin } = await import("../../client/src/components/DocumentMargin");

// Layout is faked: each passage reports where it sits in the text, each note how tall it is.
const passageTops: Record<string, number> = { early: 100, late: 400, crowded: 120 };
const noteHeights: Record<string, number> = { about: 80, early: 150, late: 100, crowded: 60 };
Object.defineProperty(browser.HTMLElement.prototype, "offsetHeight", { configurable: true, get() { return noteHeights[this.dataset.marginNoteId] ?? 0; } });
browser.HTMLElement.prototype.getBoundingClientRect = function () {
  const ids = this.dataset.annotationBranches ? JSON.parse(this.dataset.annotationBranches) : [];
  const top = ids.length ? passageTops[ids[0]] - (this.closest(".document-body") as any).scrollTop : 0;
  return { top, bottom: top + 20, left: 0, right: 100, width: 100, height: 20, x: 0, y: top, toJSON() {} } as DOMRect;
};
const heights: number[] = [];
let ids = ["late", "about", "early"];
function Doc() {
  const bodyRef = useRef<HTMLDivElement>(null);
  return createElement("div", { className: "document-panel-content" },
    createElement("div", { className: "document-body", ref: bodyRef, style: { paddingTop: "20px" } },
      ...Object.keys(passageTops).map((id) => createElement("span", { key: id, className: "message-anchor", "data-annotation-branches": JSON.stringify([id]) }, id))),
    createElement(DocumentMargin, { bodyRef, documentId: "doc", label: "Notes for Doc", width: 320, activeId: "late",
      items: ids.map((id) => ({ id, anchored: id !== "about", node: createElement("p", null, `Note ${id}`) })),
      onHeightChange: (height: number) => heights.push(height) }));
}
const container = browser.document.createElement("div");
browser.document.body.append(container);
const root = createRoot(container as unknown as Element);
const top = (id: string) => Number.parseFloat((container.querySelector(`[data-margin-note-id="${id}"]`) as HTMLElement).style.top);
try {
  await act(async () => root.render(createElement(Doc)));
  assert.equal(container.querySelector(".document-margin")?.getAttribute("data-margin-notes-for"), "doc");
  assert.equal(top("about"), 20, "A note about the whole document sits at the top of the margin.");
  assert(container.querySelector('[data-margin-note-id="about"] .document-margin-label')?.textContent?.includes("About this document"));
  assert.equal(top("early"), 20 + 80 + 12, "A note whose passage sits beside the top note moves just below it.");
  assert.equal(top("late"), 396, "A note with room sits level with its passage.");
  assert.equal(heights.at(-1), 508, "The margin reports its height so the text can scroll to the last note.");
  assert.equal(container.querySelectorAll(".document-margin-links path").length, 2, "Each anchored note has a line to its passage.");
  assert.equal(container.querySelectorAll(".document-margin-links path.is-linked").length, 1, "The open note's line is drawn solid.");
  assert(container.querySelector("style")?.textContent?.includes(`'"late"'`), "The open note's passage is lit in the text.");

  ids = ["early", "crowded", "late"];
  await act(async () => root.render(createElement(Doc)));
  assert.equal(top("early"), 96);
  assert.equal(top("crowded"), 96 + 150 + 12, "Notes whose passages are close stack in passage order without overlapping.");
  assert.equal(top("late"), 396);
  console.log(JSON.stringify({ passed: true }));
} finally { await act(async () => root.unmount()); await browser.happyDOM.close(); }
