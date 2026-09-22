import assert from "node:assert/strict";
import { Window } from "happy-dom";
import type { SearchEvidenceRef } from "../../client/src/lib/conversationSearch";

const browser = new Window({ url: "http://search-source.test/" });
for (const name of ["window", "document", "navigator", "HTMLElement", "Element", "Node", "NodeFilter", "Text", "Document", "DocumentFragment", "MutationObserver", "ResizeObserver", "Event", "MouseEvent", "KeyboardEvent", "Range", "DOMRect", "getComputedStyle"]) {
  const value = name === "window" ? browser : (browser as any)[name];
  if (value !== undefined) Object.defineProperty(globalThis, name, { configurable: true, value: name === "getComputedStyle" ? value.bind(browser) : value });
}
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const highlights = new Map<string, { ranges: Range[] }>();
Object.defineProperty(globalThis, "CSS", { configurable: true, value: { highlights } });
Object.defineProperty(globalThis, "Highlight", { configurable: true, value: class { ranges: Range[]; constructor(...ranges: Range[]) { this.ranges = ranges; } } });
const scrolled: Element[] = [];
browser.HTMLElement.prototype.scrollIntoView = function () { scrolled.push(this as unknown as Element); };
browser.requestAnimationFrame = () => 1;
browser.cancelAnimationFrame = () => undefined;
Object.defineProperty(globalThis, "requestAnimationFrame", { configurable: true, value: (callback: FrameRequestCallback) => browser.requestAnimationFrame(callback) });
Object.defineProperty(globalThis, "cancelAnimationFrame", { configurable: true, value: (id: number) => browser.cancelAnimationFrame(id) });

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { EditorView } = await import("@codemirror/view");
const { createSearchPassageRange } = await import("../../client/src/lib/searchSource");
const { default: SearchSourceFocus } = await import("../../client/src/components/SearchSourceFocus");
const { createMainConversation, createStandaloneNoteConversation } = await import("../../client/src/initialState");

function rendered(html: string) {
  const element = browser.document.createElement("div");
  element.innerHTML = html;
  return element as unknown as HTMLElement;
}
assert.equal(createSearchPassageRange(rendered("<p>A <strong>focused</strong> response.</p>"), "A **focused** response.")?.toString(), "A focused response.");
assert.equal(createSearchPassageRange(rendered("<p>First<br>second</p>"), "First  \nsecond")?.toString(), "Firstsecond", "A Markdown hard break maps across its BR element");
assert.equal(createSearchPassageRange(rendered("<ul><li>First <em>detail</em></li><li>Second idea</li></ul>"), "- First *detail*\n- Second idea")?.toString(), "First detailSecond idea", "List boundaries map without literal bullet markers");
assert.equal(createSearchPassageRange(rendered("<p>Repeated</p><p>Repeated</p>"), "Repeated"), null, "Ambiguous visible quotes are not guessed");
assert.equal(createSearchPassageRange(rendered('<button>Saved</button><span hidden>Saved</span><p>Saved</p>'), "Saved")?.toString(), "Saved", "Hidden UI and buttons do not create false duplicates");
assert.equal(createSearchPassageRange(rendered("<p>Changed content</p>"), "Removed content"), null);

const chat = createMainConversation({ id: "chat" });
chat.messages = [{ id: 'message"]', role: "assistant", content: "A **focused** response.", createdAt: chat.createdAt }];
const standalone = createStandaloneNoteConversation({ id: "standalone", noteId: "body" });
standalone.notes![0].content = "Before.\n\nA **standalone** passage.";
chat.notes = [
  { ...standalone.notes![0], id: "margin", kind: "comment", content: "Inserted. A **private** passage." },
  { ...standalone.notes![0], id: "side", kind: "side-chat", content: "The side note passage." },
];
const editable = createMainConversation({ id: "editable" });
const split = createMainConversation({ id: "split" });
split.messages = [{ id: "split-response", role: "assistant", content: "Intro.\n\nA later paragraph.\n\nA final paragraph.", createdAt: split.createdAt }];
const blockId = 'authored"]';
editable.document = { schemaVersion: 1, blocks: [{ id: blockId, kind: "markdown", content: "A **current** document passage.", createdAt: editable.createdAt, updatedAt: editable.updatedAt }], prompts: [], generations: [] };
const conversations = { chat, standalone, editable, split };
const mount = browser.document.createElement("div");
const panels = browser.document.createElement("div");
browser.document.body.append(mount, panels);
panels.innerHTML = '<article id="chat"><div class="panel-body"><section data-message-row-id="other" tabindex="-1"><div class="message-content">Other</div></section></div><aside class="side-note-panel" data-side-note-id="wrong"></aside></article><article id="standalone"><div class="panel-body"></div></article><article data-margin-note-tree-node="margin" class="margin-note-tree-node is-expanded"><div class="margin-note-tree-editor"></div></article>';
const row = browser.document.createElement("section");
row.dataset.messageRowId = chat.messages[0].id;
row.tabIndex = -1;
row.innerHTML = '<div class="message-content"><p>A <strong>focused</strong> response.</p></div>';
panels.querySelector("#chat .panel-body")!.append(row);
const editablePanel = browser.document.createElement("article");
editablePanel.id = "editable";
editablePanel.innerHTML = '<div class="panel-body"><section tabindex="-1"><div class="tiptap"><p>A <strong>current</strong> document passage.</p></div></section></div>';
const editableTarget = editablePanel.querySelector("section")!;
(editableTarget as any).dataset.documentBlockId = blockId;
panels.append(editablePanel);
const splitPanel = browser.document.createElement("article");
splitPanel.id = "split";
splitPanel.innerHTML = '<div class="panel-body"><section data-document-block-id="first" data-message-id="split-response"><div class="tiptap"><p>Intro.</p></div></section><section data-document-block-id="second" data-message-id="split-response"><div class="tiptap"><p>A later paragraph.</p></div></section><section data-document-block-id="third" data-message-id="split-response"><div class="tiptap"><p>A final paragraph.</p></div></section></div>';
panels.append(splitPanel);
const standaloneTarget = panels.querySelector("#standalone .panel-body")!;
const marginTarget = panels.querySelector("[data-margin-note-tree-node]")!;
const sideTarget = panels.querySelector(".side-note-panel")!;
const editors = [
  new EditorView({ parent: standaloneTarget as unknown as HTMLElement, doc: standalone.notes![0].content }),
  new EditorView({ parent: marginTarget.querySelector(".margin-note-tree-editor") as unknown as HTMLElement, doc: chat.notes[0].content }),
  new EditorView({ parent: sideTarget as unknown as HTMLElement, doc: chat.notes[1].content }),
];
// This harness checks real selections/transactions; browser layout is not simulated.
editors.forEach((editor) => { editor.requestMeasure = () => {}; });
let frameId = 0;
const frames = new Map<number, FrameRequestCallback>();
browser.requestAnimationFrame = (callback) => { frames.set(++frameId, callback); return frameId; };
browser.cancelAnimationFrame = (id) => { frames.delete(id); };
const root = createRoot(mount as unknown as Element);
let sequence = 0;
async function request(source: SearchEvidenceRef | null) {
  await act(async () => root.render(createElement(SearchSourceFocus, {
    request: source ? { source, sequence: ++sequence } : null,
    conversations,
    getPanelElement: (id: string) => panels.querySelector(id === "chat" ? "#chat" : id === "standalone" ? "#standalone" : id === "editable" ? "#editable" : id === "split" ? "#split" : "[data-missing]") as unknown as HTMLElement | null,
  })));
}
async function flushFrame() {
  await act(async () => { const pending = [...frames.values()]; frames.clear(); pending.forEach((callback) => callback(0)); });
}

try {
  await request({ conversationId: "chat", sourceKind: "message", messageId: chat.messages[0].id, quote: chat.messages[0].content, startOffset: 0, endOffset: chat.messages[0].content.length });
  assert.equal(highlights.size, 0, "Source navigation waits for the panel to mount");
  await flushFrame();
  assert.equal(highlights.get("margin-search-source")?.ranges[0].toString(), "A focused response.");
  assert(row.classList.contains("is-search-source"));

  const quote = "A **standalone** passage.";
  await request({ conversationId: "standalone", sourceKind: "standalone-note", noteId: "body", quote, startOffset: 9, endOffset: 9 + quote.length });
  assert.equal(highlights.size, 0, "A new request removes the prior highlight immediately");
  assert(!row.classList.contains("is-search-source"));
  await flushFrame();
  assert.equal(editors[0].state.sliceDoc(editors[0].state.selection.main.from, editors[0].state.selection.main.to), quote);
  assert(editors[0].hasFocus, "Standalone notes focus their actual editor");

  await request({ conversationId: "chat", sourceKind: "annotation", noteId: "margin", quote: "A **private** passage.", startOffset: 0, endOffset: 22 });
  await flushFrame();
  assert.equal(editors[1].state.selection.main.from, 10, "Edited annotations recover the unique quote's current raw offset");
  assert.equal(editors[1].state.sliceDoc(editors[1].state.selection.main.from, editors[1].state.selection.main.to), "A **private** passage.");

  const priorSelection = editors[1].state.selection.main;
  await request({ conversationId: "chat", sourceKind: "annotation", noteId: "margin", quote: "Removed text", startOffset: 0, endOffset: 12 });
  await flushFrame();
  assert(editors[1].hasFocus, "A stale annotation still opens the correct editor");
  assert.equal(editors[1].state.selection.main.from, priorSelection.from, "A stale quote does not invent an editor selection");
  assert.equal(editors[1].state.selection.main.to, priorSelection.to);

  await request({ conversationId: "chat", sourceKind: "annotation", noteId: "side", quote: chat.notes[1].content, startOffset: 0, endOffset: chat.notes[1].content.length });
  await flushFrame();
  assert(!sideTarget.classList.contains("is-search-source"), "A previous side-note editor is never used for another note's request");
  assert(frames.size > 0, "Source focus retries while the requested note is opening");
  (sideTarget as any).dataset.sideNoteId = "side";
  await flushFrame();
  assert.equal(editors[2].state.selection.main.to, chat.notes[1].content.length);
  assert(sideTarget.classList.contains("is-search-source"));

  const scrollCount = scrolled.length;
  await request({ conversationId: "chat", sourceKind: "annotation", noteId: "deleted", quote: "Removed" });
  await flushFrame();
  assert.equal(scrolled.length, scrollCount, "Deleted sources do not focus an unrelated visible note");
  assert(!sideTarget.classList.contains("is-search-source"));

  await request({ conversationId: "chat", sourceKind: "message", messageId: chat.messages[0].id });
  assert(frames.size > 0);
  await request(null);
  assert.equal(frames.size, 0, "Canceling a request clears deferred navigation");
  await flushFrame();
  assert.equal(scrolled.length, scrollCount);
  await request({ conversationId: "editable", sourceKind: "document", sourceBlockId: blockId, quote: "A **current** document passage.", startOffset: 0, endOffset: 31 });
  await flushFrame();
  assert(editableTarget.classList.contains("is-search-source"), "Document blocks are matched by literal stable identity");
  assert.equal(highlights.get("margin-search-source")?.ranges[0].toString(), "A current document passage.", "Rich document source navigation highlights current rendered content");
  const splitQuote = "A later paragraph.\n\nA final paragraph.";
  await request({ conversationId: "split", sourceKind: "message", messageId: "split-response", quote: splitQuote, startOffset: 8, endOffset: 8 + splitQuote.length });
  await flushFrame();
  assert.equal(highlights.get("margin-search-source")?.ranges[0].toString(), "A later paragraph.A final paragraph.", "A legacy passage can span two projected paragraph blocks");
  assert(scrolled.at(-1) === splitPanel.querySelector('[data-document-block-id="second"] p'), "Cross-block source navigation reaches the quoted paragraph rather than the first block");
  await act(async () => root.unmount());
  assert.equal(highlights.size, 0);
  console.log("Search source focus checks passed.");
} finally {
  editors.forEach((editor) => editor.destroy());
  await browser.happyDOM.close();
}
