import assert from "node:assert/strict";
import { Window } from "happy-dom";
import type { DocumentDockNode } from "../../client/src/types";

const browser = new Window({ url: "http://document-dock.test" });
const workspaceStyles = browser.document.createElement("style");
workspaceStyles.textContent = await Bun.file(new URL("../../client/src/document-workspace.css", import.meta.url)).text();
browser.document.head.append(workspaceStyles);
for (const name of ["window", "document", "navigator", "HTMLElement", "HTMLDivElement", "HTMLInputElement", "HTMLSelectElement", "Element", "Node", "Document", "Event", "MouseEvent", "PointerEvent", "KeyboardEvent", "DOMRect", "ResizeObserver"]) {
  Object.defineProperty(globalThis, name, { configurable: true, value: name === "window" ? browser : (browser as any)[name] });
}
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { default: DocumentDock } = await import("../../client/src/components/DocumentDock");
const { default: DocumentMenu } = await import("../../client/src/components/DocumentMenu");
const { default: DocumentWorkspaceLayout } = await import("../../client/src/components/DocumentWorkspaceLayout");
const { createMainConversation } = await import("../../client/src/initialState");
const { filterDocumentDock, listPinnedDocumentIds, removePinnedDocument } = await import("../../client/src/lib/documentDock");
const conversations = Object.fromEntries(["a", "b", "hidden"].map((id) => [id, { ...createMainConversation({ id }), title: id === "a" ? "Reference" : id === "b" ? "Draft" : "Hidden family" }]));
let tree: DocumentDockNode = {
  type: "split", id: "outer", direction: "vertical", ratio: 0.6,
  first: { type: "pane", documentId: "hidden", scope: "family" },
  second: { type: "split", id: "visible", direction: "horizontal", ratio: 0.5, first: { type: "pane", documentId: "a" }, second: { type: "pane", documentId: "b" } },
};
let selected = "a";
let updates = 0;
type DockPosition = "left" | "right" | "top" | "bottom";
let workspacePlacement = false;
let dockPosition: DockPosition = "left";
let dockWidth = 0.4;
let positionUpdates = 0;
const scoped: string[] = [];
const controlsClicked: string[] = [];
const unpinned: string[] = [];
const checks: string[] = [];
const container = browser.document.createElement("div");
browser.document.body.append(container);
const root = createRoot(container as unknown as Element);
const visibleDocumentIds = ["a", "b"];
function render() {
  const dock = createElement(DocumentDock, {
    tree, conversations, activeDocumentId: selected, visibleDocumentIds,
    dockPosition,
    onMoveDock: workspacePlacement ? (position) => { dockPosition = position; positionUpdates++; render(); } : undefined,
    onSelect(id) { selected = id; },
    onUnpin(id) { unpinned.push(id); tree = removePinnedDocument(tree, id)!; render(); },
    onToggleScope(id) { scoped.push(id); },
    onChange(next) { assert(next); tree = next; updates++; render(); },
    renderDocument(conversation) { return createElement("div", { className: "document-body" }, createElement("textarea", { "aria-label": `Editor ${conversation.id}`, defaultValue: conversation.title })); },
    renderDocumentMenu(conversation) { return createElement(DocumentMenu, { conversation, pinned: true, onTogglePin: () => {} }); },
    renderDocumentControls(conversation) { return createElement("button", { type: "button", "aria-label": `Children for ${conversation.title}`, onClick: () => controlsClicked.push(conversation.id) }, "1⌄"); },
  });
  root.render(workspacePlacement ? createElement(DocumentWorkspaceLayout, {
    dock, position: dockPosition, width: dockWidth,
    onWidthChange(width) { dockWidth = width; render(); },
    children: createElement("div", { className: "conversation-canvas" }, "Other documents"),
  }) : dock);
}
function element(selector: string): any { const found = container.querySelector(selector); assert(found, `Missing ${selector}`); return found; }
function pane(id: string): any { return element(`[data-dock-document-id="${id}"]`); }
function grip(id: string): any { return element(`[data-dock-move-id="${id}"]`); }
async function click(target: any) { await act(async () => target.click()); }
async function key(target: any, value: string) { await act(async () => target.dispatchEvent(new browser.KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true }))); }
async function pointer(target: any, type: string, x: number, y: number) {
  await act(async () => target.dispatchEvent(new browser.PointerEvent(type, { pointerId: 7, pointerType: "touch", isPrimary: true, button: 0, clientX: x, clientY: y, bubbles: true, cancelable: true })));
}
let hitElement: any = null;
Object.defineProperty(browser.document, "elementFromPoint", { configurable: true, value: () => hitElement });

try {
  await act(async () => render());
  assert.deepEqual([...container.querySelectorAll("[data-dock-document-id]")].map((node) => node.getAttribute("data-dock-document-id")), ["a", "b"]);
  assert.equal(container.querySelector('[data-dock-document-id="hidden"]'), null);
  assert.equal(element('[role="separator"]').getAttribute("aria-orientation"), "vertical");
  await act(async () => element('[aria-label="Editor b"]').focus());
  assert.equal(selected, "b");
  checks.push("hidden family panes are filtered while focusing another editor selects it");

  const menuTrigger = element('[aria-label="Options for Reference"]');
  const menuSlot = pane("a").querySelector(".document-dock-menu");
  assert.equal(pane("a").querySelector(".document-dock-actions").lastElementChild, menuSlot);
  const beforeMenuGesture = tree;
  hitElement = pane("b");
  hitElement.getBoundingClientRect = () => new browser.DOMRect(0, 0, 800, 600);
  await pointer(menuSlot, "pointerdown", 100, 100);
  await pointer(browser, "pointermove", 790, 300);
  await pointer(browser, "pointerup", 790, 300);
  assert.equal(tree, beforeMenuGesture);
  assert.equal(container.querySelector(".document-dock.is-arranging"), null);
  await act(async () => menuTrigger.focus());
  await click(menuTrigger);
  const menuPopup = browser.document.querySelector('[role="menu"][aria-label="Options for Reference"]');
  assert(menuPopup);
  assert(menuPopup.contains(browser.document.activeElement));
  assert.equal(selected, "a");
  await key(browser.document.activeElement, "Escape");
  assert.equal(browser.document.querySelector('[role="menu"]'), null);
  assert.equal(browser.document.activeElement, menuTrigger);
  checks.push("the rightmost header menu opens without dragging and restores focus on dismissal");

  const childrenControl = element('[aria-label="Children for Reference"]');
  assert(childrenControl.closest(".document-dock-pane-header"));
  assert.equal(childrenControl.closest(".document-dock-pane-body"), null);
  await pointer(childrenControl.parentElement, "pointerdown", 100, 100);
  await pointer(browser, "pointermove", 790, 300);
  await pointer(browser, "pointerup", 790, 300);
  assert.equal(tree, beforeMenuGesture);
  await click(childrenControl);
  assert.deepEqual(controlsClicked, ["a"]);
  checks.push("document controls live in the header and activate without starting pane movement");

  const editor = element('[aria-label="Editor a"]');
  editor.value = "Typing stays intact while resizing";
  await key(element('[role="separator"]'), "ArrowRight");
  assert.equal(element('[role="separator"]').getAttribute("aria-valuenow"), "52");
  assert.equal(element('[aria-label="Editor a"]'), editor);
  assert.equal(editor.value, "Typing stays intact while resizing");
  assert.equal(tree.type, "split");
  assert.equal(tree.ratio, 0.6);
  assert.equal(tree.first.type === "pane" && tree.first.documentId, "hidden");
  await key(element('[role="separator"]'), "End");
  assert.equal(element('[role="separator"]').getAttribute("aria-valuenow"), "80");
  await key(element('[role="separator"]'), "Home");
  assert.equal(element('[role="separator"]').getAttribute("aria-valuenow"), "20");
  checks.push("keyboard resizing preserves editor state and hidden layout while enforcing bounds");

  const split = element('[data-dock-split-id="visible"]');
  split.getBoundingClientRect = () => new browser.DOMRect(0, 0, 800, 600);
  let beforeUpdates = updates;
  await pointer(element('[role="separator"]'), "pointerdown", 160, 200);
  await pointer(browser, "pointermove", 560, 200);
  assert.equal(updates, beforeUpdates);
  assert.equal(element('[role="separator"]').getAttribute("aria-valuenow"), "70");
  await pointer(browser, "pointerup", 600, 200);
  assert.equal(updates, beforeUpdates + 1);
  assert.equal(element('[role="separator"]').getAttribute("aria-valuenow"), "75");
  checks.push("touch divider dragging previews locally and persists its final release position exactly once");

  const beforeCancel = tree;
  await pointer(element('[role="separator"]'), "pointerdown", 600, 200);
  await pointer(browser, "pointermove", 240, 200);
  await key(browser, "Escape");
  assert.equal(tree, beforeCancel);
  assert.equal(element('[role="separator"]').getAttribute("aria-valuenow"), "75");
  await pointer(browser, "pointerup", 240, 200);
  assert.equal(tree, beforeCancel);
  checks.push("Escape cancels resizing without changing the saved layout");

  await click(grip("a"));
  assert(element('[role="dialog"][aria-label="Move pinned document"]'));
  const options = [...element('[aria-label="Destination pane"]').options].map((item: any) => item.value);
  assert.deepEqual(options, ["b"]);
  pane("a").querySelector(".document-body").scrollTop = 210;
  pane("b").querySelector(".document-body").scrollTop = 310;
  await click([...container.querySelectorAll(".document-dock-move-actions button")].find((button) => button.textContent === "Move below"));
  assert.deepEqual(listPinnedDocumentIds(tree), ["hidden", "b", "a"]);
  assert.equal(element('[role="separator"]').getAttribute("aria-orientation"), "horizontal");
  assert.equal(browser.document.activeElement, grip("a"));
  assert.equal(container.querySelector('[role="dialog"]'), null);
  assert.equal(pane("a").querySelector(".document-body").scrollTop, 210);
  assert.equal(pane("b").querySelector(".document-body").scrollTop, 310);
  checks.push("placement controls move only between visible panes, preserving scroll positions and keyboard focus");

  await click(grip("a"));
  await pointer(element('[aria-label="Editor b"]'), "pointerdown", 100, 100);
  assert.equal(container.querySelector('[role="dialog"]'), null);
  await click(grip("a"));
  await key(element('[aria-label="Destination pane"]'), "Escape");
  assert.equal(container.querySelector('[role="dialog"]'), null);
  assert.equal(browser.document.activeElement, grip("a"));
  checks.push("placement popups dismiss outside and with Escape");

  hitElement = pane("b");
  hitElement.getBoundingClientRect = () => new browser.DOMRect(0, 0, 800, 600);
  beforeUpdates = updates;
  await pointer(grip("a"), "pointerdown", 50, 500);
  await pointer(browser, "pointermove", 790, 300);
  assert(element(".document-dock-drop.is-right"));
  assert.equal(updates, beforeUpdates);
  await pointer(browser, "pointerup", 790, 300);
  assert.equal(updates, beforeUpdates + 1);
  assert.equal(container.querySelector(".document-dock-drop"), null);
  assert.equal(element('[role="separator"]').getAttribute("aria-orientation"), "vertical");
  assert.equal(filterDocumentDock(tree, (id) => id === "hidden")?.type, "pane");
  assert.equal(pane("a").querySelector(".document-body").scrollTop, 210);
  assert.equal(pane("b").querySelector(".document-body").scrollTop, 310);
  await click(grip("a"));
  assert(element('[role="dialog"][aria-label="Move pinned document"]'), "Keyboard activation works immediately after dragging.");
  await key(element('[aria-label="Destination pane"]'), "Escape");
  checks.push("touch pane dragging previews the drop edge and preserves hidden panes on commit");

  hitElement = pane("b");
  hitElement.getBoundingClientRect = () => new browser.DOMRect(0, 0, 800, 600);
  const beforeMoveCancel = tree;
  await pointer(grip("a"), "pointerdown", 50, 500);
  await pointer(browser, "pointermove", 400, 10);
  assert(element(".document-dock-drop.is-top"));
  await pointer(browser, "pointercancel", 400, 10);
  assert.equal(tree, beforeMoveCancel);
  assert.equal(container.querySelector(".document-dock-drop"), null);
  await pointer(grip("a"), "pointerdown", 50, 500);
  await pointer(browser, "pointermove", 400, 10);
  assert(element(".document-dock-drop.is-top"));
  hitElement = null;
  await pointer(browser, "pointerup", 1000, 800);
  assert.equal(tree, beforeMoveCancel, "Releasing outside the dock must not commit a stale drop target.");
  assert.equal(container.querySelector(".document-dock-drop"), null);
  checks.push("canceled touch gestures and releases outside the dock leave the saved grid intact");

  assert.equal(element('[aria-label="Keep Reference visible across documents"]').getAttribute("aria-pressed"), "true");
  await click(element('[aria-label="Keep Reference visible across documents"]'));
  assert.deepEqual(scoped, ["a"]);
  checks.push("the scope button exposes cross-document pin state and calls its handler");

  await click(element('[aria-label="Unpin document: Reference"]'));
  assert.deepEqual(unpinned, ["a"]);
  assert.deepEqual(listPinnedDocumentIds(tree), ["hidden", "b"]);
  assert.equal(container.querySelector('[data-dock-document-id="a"]'), null);
  assert.equal(container.querySelector('[role="separator"]'), null);
  checks.push("unpinning removes the chosen pane and collapses its empty visible split");

  workspacePlacement = true;
  await act(async () => render());
  const workspace = element(".document-workspace-layout");
  workspace.getBoundingClientRect = () => new browser.DOMRect(100, 80, 1000, 600);
  const singleEditor = element('[aria-label="Editor b"]');
  singleEditor.value = "Unsaved writing in a single pinned document";
  pane("b").querySelector(".document-body").scrollTop = 180;
  const singlePaneTree = tree;
  for (const position of ["left", "right", "top", "bottom"] as DockPosition[]) {
    await click(grip("b"));
    assert.equal(container.querySelector('[aria-label="Destination pane"]'), null);
    assert.equal(element(`[aria-label="Move pinned document to ${dockPosition}"]`).getAttribute("aria-pressed"), "true");
    await click(element(`[aria-label="Move pinned document to ${position}"]`));
    assert.equal(dockPosition, position);
    assert.equal(container.querySelector('[role="dialog"]'), null);
    assert.equal(browser.document.activeElement, grip("b"));
    assert.equal(element('[aria-label="Resize pinned document area"]').getAttribute("aria-orientation"), position === "top" || position === "bottom" ? "horizontal" : "vertical");
  }
  checks.push("one visible pane can move to all four workspace positions using accessible placement controls");

  const points: Record<DockPosition, [number, number]> = { left: [110, 380], right: [1090, 380], top: [600, 90], bottom: [600, 670] };
  hitElement = element(".document-workspace-scrolling");
  for (const position of ["left", "right", "top", "bottom"] as DockPosition[]) {
    const before = positionUpdates;
    await pointer(grip("b"), "pointerdown", 200, 150);
    await pointer(browser, "pointermove", ...points[position]);
    assert(element(`.document-workspace-drop.is-${position}`));
    assert.equal(positionUpdates, before, "Moving the pointer only previews the placement.");
    await pointer(browser, "pointerup", ...points[position]);
    assert.equal(positionUpdates, before + 1);
    assert.equal(dockPosition, position);
    assert.equal(container.querySelector(".document-workspace-drop"), null);
  }
  checks.push("a single pinned pane drags to every workspace edge with a preview and one completed update");

  const beforeFinalRelease = positionUpdates;
  await pointer(grip("b"), "pointerdown", 200, 150);
  await pointer(browser, "pointermove", ...points.left);
  assert(element(".document-workspace-drop.is-left"));
  await pointer(browser, "pointerup", ...points.right);
  assert.equal(positionUpdates, beforeFinalRelease + 1);
  assert.equal(dockPosition, "right", "The pointer release position wins over the last preview.");
  checks.push("single-pane docking commits the final release edge instead of a stale preview");

  const beforeCanceledPositions = positionUpdates;
  for (const cancel of ["Escape", "pointercancel", "blur", "outside"]) {
    await pointer(grip("b"), "pointerdown", 200, 150);
    await pointer(browser, "pointermove", ...points.top);
    assert(element(".document-workspace-drop.is-top"));
    if (cancel === "Escape") await key(browser, "Escape");
    else if (cancel === "blur") await act(async () => browser.dispatchEvent(new browser.Event("blur")));
    else if (cancel === "outside") await pointer(browser, "pointerup", 1200, 750);
    else await pointer(browser, "pointercancel", ...points.top);
    await pointer(browser, "pointerup", 1200, 750);
    assert.equal(positionUpdates, beforeCanceledPositions);
    assert.equal(dockPosition, "right");
    assert.equal(container.querySelector(".document-workspace-drop"), null);
  }
  assert.equal(tree, singlePaneTree, "Repositioning the workspace preserves hidden panes and the complete split tree.");
  assert.equal(element('[aria-label="Editor b"]'), singleEditor);
  assert.equal(singleEditor.value, "Unsaved writing in a single pinned document");
  assert.equal(pane("b").querySelector(".document-body").scrollTop, 180);
  checks.push("canceled single-pane drags preserve saved placement, hidden panes, editor identity, and reading position");

  const growKeys: Record<DockPosition, string> = { left: "ArrowRight", right: "ArrowLeft", top: "ArrowDown", bottom: "ArrowUp" };
  for (const position of ["left", "right", "top", "bottom"] as DockPosition[]) {
    dockPosition = position;
    dockWidth = 0.4;
    await act(async () => render());
    await key(element('[aria-label="Resize pinned document area"]'), growKeys[position]);
    assert(Math.abs(dockWidth - 0.43) < 0.00001, `Resizing ${position} follows the physical divider direction.`);
    dockWidth = 0.4;
    await act(async () => render());
    const horizontal = position === "left" || position === "right";
    const direction = position === "right" || position === "bottom" ? -1 : 1;
    await pointer(element('[aria-label="Resize pinned document area"]'), "pointerdown", 600, 380);
    await pointer(browser, "pointermove", 600 + (horizontal ? 100 * direction : 0), 380 + (horizontal ? 0 : 60 * direction));
    assert.equal(dockWidth, 0.4, "Divider movement only previews the new size.");
    await pointer(browser, "pointerup", 600 + (horizontal ? 150 * direction : 0), 380 + (horizontal ? 0 : 90 * direction));
    assert(Math.abs(dockWidth - 0.55) < 0.00001, `Dragging the ${position} divider saves the final proportion.`);
  }
  checks.push("resizing works in the correct direction after moving to any workspace edge");
  workspacePlacement = false;
  visibleDocumentIds.splice(0, visibleDocumentIds.length, 'a', 'b', 'hidden');
  tree = { type: 'split', id: 'stack', direction: 'vertical', ratio: .6,
    first: { type: 'split', id: 'nested-stack', direction: 'vertical', ratio: .5,
      first: { type: 'pane', documentId: 'a' }, second: { type: 'pane', documentId: 'b' } },
    second: { type: 'pane', documentId: 'hidden' } };
  await act(async () => render());
  element('[data-dock-split-id="stack"]').getBoundingClientRect = () => new browser.DOMRect(0, 0, 400, 600);
  element('[data-dock-split-id="nested-stack"]').getBoundingClientRect = () => new browser.DOMRect(0, 0, 400, 356);
  const divider = element('[data-dock-split-id="nested-stack"] > .document-dock-divider');
  divider.getBoundingClientRect = () => new browser.DOMRect(0, 175, 400, 7);
  const keptEditor = element('[aria-label="Editor a"]');
  keptEditor.value = 'Keep this draft while stacking';
  pane('a').querySelector('.document-body').scrollTop = 180;
  const originalStack = tree;
  const beforeStackUpdates = updates;
  await pointer(divider, 'pointerdown', 200, 178);
  await pointer(browser, 'pointermove', 200, 1000);
  assert.equal(updates, beforeStackUpdates);
  assert.equal(element('[data-dock-split-id="stack"] > .document-dock-divider').getAttribute('aria-valuenow'), '100');
  await key(browser, 'Escape');
  assert.equal(tree, originalStack);
  await pointer(divider, 'pointerdown', 200, 178);
  await pointer(browser, 'pointerup', 200, 1000);
  assert.equal(updates, beforeStackUpdates + 1);
  assert(tree.type === 'split' && tree.first.type === 'split');
  assert.equal(tree.ratio, .8);
  assert.equal(tree.first.ratio, .8);
  assert.equal(element('[aria-label="Editor a"]'), keptEditor);
  assert.equal(keptEditor.value, 'Keep this draft while stacking');
  assert.equal(pane('a').querySelector('.document-body').scrollTop, 180);
  await key(divider, 'Home');
  assert(tree.type === 'split' && tree.first.type === 'split');
  assert.equal(tree.first.ratio, .2);
  assert.equal(element('[aria-label="Editor a"]'), keptEditor);
  checks.push('nested vertical dividers push neighboring content into headers, cancel safely, and expand again without replacing editors');
  console.log(JSON.stringify({ checks }));
} finally {
  await act(async () => root.unmount());
  browser.happyDOM.abort();
}
