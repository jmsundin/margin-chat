import assert from "node:assert/strict";
import { Window } from "happy-dom";

const browser = new Window({ url: "http://mobile-keyboard.test" });
browser.happyDOM.setWindowSize({ width: 390, height: 844 });
const mediaQueries: any[] = [];
const matchMedia = browser.matchMedia.bind(browser);
browser.matchMedia = (query) => { const media = matchMedia(query); mediaQueries.push(media); return media; };
for (const name of ["window", "document", "navigator", "HTMLElement", "Element", "Node", "Text", "Document", "DocumentFragment", "MutationObserver", "ResizeObserver", "Event", "MouseEvent", "KeyboardEvent", "Range", "DOMRect", "DOMParser", "getComputedStyle", "HTMLInputElement", "HTMLTextAreaElement", "ShadowRoot"]) {
  const value = name === "window" ? browser : (browser as any)[name];
  if (value !== undefined) Object.defineProperty(globalThis, name, { configurable: true, value: name === "getComputedStyle" ? value.bind(browser) : value });
}
Object.defineProperty(globalThis, "requestAnimationFrame", { configurable: true, value: (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0) });
Object.defineProperty(globalThis, "cancelAnimationFrame", { configurable: true, value: clearTimeout });
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const viewport = Object.assign(new browser.EventTarget(), { height: 844, width: 390, offsetTop: 0, offsetLeft: 0 });
Object.defineProperty(browser, "visualViewport", { configurable: true, value: viewport });
const { act, createElement, useState } = await import("react");
const { createRoot } = await import("react-dom/client");
const { MobileKeyboardProvider } = await import("../../client/src/components/MobileKeyboard");
const { default: DocumentPanel } = await import("../../client/src/components/DocumentPanel");
const { createMainConversation } = await import("../../client/src/initialState");
const { getEditableDocument } = await import("../../client/src/lib/editableDocument");
const initial = createMainConversation({ id: "mobile" });
initial.document = getEditableDocument(initial);
initial.document.blocks[0].content = "Select this passage before asking AI.";
const blockId = initial.document.blocks[0].id;
let changes = 0;
function Host() {
  const [conversation, setConversation] = useState(initial);
  return createElement(MobileKeyboardProvider, null, createElement(DocumentPanel, {
    conversation, isActive: true, isSubmitting: false, aiControls: null, recentModelSelections: [], anchors: [], theme: "light",
    onChange: (document) => { changes++; setConversation((current) => ({ ...current, document })); }, onRename() {},
    onSubmit() {}, onStop() {}, onSelection() {}, onClearSelection() {}, onOpenBranch() {}, onOpenNote() {}, onModelChange() {}, onUpload() {}, onRemoveAttachment() {},
    onAcceptVersion() {}, onUndoInsertion() {}, registerPanelRef() {}, registerAnchorRef() {}, registerBranchOriginRef() {},
  }));
}
const container = browser.document.createElement("div");
browser.document.body.append(container);
const root = createRoot(container as unknown as Element);
function element(selector: string): any { const found = browser.document.querySelector(selector); assert(found, `Missing ${selector}`); return found; }
async function click(selector: string) {
  await act(async () => {
    const target = element(selector);
    target.dispatchEvent(new browser.PointerEvent("pointerdown", { bubbles: true, cancelable: true, pointerType: "touch" }));
    target.click();
  });
}
async function touchButton(selector: string, gesture: "tap" | "drag" | "cancel" = "tap") {
  await act(async () => {
    const button = element(selector);
    const touch = new browser.Touch({ identifier: 1, target: button, clientX: 20, clientY: 20 });
    button.dispatchEvent(new browser.PointerEvent("pointerdown", { bubbles: true, cancelable: true, pointerType: "touch" }));
    button.dispatchEvent(new browser.TouchEvent("touchstart", { bubbles: true, cancelable: true, touches: [touch] }));
    if (gesture === "drag") button.dispatchEvent(new browser.TouchEvent("touchmove", {
      bubbles: true, cancelable: true, touches: [new browser.Touch({ identifier: 1, target: button, clientX: 60, clientY: 60 })],
    }));
    activationPhase = "touchend";
    button.dispatchEvent(new browser.TouchEvent(gesture === "cancel" ? "touchcancel" : "touchend", {
      bubbles: true, cancelable: true, touches: [], changedTouches: [touch],
    }));
    activationPhase = "after";
  });
}
let activationPhase = "idle";
async function resize(height: number, top: number) {
  await act(async () => { viewport.height = height; viewport.offsetTop = top; viewport.dispatchEvent(new browser.Event("resize")); });
}
try {
  await act(async () => root.render(createElement(Host)));
  await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
  const editor = element(`[data-document-block-id="${blockId}"] .tiptap`).editor;
  assert.equal(editor.view.dom.getAttribute("inputmode"), "none", "Mobile selection must not request the software keyboard.");
  await act(async () => { editor.view.dom.focus(); editor.commands.setTextSelection({ from: 1, to: 12 }); });
  const quote = browser.getSelection()!.toString();
  assert.equal(quote, "Select this");
  assert(element('[aria-label="Show keyboard"]'));
  const nativeFocus = editor.view.dom.focus.bind(editor.view.dom);
  const focusRequests: Array<{ phase: string; inputMode: string | null; options: unknown }> = [];
  editor.view.dom.focus = (options?: FocusOptions) => {
    focusRequests.push({ phase: activationPhase, inputMode: editor.view.dom.getAttribute("inputmode"), options });
    nativeFocus(options);
  };
  await touchButton('[aria-label="Show keyboard"]', "drag");
  assert.equal(editor.view.dom.getAttribute("inputmode"), "none", "Dragging across the control is not a keyboard request.");
  await touchButton('[aria-label="Show keyboard"]', "cancel");
  assert.equal(editor.view.dom.getAttribute("inputmode"), "none", "Cancelled touches don't open the keyboard.");
  await touchButton('[aria-label="Show keyboard"]');
  assert(focusRequests.some((request) => request.phase === "touchend" && request.inputMode === "text" && request.options === undefined),
    "Request native keyboard focus synchronously during touchend, after typing is enabled, without relying on a click or preventScroll.");
  await act(async () => element('[aria-label="Hide keyboard"]').dispatchEvent(new browser.MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 })));
  assert.equal(editor.view.dom.getAttribute("inputmode"), "text", "The compatibility click must not immediately hide the keyboard again.");
  assert.equal(browser.getSelection()!.toString(), quote, "Requesting the keyboard retains the passage for replacement.");
  assert.equal(editor.state.selection.from, 1);
  assert.equal(editor.state.selection.to, 12);
  assert.equal(changes, 0, "Keyboard toggles must not edit document content.");

  await resize(400, 80);
  assert.equal(element('[aria-label="Hide keyboard"]').style.top, "calc(424px - 0px)");
  await resize(844, 0);
  assert.equal(editor.view.dom.getAttribute("inputmode"), "none", "Dismissing the OS keyboard returns to selection mode.");
  await click('[aria-label="Show keyboard"]');
  await resize(400, 80);
  await click(`[data-document-block-id="${blockId}"] .rich-document-touch-actions [aria-label="Ask AI"]`);
  const prompt = element('[aria-label="AI prompt"]');
  const form = element(".document-ai-composer");
  assert.equal(container.contains(form), false, "The mobile prompt escapes document pane scrolling/clipping through a portal.");
  assert.equal(form.parentElement.className, "mobile-composer-viewport");
  assert.equal(form.parentElement.style.top, "80px");
  assert.equal(form.parentElement.style.height, "400px");
  assert.equal(form.querySelector("blockquote").textContent, "Select this");
  assert.equal(prompt.getAttribute("inputmode"), "text");

  await act(async () => {
    Object.getOwnPropertyDescriptor(browser.HTMLTextAreaElement.prototype, "value")!.set!.call(prompt, "Explain this");
    prompt.dispatchEvent(new browser.Event("input", { bubbles: true }));
  });
  prompt.setSelectionRange(2, 7);
  await touchButton('[aria-label="Hide keyboard"]');
  assert.equal(element(".document-ai-composer"), form, "The keyboard control does not dismiss or remount the prompt.");
  assert.equal(prompt.getAttribute("inputmode"), "none");
  assert.equal(prompt.selectionStart, 2);
  assert.equal(prompt.selectionEnd, 7);
  await resize(844, 0);
  await click('[aria-label="Show keyboard"]');
  await resize(360, 120);
  assert.equal(form.parentElement.style.height, "360px");
  assert.equal(form.parentElement.style.top, "120px");
  assert.equal(element('[aria-label="Hide keyboard"]').style.top, "calc(424px - 0px)");
  await act(async () => { viewport.offsetTop = 160; viewport.dispatchEvent(new browser.Event("scroll")); });
  assert.equal(form.parentElement.style.top, "160px", "The sheet follows visual viewport panning as well as resizing.");

  await click('[aria-label="Hide keyboard"]');
  await resize(844, 0);
  await click('[aria-label="Close AI prompt"]');
  assert.equal(browser.document.querySelector(".document-ai-composer"), null);
  assert.equal(editor.view.dom.getAttribute("inputmode"), "none");
  await act(async () => {
    browser.happyDOM.setWindowSize({ width: 1600, height: 1000 });
    // Happy DOM updates matches but doesn't emit media-query change events.
    mediaQueries.forEach((query) => query.dispatchEvent(new browser.Event("change")));
  });
  assert.equal(editor.view.dom.getAttribute("inputmode"), "text", "Desktop editing keeps normal keyboard behavior.");
  assert.equal(browser.document.querySelector(".mobile-keyboard-toggle"), null);
  console.log("Mobile keyboard and viewport integration passed");
} finally {
  await act(async () => root.unmount());
  await browser.happyDOM.close();
}
