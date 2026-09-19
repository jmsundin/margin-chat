import assert from "node:assert/strict";
import { Window } from "happy-dom";
import type { GraphEvidenceRef } from "../../client/src/lib/graphExploration";

const browser = new Window({ url: "http://graph-source.test/" });
for (const name of ["window", "document", "navigator", "HTMLElement", "Element", "Node", "Event"]) {
  const value = name === "window" ? browser : (browser as any)[name];
  Object.defineProperty(globalThis, name, { configurable: true, value });
}
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const { act, createElement, Fragment } = await import("../../client/node_modules/react/index.js");
const { createRoot } = await import("../../client/node_modules/react-dom/client.js");
const { default: GraphSourceFocus } = await import("../../client/src/components/GraphSourceFocus");

let frameId = 0;
const frames = new Map<number, FrameRequestCallback>();
browser.requestAnimationFrame = (callback) => { frames.set(++frameId, callback); return frameId; };
browser.cancelAnimationFrame = (id) => { frames.delete(id); };
const container = browser.document.createElement("div");
browser.document.body.append(container);
const root = createRoot(container as unknown as Element);
const messageId = 'quoted-message"]';
const revealed: string[] = [];
let source: GraphEvidenceRef | undefined;

function Reader() {
  return createElement(Fragment, null,
    createElement(GraphSourceFocus, {
      source,
      getPanelElement: () => container.querySelector(".chat-panel") as unknown as HTMLElement,
    }),
    createElement("article", { className: "chat-panel" },
      createElement("div", { className: "panel-body", ref: (node: HTMLElement | null) => {
        if (!node) return;
        Object.defineProperties(node, {
          clientHeight: { configurable: true, value: 400 },
          clientTop: { configurable: true, value: 2 },
          scrollHeight: { configurable: true, value: 1500 },
        });
        node.getBoundingClientRect = () => new browser.DOMRect(0, 100, 600, 404) as unknown as DOMRect;
      } },
        ...[messageId, "other"].map((id) => createElement("section", {
          key: id, "data-message-row-id": id, tabIndex: -1,
          ref: (node: HTMLElement | null) => {
            if (!node) return;
            node.scrollIntoView = () => { throw new Error("Source focus must never scroll map ancestors"); };
            node.getBoundingClientRect = () => new browser.DOMRect(0, 102 + (id === messageId ? 700 : 1450) - (node.closest<HTMLElement>(".panel-body")?.scrollTop ?? 0), 560, 80) as unknown as DOMRect;
            node.focus = (options) => {
              assert.equal(options?.preventScroll, true, "Focusing the message must preserve the outer viewport");
              revealed.push(id);
              browser.HTMLElement.prototype.focus.call(node as any, options);
            };
          },
        }, id)),
      ),
    ),
  );
}
async function render() { await act(async () => { root.render(createElement(Reader)); }); }
async function flushFrames() {
  await act(async () => {
    const callbacks = [...frames.values()]; frames.clear();
    callbacks.forEach((callback) => callback(0));
  });
}

try {
  await render();
  assert.equal(frames.size, 0, "Ordinary dock navigation preserves its existing scroll position");
  assert.equal(container.childElementCount, 1, "The chat panel remains the reader's direct child");
  const body = container.querySelector(".panel-body")!;
  body.scrollTop = 100;
  container.scrollTop = 37;

  source = { conversationId: "chat", sourceKind: "message", messageId, quote: "Source phrase" };
  await render();
  assert.deepEqual(revealed, [], "Source jumps wait until the panel has mounted");
  assert.equal(body.scrollTop, 100);
  await flushFrames();
  assert.deepEqual(revealed, [messageId], "Source IDs are matched literally, including selector characters");
  assert.equal(body.scrollTop, 540, "The source message is centered within the reader, accounting for its border");
  assert.equal(container.scrollTop, 37, "Source navigation leaves the outer workspace scroll unchanged");
  assert.equal((browser.document.activeElement as any)?.dataset.messageRowId, messageId);

  source = { ...source };
  body.scrollTop = 250;
  await render(); await flushFrames();
  assert.equal(revealed.length, 1, "Unrelated reader updates do not keep snapping to the source");
  assert.equal(body.scrollTop, 250);

  source = { ...source, messageId: "missing" };
  await render(); await flushFrames();
  assert.equal(revealed.length, 1, "A deleted source does not focus an unrelated message");
  assert.equal(body.scrollTop, 250);

  source = { ...source, messageId: "other" };
  await render(); await flushFrames();
  assert.equal(body.scrollTop, 1100, "A source near the end clamps to the reader's available scroll range");
  assert.equal(container.scrollTop, 37);
  body.scrollTop = 800;
  source = { conversationId: "chat", sourceKind: "standalone-note", noteId: "body" };
  await render(); await flushFrames();
  assert.equal(body.scrollTop, 0, "Standalone source notes open at the beginning");

  source = { conversationId: "chat", sourceKind: "message", messageId: "other" };
  await render();
  assert.equal(frames.size, 1);
  await act(async () => { root.unmount(); });
  assert.equal(frames.size, 0, "Closing the reader cancels pending source navigation");
  console.log("Graph source reader focus checks passed.");
} finally {
  await browser.happyDOM.close();
}
