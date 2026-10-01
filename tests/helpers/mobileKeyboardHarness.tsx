import assert from "node:assert/strict";
import { Window } from "happy-dom";
import type { DocumentAIRequest } from "../../client/src/lib/documentAI";

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
// The block editor is a lazy chunk; load it first so the panel renders it without a placeholder.
await import("../../client/src/components/RichDocumentEditor");
const { createMainConversation } = await import("../../client/src/initialState");
const { getEditableDocument } = await import("../../client/src/lib/editableDocument");
const initial = createMainConversation({ id: "mobile" });
initial.document = getEditableDocument(initial);
initial.document.blocks[0].content = "Select this passage before asking AI.";
const blockId = initial.document.blocks[0].id;
let changes = 0;
const submitted: DocumentAIRequest[] = [];
function Host() {
  const [conversation, setConversation] = useState(initial);
  return createElement(MobileKeyboardProvider, null, createElement(DocumentPanel, {
    conversation, isActive: true, isSubmitting: false, aiControls: null, recentModelSelections: [], anchors: [], theme: "light",
    onChange: (document) => { changes++; setConversation((current) => ({ ...current, document })); }, onRename() {},
    onSubmit(request) { submitted.push(request); }, onStop() {}, onSelection() {}, onClearSelection() {}, onOpenBranch() {}, onOpenNote() {}, onModelChange() {}, onUpload() {}, onRemoveAttachment() {},
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
  await touchButton('[aria-label="Show keyboard"]');
  await resize(400, 80);
  assert.equal(browser.document.activeElement, editor.view.dom);
  assert.equal(editor.view.dom.getAttribute("inputmode"), "text", "Ask is exercised while the document is actively being edited.");
  await click(`[data-document-block-id="${blockId}"] .rich-document-touch-actions [aria-label="Ask AI"]`);
  assert.notEqual(browser.document.activeElement, editor.view.dom, "Tapping Ask must end the source editor's input session instead of leaving it active behind the dock.");
  await resize(844, 0);
  const prompt = element('[aria-label="AI prompt"]');
  const form = element(".mobile-ai-composer");
  assert.equal(container.contains(form), false, "The mobile prompt escapes document pane scrolling/clipping through a portal.");
  assert.equal(form.parentElement.className, "mobile-composer-viewport");
  assert.equal(form.parentElement.style.height, "844px");
  assert.notEqual(browser.document.activeElement, prompt, "Opening Ask leaves the keyboard closed until the input is tapped.");
  assert.equal(prompt.getAttribute("inputmode"), "text");
  assert.equal(prompt.hasAttribute("data-mobile-keyboard"), false, "The prompt must not require a document keyboard toggle to type.");
  assert.equal(element('[aria-label="Generate response"]').disabled, true);
  assert.equal(form.querySelector("blockquote"), null, "Long selected text stays collapsed while composing.");
  assert.equal(form.querySelector('[aria-label="Response destination"]'), null, "Secondary controls do not consume the visible document area.");
  await click('[aria-label="Show selected text"]');
  assert.equal(form.querySelector("blockquote").textContent, "Select this");
  await click('button[aria-label="Prompt options"]');
  assert(form.querySelector('[aria-label="Response destination"]'));
  assert.equal(submitted.length, 0, "Opening context or options must not generate a response.");

  await act(async () => {
    prompt.focus();
    Object.getOwnPropertyDescriptor(browser.HTMLTextAreaElement.prototype, "value")!.set!.call(prompt, "Explain this");
    prompt.dispatchEvent(new browser.Event("input", { bubbles: true }));
  });
  assert.equal(browser.document.activeElement, prompt, "The AI input accepts normal direct focus.");
  assert.equal(browser.document.querySelector(".mobile-keyboard-toggle"), null, "The document keyboard control is not needed over a native prompt field.");
  assert.equal(element('button[aria-label="Prompt options"]').getAttribute("aria-expanded"), "false");
  assert.equal(editor.view.dom.getAttribute("inputmode"), "none", "Typing in an AI prompt does not enable document editing.");
  assert.equal(submitted.length, 0, "Typing alone must not start generation.");
  prompt.setSelectionRange(2, 7);
  await resize(400, 80);
  assert.equal(form.parentElement.style.top, "80px");
  assert.equal(form.parentElement.style.height, "400px");
  await resize(360, 120);
  assert.equal(element(".mobile-ai-composer"), form, "Keyboard resize must not remount the compact composer.");
  assert.equal(form.parentElement.style.height, "360px");
  assert.equal(form.parentElement.style.top, "120px");
  assert.equal(prompt.selectionStart, 2);
  assert.equal(prompt.selectionEnd, 7);
  await act(async () => { viewport.offsetTop = 160; viewport.dispatchEvent(new browser.Event("scroll")); });
  assert.equal(form.parentElement.style.top, "160px", "The dock follows visual viewport panning as well as resizing.");
  await resize(844, 0);
  assert.equal(prompt.value, "Explain this", "Closing the native keyboard retains the prompt draft.");
  await click('[aria-label="Generate response"]');
  assert.equal(submitted.length, 1);
  assert.equal(submitted[0].prompt, "Explain this");
  assert.equal(submitted[0].quote, "Select this");
  assert.equal(submitted[0].blockId, blockId);
  assert.equal(submitted[0].from, 0);
  assert.equal(submitted[0].to, 11);
  assert.equal(browser.document.querySelector(".mobile-ai-composer"), null);
  assert.equal(editor.view.dom.getAttribute("inputmode"), "none");
  assert.equal(changes, 0, "Opening and sending a prompt does not directly edit the source document.");
  const sourceBeforeShortcut = editor.getMarkdown();
  await act(async () => { editor.view.dom.focus(); editor.commands.setTextSelection(editor.state.doc.content.size - 1); });
  await touchButton('[aria-label="Show keyboard"]');
  await act(async () => editor.commands.insertContent(" "));
  const shortcut = new browser.InputEvent("beforeinput", { inputType: "insertText", data: " ", bubbles: true, cancelable: true });
  let shortcutPrompt: any;
  await act(async () => {
    editor.view.dom.dispatchEvent(shortcut);
    shortcutPrompt = element('[aria-label="AI prompt"]');
    assert.equal(browser.document.activeElement, shortcutPrompt, "A software-keyboard Space shortcut must focus the prompt before the input gesture returns.");
    assert.equal(shortcutPrompt.getAttribute("inputmode"), "text");
    // The next typed characters go to the focused prompt, not the document.
    const focused = browser.document.activeElement!;
    Object.getOwnPropertyDescriptor(browser.HTMLTextAreaElement.prototype, "value")!.set!.call(focused, "Continue this thought");
    focused.dispatchEvent(new browser.Event("input", { bubbles: true }));
  });
  assert(shortcut.defaultPrevented, "The second Space is consumed by the AI shortcut.");
  assert.equal(shortcutPrompt.value, "Continue this thought");
  assert.equal(editor.getMarkdown(), sourceBeforeShortcut, "Prompt typing must not leak into the document behind the dock.");
  assert.equal(editor.view.dom.getAttribute("inputmode"), "none", "Focusing the prompt returns the source editor to selection mode.");
  assert.equal(submitted.length, 1, "A shortcut opens a draft and still waits for Send.");
  await click('[aria-label="Close AI prompt"]');
  await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
  assert.equal(browser.document.querySelector(".mobile-ai-composer"), null);
  assert.equal(browser.document.activeElement, editor.view.dom, "Closing the prompt restores the insertion point in the source.");
  assert.equal(editor.view.dom.getAttribute("inputmode"), "none", "Closing the prompt leaves document selection usable without opening the keyboard.");

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
