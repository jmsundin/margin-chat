import assert from "node:assert/strict";
import { Window } from "happy-dom";

const browser = new Window({ url: "http://dictation.test" });
for (const name of ["window", "document", "navigator", "HTMLElement", "HTMLInputElement", "HTMLTextAreaElement", "Element", "Node", "Text", "Document", "DocumentFragment", "MutationObserver", "ResizeObserver", "Event", "InputEvent", "MouseEvent", "KeyboardEvent", "Range", "DOMRect", "DOMParser", "ShadowRoot", "getComputedStyle", "DOMException"]) {
  const value = name === "window" ? browser : (browser as any)[name];
  if (value !== undefined) Object.defineProperty(globalThis, name, { configurable: true, value: typeof value === "function" && name === "getComputedStyle" ? value.bind(browser) : value });
}
browser.requestAnimationFrame = () => 1;
browser.cancelAnimationFrame = () => undefined;
Object.defineProperty(globalThis, "requestAnimationFrame", { configurable: true, value: browser.requestAnimationFrame });
Object.defineProperty(globalThis, "cancelAnimationFrame", { configurable: true, value: browser.cancelAnimationFrame });
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

// A microphone that "records" one chunk of audio.
const tracksStopped: string[] = [];
class FakeMediaRecorder {
  static isTypeSupported = (type: string) => type === "audio/webm;codecs=opus";
  state: "inactive" | "recording" = "inactive";
  mimeType: string;
  listeners = new Map<string, ((event: any) => void)[]>();
  constructor(_stream: unknown, options: { mimeType?: string }) { this.mimeType = options.mimeType ?? ""; }
  addEventListener(type: string, listener: (event: any) => void) { this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]); }
  emit(type: string, event: any) { for (const listener of this.listeners.get(type) ?? []) listener(event); }
  start() { this.state = "recording"; }
  stop() {
    this.state = "inactive";
    this.emit("dataavailable", { data: new Blob([new Uint8Array(2048)], { type: this.mimeType }) });
    this.emit("stop", {});
  }
}
Object.defineProperty(globalThis, "MediaRecorder", { configurable: true, value: FakeMediaRecorder });
Object.defineProperty(browser.navigator, "mediaDevices", { configurable: true, value: {
  getUserMedia: async () => ({ getTracks: () => [{ stop: () => tracksStopped.push("audio") }] }),
} });
const requests: { url: string; contentType: string | null; size: number }[] = [];
let transcript = "hello world";
globalThis.fetch = (async (url: string, init: RequestInit) => {
  requests.push({ url: String(url), contentType: new Headers(init.headers).get("Content-Type"), size: (init.body as Blob).size });
  return Response.json({ text: transcript });
}) as typeof fetch;

const { act, createElement, useState } = await import("react");
const { createRoot } = await import("react-dom/client");
const { EditorView } = await import("@codemirror/view");
const { EditorState } = await import("@codemirror/state");
const { Editor } = await import("@tiptap/core");
const { default: StarterKit } = await import("@tiptap/starter-kit");
const { insertDictation, joinDictation, findDictationTarget, isDictationShortcut } = await import("../../client/src/lib/dictation");
const { isApplePlatform } = await import("../../client/src/lib/workspaceViewShortcuts");
const { default: DictationControl } = await import("../../client/src/components/DictationControl");

const checks: string[] = [];
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

assert.equal(joinDictation("d", "next words"), " next words");
assert.equal(joinDictation(" ", "next"), "next");
assert.equal(joinDictation("d", ", then"), ", then");
assert.equal(joinDictation("", "  "), "");
assert.equal(isDictationShortcut({ code: "Space", metaKey: true, ctrlKey: false, shiftKey: true, altKey: false }, true), true);
assert.equal(isDictationShortcut({ code: "Space", metaKey: false, ctrlKey: true, shiftKey: true, altKey: false }, false), true);
assert.equal(isDictationShortcut({ code: "Space", metaKey: false, ctrlKey: true, shiftKey: false, altKey: false }, false), false);
checks.push("joins words and recognizes the shortcut");

const password = document.createElement("input");
password.type = "password";
const off = document.createElement("div");
off.dataset.dictation = "off";
const offInput = document.createElement("input");
off.append(offInput);
document.body.append(password, off);
assert.equal(findDictationTarget(password), null);
assert.equal(findDictationTarget(offInput), null);
checks.push("skips passwords and opted-out fields");

// CodeMirror: inserts at the cursor through the editor.
const cmParent = document.createElement("div");
document.body.append(cmParent);
const codeMirror = new EditorView({ parent: cmParent, state: EditorState.create({ doc: "Start end", selection: { anchor: 5 } }) });
assert.equal(insertDictation(codeMirror.contentDOM, "middle"), true);
assert.equal(codeMirror.state.doc.toString(), "Start middle end");
codeMirror.destroy();
checks.push("types into CodeMirror at the cursor");

// TipTap: inserts through a transaction so undo history sees it.
const tiptapParent = document.createElement("div");
document.body.append(tiptapParent);
const tiptap = new Editor({ element: tiptapParent, extensions: [StarterKit], content: "<p>Notes</p>" });
tiptap.commands.setTextSelection(6);
assert.equal(insertDictation(tiptap.view.dom as HTMLElement, "from my voice"), true);
assert.equal(tiptap.getText(), "Notes from my voice");
tiptap.commands.undo();
assert.equal(tiptap.getText(), "Notes");
tiptap.destroy();
checks.push("types into the rich editor with undo");

// A React-controlled textarea sees the change, by shortcut, end to end.
let latest = "";
function Host() {
  const [value, setValue] = useState("Ask");
  latest = value;
  return createElement("div", null,
    createElement("textarea", { id: "composer", value, onChange: (event: any) => setValue(event.target.value) }),
    createElement(DictationControl, { userId: "user-1" }));
}
const container = document.createElement("div");
document.body.append(container);
const root = createRoot(container);
await act(async () => root.render(createElement(Host)));
const composer = document.getElementById("composer") as HTMLTextAreaElement;
composer.focus();
composer.setSelectionRange(3, 3);
const apple = isApplePlatform();
const shortcut = () => new KeyboardEvent("keydown", { code: "Space", key: " ", shiftKey: true, metaKey: apple, ctrlKey: !apple, bubbles: true });
await act(async () => { window.dispatchEvent(shortcut()); await pause(20); });
assert.ok(document.querySelector(".dictation-pill.is-recording"), `recording pill shows: ${document.body.innerHTML.slice(-600)} active=${document.activeElement?.tagName}`);
await pause(350);
await act(async () => { window.dispatchEvent(shortcut()); await pause(50); });
assert.equal(requests.length, 1);
assert.equal(requests[0].url, "/api/dictation/transcribe");
assert.equal(requests[0].contentType, "audio/webm;codecs=opus");
assert.equal(requests[0].size, 2048);
assert.equal(latest, "Ask hello world");
assert.equal(tracksStopped.length, 1, "microphone released");
assert.equal(document.querySelector(".dictation-pill"), null);
checks.push("records, transcribes and types into a React textarea");

// Esc cancels without sending anything.
await act(async () => { window.dispatchEvent(shortcut()); await pause(20); });
await act(async () => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); await pause(20); });
assert.equal(requests.length, 1);
assert.equal(tracksStopped.length, 2);
assert.equal(document.querySelector(".dictation-pill"), null);
checks.push("Esc cancels without sending audio");

// Silence explains itself instead of typing nothing.
transcript = "  ";
await act(async () => { window.dispatchEvent(shortcut()); await pause(20); });
await pause(350);
await act(async () => { window.dispatchEvent(shortcut()); await pause(50); });
assert.match(document.querySelector(".dictation-pill.is-notice")?.textContent ?? "", /Didn't catch anything/u);
assert.equal(latest, "Ask hello world");
checks.push("says when it heard nothing");

await act(async () => root.unmount());
console.log(JSON.stringify({ checks }));
process.exit(0);
