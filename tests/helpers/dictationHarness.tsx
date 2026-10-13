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
  getUserMedia: async () => { const track = { stop: () => tracksStopped.push("audio") }; return { getTracks: () => [track], getAudioTracks: () => [track] }; },
} });
const requests: { url: string; contentType: string | null; size: number }[] = [];
const cleanups: { kind: string; prompt: string }[] = [];
let cleanupReply: (prompt: string) => Response = (prompt) => Response.json({ title: prompt.replace(/^\w/u, (letter) => letter.toUpperCase()).replace(/ (\w+)$/u, ", $1.") });
let transcribeReply: () => Response = () => Response.json({ text: transcript });
const liveRequests: { url: string; body: string; authorization: string | null }[] = [];
let transcript = "hello world";
let liveAvailable = true;
globalThis.fetch = (async (url: string, init: RequestInit) => {
  if (String(url).startsWith("/api/dictation/live") || String(url).startsWith("https://api.openai.com/")) {
    liveRequests.push({ url: String(url), body: String(init.body ?? ""), authorization: new Headers(init.headers).get("Authorization") });
    if (String(url) === "/api/dictation/live") {
      return liveAvailable
        ? Response.json({ clientSecret: "ek_test", model: "gpt-live-transcribe", maxSeconds: 600, token: "hold-token" })
        : Response.json({ error: "Hosted usage pricing is unavailable." }, { status: 503 });
    }
    if (String(url) === "/api/dictation/live/finish") return Response.json({ settled: true, seconds: 2 });
    return new Response("answer-sdp", { headers: { "Content-Type": "application/sdp" } });
  }
  if (String(url) === "/api/chat/title") {
    const body = JSON.parse(String(init.body));
    cleanups.push(body);
    return cleanupReply(body.prompt);
  }
  requests.push({ url: String(url), contentType: new Headers(init.headers).get("Content-Type"), size: (init.body as Blob).size });
  return transcribeReply();
}) as typeof fetch;

const { act, createElement, useState } = await import("react");
const { createRoot } = await import("react-dom/client");
const { EditorView } = await import("@codemirror/view");
const { EditorState } = await import("@codemirror/state");
const { history, undo } = await import("@codemirror/commands");
const { Editor } = await import("@tiptap/core");
const { default: StarterKit } = await import("@tiptap/starter-kit");
const { insertDictation, startDictationPreview, joinDictation, findDictationTarget, isDictationShortcut } = await import("../../client/src/lib/dictation");
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
assert.ok(insertDictation(codeMirror.contentDOM, "middle"));
assert.equal(codeMirror.state.doc.toString(), "Start middle end");
codeMirror.destroy();
checks.push("types into CodeMirror at the cursor");

// TipTap: inserts through a transaction so undo history sees it.
const tiptapParent = document.createElement("div");
document.body.append(tiptapParent);
const tiptap = new Editor({ element: tiptapParent, extensions: [StarterKit], content: "<p>Notes</p>" });
tiptap.commands.setTextSelection(6);
const typed = insertDictation(tiptap.view.dom as HTMLElement, "from my voice")!;
assert.equal(tiptap.getText(), "Notes from my voice");
// The clean version swaps in as its own undo step; paragraphs flatten in one block.
assert.equal(typed.swap("From my voice.\n\nSecond thought."), true);
assert.equal(tiptap.getText(), "Notes From my voice. Second thought.");
tiptap.commands.undo();
assert.equal(tiptap.getText(), "Notes from my voice");
tiptap.commands.undo();
assert.equal(tiptap.getText(), "Notes");
tiptap.destroy();
checks.push("types into the rich editor with undo, and swaps versions");

// Live previews stay out of undo; the final text is one undoable edit.
const previewParent = document.createElement("div");
document.body.append(previewParent);
const richPreview = new Editor({ element: previewParent, extensions: [StarterKit], content: "<p>Notes</p>" });
richPreview.commands.setTextSelection(6);
const rich = startDictationPreview(richPreview.view.dom as HTMLElement)!;
rich.update("one");
rich.update("one two");
assert.equal(richPreview.getText(), "Notes one two");
assert.ok(rich.commit("One, two."));
assert.equal(richPreview.getText(), "Notes One, two.");
richPreview.commands.undo();
assert.equal(richPreview.getText(), "Notes");
richPreview.destroy();
const cmPreviewParent = document.createElement("div");
document.body.append(cmPreviewParent);
const cmPreview = new EditorView({ parent: cmPreviewParent, state: EditorState.create({ doc: "Start", selection: { anchor: 5 }, extensions: [history()] }) });
const code = startDictationPreview(cmPreview.contentDOM)!;
code.update("draft words");
assert.equal(cmPreview.state.doc.toString(), "Start draft words");
code.commit("final words");
assert.equal(cmPreview.state.doc.toString(), "Start final words");
undo(cmPreview);
assert.equal(cmPreview.state.doc.toString(), "Start");
const cmCancel = startDictationPreview(cmPreview.contentDOM)!;
cmCancel.update("oops");
cmCancel.discard();
assert.equal(cmPreview.state.doc.toString(), "Start");
cmPreview.destroy();
checks.push("previews live words outside undo in both editors");

// A React-controlled textarea sees the change, by shortcut, end to end.
let latest = "";
let pieceMs: number | undefined;
function Host() {
  const [value, setValue] = useState("Ask");
  latest = value;
  return createElement("div", null,
    createElement("textarea", { id: "composer", value, onChange: (event: any) => setValue(event.target.value) }),
    createElement(DictationControl, { userId: "user-1", segmentMs: pieceMs }));
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
checks.push("records, transcribes and types into a React textarea");

// The raw transcript is typed; the clean one is a click away, and so is going back.
const version = (name: string) => [...document.querySelectorAll<HTMLButtonElement>(".dictation-version")].find((button) => button.textContent?.trim() === name)!;
assert.ok(document.querySelector(".dictation-pill.is-versions"), "versions pill shows");
assert.equal(version("Raw").getAttribute("aria-pressed"), "true");
await act(async () => { await pause(20); });
assert.deepEqual(cleanups, [{ kind: "dictation", prompt: "hello world" }]);
assert.equal(version("Clean").disabled, false);
await act(async () => { version("Clean").click(); });
assert.equal(latest, "Ask Hello, world.");
assert.equal(version("Clean").getAttribute("aria-pressed"), "true");
await act(async () => { version("Raw").click(); });
assert.equal(latest, "Ask hello world");
await act(async () => { document.querySelector<HTMLButtonElement>(".dictation-pill.is-versions .dictation-pill-button")!.click(); });
assert.equal(document.querySelector(".dictation-pill"), null);
checks.push("swaps between the raw and clean versions");

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

// Live: words show in the field while talking, then the final text replaces them.
const { createTranscriptAssembler } = await import("../../client/src/lib/liveDictation");
const assembler = createTranscriptAssembler();
assembler.apply({ type: "conversation.item.input_audio_transcription.delta", item_id: "a", delta: "Hel" });
assembler.apply({ type: "conversation.item.input_audio_transcription.delta", item_id: "b", delta: "later" });
assembler.apply({ type: "conversation.item.input_audio_transcription.delta", item_id: "a", delta: "lo" });
assert.equal(assembler.text(), "Hello later");
assembler.apply({ type: "conversation.item.input_audio_transcription.completed", item_id: "a", transcript: "Hello," });
assert.equal(assembler.text(), "Hello, later");
assert.equal(assembler.pending(), true);
checks.push("assembles live text across turns");

let channel: FakeChannel | null = null;
const sent: string[] = [];
class FakeChannel {
  readyState = "open";
  listeners = new Map<string, ((event: any) => void)[]>();
  addEventListener(type: string, listener: (event: any) => void) { this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]); }
  emit(event: unknown) { for (const listener of this.listeners.get("message") ?? []) listener({ data: JSON.stringify(event) }); }
  send(message: string) {
    sent.push(message);
    setTimeout(() => this.emit({ type: "conversation.item.input_audio_transcription.completed", item_id: "turn-1", transcript: "Hello there, live world." }), 5);
  }
  close() { this.readyState = "closed"; }
}
let peersClosed = 0;
class FakePeerConnection {
  localDescription: { sdp: string } | null = null;
  addTrack() {}
  createDataChannel() { channel = new FakeChannel(); return channel; }
  async createOffer() { return { type: "offer", sdp: "offer-sdp" }; }
  async setLocalDescription(description: { sdp: string }) { this.localDescription = description; }
  async setRemoteDescription() {}
  close() { peersClosed += 1; }
}
Object.defineProperty(globalThis, "RTCPeerConnection", { configurable: true, value: FakePeerConnection });
await act(async () => { document.querySelector<HTMLButtonElement>(".dictation-pill.is-notice .dictation-pill-button")?.click(); });
composer.focus();
composer.setSelectionRange(composer.value.length, composer.value.length);
await act(async () => { window.dispatchEvent(shortcut()); await pause(30); });
assert.ok(channel, `live connection opened: ${JSON.stringify(liveRequests)} ${document.querySelector(".dictation-pill")?.outerHTML}`);
assert.equal(liveRequests[1].url, "https://api.openai.com/v1/realtime/calls");
assert.equal(liveRequests[1].authorization, "Bearer ek_test");
assert.equal(liveRequests[1].body, "offer-sdp");
await act(async () => {
  channel!.emit({ type: "conversation.item.input_audio_transcription.delta", item_id: "turn-1", delta: "Hello" });
  channel!.emit({ type: "conversation.item.input_audio_transcription.delta", item_id: "turn-1", delta: " there" });
  await pause(10);
});
assert.equal(latest, "Ask hello world Hello there", "live words show in the field");
await pause(350);
const transcribeCalls = requests.length;
await act(async () => { window.dispatchEvent(shortcut()); await pause(450); });
assert.equal(latest, "Ask hello world Hello there, live world.");
assert.deepEqual(sent.map((message) => JSON.parse(message).type), ["input_audio_buffer.commit"]);
assert.equal(requests.length, transcribeCalls, "no second transcription of the recording");
assert.ok(liveRequests.some((request) => request.url === "/api/dictation/live/finish" && JSON.parse(request.body).token === "hold-token"), "hosted hold settled");
assert.equal(peersClosed, 1);
assert.ok(document.querySelector(".dictation-pill.is-versions"));
assert.equal(cleanups.at(-1)?.prompt, "Hello there, live world.");
checks.push("shows live words and swaps in the final text");

// Esc mid-sentence takes the live words back out.
channel = null;
await act(async () => { window.dispatchEvent(shortcut()); await pause(30); });
await act(async () => { channel!.emit({ type: "conversation.item.input_audio_transcription.delta", item_id: "turn-2", delta: "never mind" }); await pause(10); });
assert.equal(latest, "Ask hello world Hello there, live world. never mind");
await act(async () => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); await pause(20); });
assert.equal(latest, "Ask hello world Hello there, live world.");
assert.equal(liveRequests.filter((request) => request.url === "/api/dictation/live/finish").length, 2);
checks.push("Esc removes live words and ends the charge");

// Without a live session, the recording is transcribed when it stops.
liveAvailable = false;
transcript = "from the recording";
await act(async () => { window.dispatchEvent(shortcut()); await pause(30); });
await pause(350);
await act(async () => { window.dispatchEvent(shortcut()); await pause(80); });
assert.equal(latest, "Ask hello world Hello there, live world. from the recording");
checks.push("falls back to transcribing the recording");

// Long recordings go up a piece at a time while the person is still talking, and come back in order.
pieceMs = 100;
await act(async () => root.render(createElement(Host)));
let piece = 0;
transcribeReply = () => Response.json({ text: `part ${++piece}` });
const before = requests.length;
await act(async () => { window.dispatchEvent(shortcut()); await pause(30); });
await act(async () => { await pause(360); });
const sentWhileTalking = requests.length - before;
assert.ok(sentWhileTalking >= 2, `pieces sent while talking: ${sentWhileTalking}`);
await act(async () => { window.dispatchEvent(shortcut()); await pause(80); });
const pieces = requests.length - before;
assert.ok(pieces > sentWhileTalking, "the last piece is sent on stop");
assert.ok(requests.slice(before).every((request) => request.size === 2048));
assert.equal(latest, `Ask hello world Hello there, live world. from the recording ${Array.from({ length: pieces }, (_, index) => `part ${index + 1}`).join(" ")}`);
checks.push("records without a time limit, in pieces");

// A failed piece keeps the recording so it can be tried again.
pieceMs = undefined;
await act(async () => root.render(createElement(Host)));
const typedBefore = latest;
let failures = 1;
transcribeReply = () => failures-- > 0 ? Response.json({ error: "OpenAI is busy." }, { status: 503 }) : Response.json({ text: "second try" });
await act(async () => { window.dispatchEvent(shortcut()); await pause(30); });
await pause(350);
await act(async () => { window.dispatchEvent(shortcut()); await pause(80); });
assert.match(document.querySelector(".dictation-pill.is-notice")?.textContent ?? "", /recording is kept/u);
assert.equal(latest, typedBefore);
await act(async () => { document.querySelector<HTMLButtonElement>(".dictation-pill-action")!.click(); await pause(80); });
assert.equal(latest, `${typedBefore} second try`);
checks.push("keeps the recording when transcription fails");

// When cleanup isn't available, the raw text stays and says so.
cleanupReply = () => Response.json({ error: "Your prepaid balance is too low." }, { status: 402 });
transcribeReply = () => Response.json({ text: "no credit left" });
await act(async () => { window.dispatchEvent(shortcut()); await pause(30); });
await pause(350);
await act(async () => { window.dispatchEvent(shortcut()); await pause(80); });
assert.equal(latest, `${typedBefore} second try no credit left`);
assert.match(document.querySelector(".dictation-pill.is-versions")?.textContent ?? "", /Clean version unavailable/u);
assert.equal(version("Clean").disabled, true);
checks.push("keeps the raw text when cleanup fails");

// A live session that drops partway hands over to the recording, which is transcribed in full.
liveAvailable = true;
channel = null;
transcribeReply = () => Response.json({ text: "said before and after the drop" });
const typedBeforeDrop = latest;
const finishesBefore = liveRequests.filter((request) => request.url === "/api/dictation/live/finish").length;
await act(async () => { window.dispatchEvent(shortcut()); await pause(30); });
await act(async () => {
  channel!.emit({ type: "conversation.item.input_audio_transcription.delta", item_id: "turn-3", delta: "said before" });
  channel!.emit({ type: "error", error: { code: "session_expired", message: "Session expired." } });
  await pause(10);
});
assert.equal(liveRequests.filter((request) => request.url === "/api/dictation/live/finish").length, finishesBefore + 1, "dropped session's charge ends");
await pause(350);
await act(async () => { window.dispatchEvent(shortcut()); await pause(80); });
assert.equal(latest, `${typedBeforeDrop} said before and after the drop`);
checks.push("switches to the recording when live words drop");

await act(async () => root.unmount());
console.log(JSON.stringify({ checks }));
process.exit(0);
