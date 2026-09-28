import assert from "node:assert/strict";
import { Window } from "happy-dom";

const browser = new Window({ url: "http://rich-document.test" });
for (const name of ["window", "document", "navigator", "HTMLElement", "Element", "Node", "NodeFilter", "Text", "Document", "DocumentFragment", "MutationObserver", "ResizeObserver", "Event", "MouseEvent", "KeyboardEvent", "Range", "DOMRect", "DOMParser", "getComputedStyle", "HTMLInputElement", "HTMLTextAreaElement", "ShadowRoot"]) {
  const value = name === "window" ? browser : (browser as any)[name];
  if (value !== undefined) Object.defineProperty(globalThis, name, { configurable: true, value: name === "getComputedStyle" ? value.bind(browser) : value });
}
Object.defineProperty(globalThis, "requestAnimationFrame", { configurable: true, value: (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0) });
Object.defineProperty(globalThis, "cancelAnimationFrame", { configurable: true, value: clearTimeout });
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const { act, createElement, useState } = await import("react");
const { createRoot } = await import("react-dom/client");
const { Editor } = await import("@tiptap/core");
const { default: RichDocumentEditor, createRichDocumentExtensions } = await import("../../client/src/components/RichDocumentEditor");
const { markdownOffsetAtDocumentPosition, documentPositionAtMarkdownOffset, splitRichDocumentMarkdown, getRichDocumentFallbackReason } = await import("../../client/src/lib/richDocumentMarkdown");
const { createSearchPassageRange } = await import("../../client/src/lib/searchSource");
const checks: string[] = [];
const date = "2026-09-20T00:00:00.000Z";
const initial = [
  { id: "first", kind: "markdown" as const, content: "# Title\n\nHello **bold** and [linked](https://example.com).", createdAt: date, updatedAt: date, sourceMessageId: "original-response" },
  { id: "stream", kind: "markdown" as const, content: "Streaming", createdAt: date, updatedAt: date },
  { id: "empty", kind: "markdown" as const, content: "", createdAt: date, updatedAt: date },
  { id: "advanced", kind: "markdown" as const, content: "> [!tip] Keep\n> A [[wiki link]].\n\n%%private comment%%", createdAt: date, updatedAt: date },
];
let updateBlocks: any;
let updatePlaceholderVisibility: (hidden: boolean) => void;
let latestBlocks: any[] = initial;
const updates: any[] = [];
const invocations: any[] = [];
const selections: any[] = [];
const moves: any[] = [];
const splits: any[] = [];
const insertions: any[] = [];
let splitCount = 0;
function Host() {
  const [blocks, setBlocks] = useState(initial);
  const [hidePlaceholder, setHidePlaceholder] = useState(false);
  updateBlocks = setBlocks;
  updatePlaceholderVisibility = setHidePlaceholder;
  latestBlocks = blocks;
  return createElement(RichDocumentEditor, {
    conversationId: "conversation", blocks, readOnlyBlockIds: ["stream"], hidePlaceholder,
    sourceMessages: [{ id: "original-response", role: "assistant" }],
    decorations: { first: [{ from: 17, to: 25, branchIds: ["branch"] }] },
    onUpdateBlock(id: string, markdown: string) { updates.push({ id, markdown }); setBlocks((items) => items.map((item) => item.id === id ? { ...item, content: markdown } : item)); },
    onInvokeAI(value: any) { invocations.push(value); }, onSelectionChange(value: any) { selections.push(value); },
    onReorderBlock(id: string, beforeId: string | null) { moves.push({ id, beforeId }); setBlocks((items) => { const item = items.find((item) => item.id === id)!; const next = items.filter((item) => item.id !== id); const index = beforeId ? next.findIndex((item) => item.id === beforeId) : next.length; next.splice(index < 0 ? next.length : index, 0, item); return next; }); },
    onSplitBlock(id: string, before: string, after: string) { const nextId = `split-${++splitCount}`; splits.push({ id, before, after }); setBlocks((items) => items.flatMap((item) => item.id === id ? [{ ...item, content: before }, { ...item, id: nextId, content: after }] : [item])); return nextId; },
    onInsertBlock(afterId: string | null, markdown: string) { const id = `inserted-${++splitCount}`; insertions.push({ id, afterId, markdown }); setBlocks((items) => { const next = [...items]; next.splice(items.findIndex((item) => item.id === afterId) + 1, 0, { ...initial[2], id, content: markdown }); return next; }); return id; },
    onDeleteBlock(id: string) { setBlocks((items) => items.filter((item) => item.id !== id)); },
  });
}
const container = browser.document.createElement("div");
browser.document.body.append(container);
const root = createRoot(container as unknown as Element);
function block(id: string) { const item = container.querySelector(`[data-document-block-id='${id}']`); assert(item, `Missing block ${id}`); return item; }
function editor(id: string): InstanceType<typeof Editor> { const dom = block(id).querySelector(".tiptap") as any; assert(dom?.editor, `Missing real Tiptap editor ${id}`); return dom.editor; }
function hintedBlocks() { return [...container.querySelectorAll('.rich-document-content[data-placeholder]:not([data-placeholder=""])')]; }
async function key(view: any, name: string, extras = {}) { const event = new browser.KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true, ...extras }); await act(async () => { view.dom.dispatchEvent(event); }); return event; }
async function settle() { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); }); }
try {
  await act(async () => root.render(createElement(Host)));
  await settle();
  const first = editor("first");
  assert.equal(block("first").querySelector("h1")?.textContent, "Title");
  assert.equal(block("first").querySelector("strong")?.textContent, "bold");
  assert.equal(block("first").getAttribute("data-message-id"), "original-response");
  assert.equal(block("first").querySelector("h1")?.getAttribute("data-chat-outline-id"), "heading-document:first-0");
  assert.equal(updates.length, 0, "Mount must not normalize or overwrite original Markdown.");
  assert.equal(editor("stream").isEditable, false);
  assert.equal(first.isEditable, true);
  assert.equal(container.querySelector(".rich-document-authorship"), null, "Authorship stays hidden while block actions are closed.");
  await act(async () => (block("first").querySelector(".rich-document-grip") as any).click());
  const label = block("first").querySelector('.rich-document-toolbar [role="note"][aria-label="Authorship: AI"]');
  assert(label, "Legacy assistant sources receive an accessible AI label.");
  assert.equal(label.getAttribute("data-label"), "Authorship: AI");
  assert.equal(label.textContent, "", "Authorship is displayed without adding document text nodes.");
  await act(async () => (block("first").querySelector('[aria-label="Close block actions"]') as any).click());
  assert.equal(container.querySelector(".rich-document-authorship"), null);
  await act(async () => (block("advanced").querySelector(".rich-document-grip") as any).click());
  assert(block("advanced").querySelector('.rich-document-toolbar [aria-label="Authorship: You"]'), "Preserved Markdown exposes authorship in its block actions too.");
  await act(async () => (block("advanced").querySelector('[aria-label="Close block actions"]') as any).click());
  const multiBlockSource = browser.document.createElement("div");
  for (const text of ["First passage.", "Second passage."]) {
    const shell = block("first").cloneNode(true) as HTMLElement;
    shell.querySelector(".tiptap")!.innerHTML = `<p>${text}</p>`;
    multiBlockSource.append(shell as any);
  }
  const passageRange = createSearchPassageRange(multiBlockSource as unknown as HTMLElement, "First passage. Second passage.");
  assert.equal(passageRange?.toString(), "First passage.Second passage.", "Cross-block source searches and copied ranges exclude authorship labels.");
  assert.equal(createSearchPassageRange(multiBlockSource as unknown as HTMLElement, "AI"), null, "Authorship labels are not searchable document passages.");
  checks.push("formatted content and compatible source IDs without mount writes");

  assert.equal(hintedBlocks().length, 1, "Existing empty blocks and the continuation share one writing hint.");
  assert(hintedBlocks()[0].closest('.is-continuation'), "The last editable blank area receives the initial hint.");
  await act(async () => editor("empty").commands.focus());
  await settle();
  assert.deepEqual(hintedBlocks(), [editor("empty").view.dom], "Focusing another empty block moves the single hint there.");
  await act(async () => updatePlaceholderVisibility(true));
  assert.equal(hintedBlocks().length, 0, "An open AI prompt suppresses document writing hints.");
  await act(async () => updatePlaceholderVisibility(false));
  assert.equal(hintedBlocks().length, 1, "Closing AI restores one hint without recreating editors.");
  checks.push("one writing hint follows the empty caret and is hidden while AI is open");

  const original = initial[0].content;
  let boldPosition = -1;
  first.state.doc.descendants((node: any, position: number) => { if (node.isText && node.text === "bold") boldPosition = position; });
  assert(boldPosition > 0);
  const serializer = (value: any) => first.markdown!.serialize(value);
  const start = markdownOffsetAtDocumentPosition(first.state.doc, serializer, original, boldPosition, 1);
  const end = markdownOffsetAtDocumentPosition(first.state.doc, serializer, original, boldPosition + 4, -1);
  assert.equal(original.slice(start, end), "bold");
  assert.equal(documentPositionAtMarkdownOffset(first.state.doc, serializer, original, start), boldPosition);
  const alternate = original.replace("**bold**", "__bold__");
  assert.equal(alternate.slice(markdownOffsetAtDocumentPosition(first.state.doc, serializer, alternate, boldPosition), markdownOffsetAtDocumentPosition(first.state.doc, serializer, alternate, boldPosition + 4, -1)), "bold", "Equivalent underscore source must retain exact offsets.");
  await act(async () => { first.commands.focus(); });
  await settle();
  await act(async () => { first.commands.setTextSelection({ from: boldPosition, to: boldPosition + 4 }); });
  const selected = selections.filter(Boolean).at(-1);
  assert.equal(selected.quote, "bold");
  assert.equal(selected.sourceBlockId, "first");
  assert.equal(original.slice(selected.startOffset, selected.endOffset), "bold");
  assert(block("first").querySelector(".message-anchor[data-annotation-branches='[\"branch\"]']"), "Saved anchors should remain hover-preview targets.");
  checks.push("rich selection maps to exact raw Markdown and saved highlights");

  await act(async () => { first.commands.selectAll(); });
  const entireSelection = selections.filter(Boolean).at(-1);
  assert.equal(entireSelection.startOffset, 0, "Select all starts at the original source boundary, including heading syntax.");
  assert.equal(entireSelection.endOffset, original.length);
  assert.equal(entireSelection.quote, original);
  assert.equal(first.getMarkdown(), original, "Mapping a structural selection does not change the editor document.");
  for (const source of ["## Whole __heading__\n\n", "* __First__\n* Second\n"]) {
    const structural = new Editor({ extensions: createRichDocumentExtensions(), content: source, contentType: "markdown" });
    try {
      const doc = structural.state.doc;
      const serialize = (value: any) => structural.markdown!.serialize(value);
      assert.equal(markdownOffsetAtDocumentPosition(doc, serialize, source, 0, 1), 0);
      assert.equal(markdownOffsetAtDocumentPosition(doc, serialize, source, doc.content.size, -1), source.length);
      // Exercise every document/list/list-item boundary in both directions.
      for (let position = 0; position <= doc.content.size; position += 1) {
        if (doc.resolve(position).parent.inlineContent) continue;
        for (const affinity of [-1, 1] as const) {
          const offset = markdownOffsetAtDocumentPosition(doc, serialize, source, position, affinity);
          assert(offset >= 0 && offset <= source.length);
        }
      }
      let secondItemPosition = -1;
      doc.descendants((node: any, position: number) => { if (node.type.name === "listItem" && node.textContent === "Second") secondItemPosition = position; });
      if (secondItemPosition >= 0) {
        assert.equal(markdownOffsetAtDocumentPosition(doc, serialize, source, secondItemPosition, 1), source.indexOf("Second"), "Forward affinity enters the next list item's text without including its bullet.");
        assert.equal(markdownOffsetAtDocumentPosition(doc, serialize, source, secondItemPosition, -1), source.indexOf("First") + "First".length, "Backward affinity stops at the previous text, before its closing mark.");
      }
    } finally { structural.destroy(); }
  }
  checks.push("select-all and nested list boundaries map to source without invalid structural text insertion");

  await act(async () => { first.commands.setTextSelection(first.state.doc.content.size - 1); first.commands.insertContent(" draft"); });
  const localText = first.getMarkdown();
  const caret = first.state.selection.from;
  const beforeRemoteUpdates = updates.length;
  await act(async () => updateBlocks((items: any[]) => items.map((item) => item.id === "stream" ? { ...item, content: "Streaming a longer response\n\nAnother paragraph." } : item)));
  assert.equal(editor("first"), first, "Other blocks must retain their actual editor instances.");
  assert.equal(first.getMarkdown(), localText);
  assert.equal(first.state.selection.from, caret);
  assert.equal(updates.length, beforeRemoteUpdates, "Incoming stream changes must not emit local writes.");
  assert(editor("stream").getText().includes("longer response"));
  checks.push("stream updates preserve another editor's content, cursor, and instance");

  const empty = editor("empty");
  await act(async () => { empty.commands.focus(); empty.commands.setTextSelection(1); });
  assert.equal((await key(empty.view, " ")).defaultPrevented, true);
  assert.equal(invocations.length, 1);
  assert.equal(invocations[0].offset, 0);
  assert.equal(invocations[0].markdown, "");
  await act(async () => invocations[0].restoreFocus({ restoreSpaces: true }));
  assert.equal(empty.getText(), " ", "Dismissal restores the triggering space and typing caret.");
  assert.equal((await key(empty.view, " ")).defaultPrevented, false, "Dismissal must not immediately reopen AI.");
  await act(async () => { empty.commands.setContent("Hello ", { contentType: "markdown" }); empty.commands.setTextSelection(7); });
  await key(empty.view, "a");
  assert.equal((await key(empty.view, " ")).defaultPrevented, true);
  assert.equal(invocations.at(-1).markdown, "Hello");
  assert.equal(invocations.at(-1).offset, 5);
  await act(async () => invocations.at(-1).restoreFocus({ restoreSpaces: true }));
  assert.equal(empty.getText(), "Hello  ");
  checks.push("empty and double-space AI invocation with lossless dismissal");

  async function input(editor: InstanceType<typeof Editor>, text: string, extras: Record<string, unknown> = {}) {
    const event = new browser.InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType: "insertText", data: text, ...extras });
    await act(async () => editor.view.dom.dispatchEvent(event));
    return event;
  }
  await act(async () => { empty.commands.setContent("", { contentType: "markdown" }); empty.commands.focus(); empty.commands.setTextSelection(1); });
  await input(empty, "a"); // Actual text input resets dismissal suppression without a keydown.
  let beforeMobile = invocations.length;
  await key(empty.view, " ", { shiftKey: true });
  assert.equal((await input(empty, " ")).defaultPrevented, false, "Modified space stays literal through the input pipeline.");
  await key(empty.view, " ", { repeat: true });
  assert.equal((await input(empty, " ")).defaultPrevented, false, "Repeated space stays literal through the input pipeline.");
  await key(empty.view, "Unidentified");
  assert((await input(empty, " ")).defaultPrevented);
  assert.equal(invocations.length, beforeMobile + 1);
  assert.equal(invocations.at(-1).markdown, "");
  await act(async () => invocations.at(-1).restoreFocus({ restoreSpaces: true }));
  await key(empty.view, "Unidentified");
  assert.equal((await input(empty, " ")).defaultPrevented, false);
  assert.equal(empty.getText(), " ");
  await input(empty, "a");
  await act(async () => { empty.commands.setContent("Hello ", { contentType: "markdown" }); empty.commands.setTextSelection(7); });
  assert((await input(empty, "\u00a0")).defaultPrevented);
  assert.equal(invocations.at(-1).markdown, "Hello");
  await act(async () => invocations.at(-1).restoreFocus({ restoreSpaces: true }));
  assert.equal(empty.getText(), "Hello  ");
  await input(empty, "a");
  await act(async () => { empty.commands.setContent("Hello ", { contentType: "markdown" }); empty.commands.setTextSelection(7); });
  const textNode = empty.view.dom.querySelector("p")!.firstChild!;
  const replacement = new browser.InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType: "insertText", data: ". " });
  Object.defineProperty(replacement, "getTargetRanges", { value: () => [{ startContainer: textNode, startOffset: 5, endContainer: textNode, endOffset: 6 }] });
  await act(async () => empty.view.dom.dispatchEvent(replacement));
  assert(replacement.defaultPrevented);
  assert.equal(invocations.at(-1).markdown, "Hello");
  assert.equal(invocations.at(-1).offset, 5);
  beforeMobile = invocations.length;
  assert.equal((await input(empty, ". ")).defaultPrevented, false, "Literal punctuation is not the space shortcut.");
  assert.equal((await input(empty, " ", { inputType: "insertFromPaste" })).defaultPrevented, false);
  assert.equal((await input(empty, " ", { isComposing: true })).defaultPrevented, false);
  await act(async () => { empty.commands.setContent("```js\nx \n```", { contentType: "markdown" }); empty.commands.setTextSelection(3); });
  assert.equal((await input(empty, " ")).defaultPrevented, false);
  assert.equal(invocations.length, beforeMobile);
  await act(async () => { empty.commands.setContent("Hello ", { contentType: "markdown" }); empty.commands.setTextSelection(7); });
  await act(async () => empty.view.someProp("handleTextInput", (handler: any) => handler(empty.view, 7, 7, " ", () => empty.state.tr.insertText(" "))));
  assert.equal(invocations.length, beforeMobile + 1, "DOM-diff input also triggers AI without keydown.");
  assert.equal(invocations.at(-1).markdown, "Hello");
  checks.push("mobile beforeinput, punctuation replacement, dismissal, and DOM input fallback");

  await act(async () => { empty.commands.setContent("Select this **passage**", { contentType: "markdown" }); empty.commands.focus(); });
  const touchActions = block("empty").querySelector(".rich-document-touch-actions")!;
  await act(async () => ([...touchActions.querySelectorAll("button")].find((button) => button.getAttribute("aria-label") === "Select block") as any).click());
  assert.equal(selections.at(-1).quote, "Select this **passage**");
  await act(async () => (touchActions.querySelector("button") as any).click());
  assert.equal(invocations.at(-1).selection.quote, "Select this **passage**");
  assert.equal(block("stream").querySelector(".rich-document-touch-actions"), null);
  checks.push("touch actions select a complete block and invoke AI on that exact passage");

  const countBeforeGuards = invocations.length;
  await act(async () => { empty.commands.setContent("", { contentType: "markdown" }); empty.commands.focus(); empty.commands.setTextSelection(1); });
  await key(empty.view, "a");
  await key(empty.view, " ", { repeat: true });
  await key(empty.view, " ", { isComposing: true });
  await key(empty.view, " ", { shiftKey: true });
  assert.equal((await key(empty.view, "/")).defaultPrevented, false, "Slash remains literal.");
  await act(async () => { empty.commands.setContent("```js\nx \n```", { contentType: "markdown" }); empty.commands.setTextSelection(3); });
  assert.equal((await key(empty.view, " ")).defaultPrevented, false, "Code spacing stays ordinary.");
  assert.equal(invocations.length, countBeforeGuards);
  checks.push("IME, repeated keys, modifier keys, code, and literal slash guards");

  await act(async () => { empty.commands.setContent("Split **bold** text", { contentType: "markdown" }); empty.commands.setTextSelection(7); });
  await key(empty.view, "Enter");
  await settle();
  assert.equal(splits.at(-1).before, "Split ");
  assert.equal(splits.at(-1).after, "**bold** text");
  assert(editor("split-1").isFocused, "Enter must focus the inserted block, not strand typing in the previous one.");
  await act(async () => { editor("split-1").commands.setTextSelection(1); });
  await key(editor("split-1").view, "ArrowUp");
  await settle();
  assert(empty.isFocused, "Arrow Up at the start should return to the preceding block.");
  checks.push("Enter creates independent blocks with formatting preserved and focus moved");

  const multiline = editor("split-1");
  await act(async () => { multiline.commands.setContent("First line", { contentType: "markdown" }); multiline.commands.setTextSelection(11); });
  const splitCountBeforeNewline = splits.length;
  await key(multiline.view, "Enter", { shiftKey: true });
  assert.equal(splits.length, splitCountBeforeNewline, "Shift+Enter stays inside the document block.");
  assert.equal(multiline.state.doc.childCount, 2);
  await act(async () => multiline.commands.insertContent("##"));
  // Dispatch through the input pipeline so the heading input rule actually runs.
  await act(async () => multiline.view.someProp("handleTextInput", (handler: any) => handler(multiline.view, multiline.state.selection.from, multiline.state.selection.to, " ", () => multiline.state.tr.insertText(" "))));
  assert.equal(multiline.state.doc.lastChild?.type.name, "heading");
  await act(async () => multiline.commands.insertContent("New heading"));
  assert(multiline.getMarkdown().includes("## New heading"));
  checks.push("Shift+Enter retains one block with a new Markdown-aware paragraph");

  await act(async () => multiline.commands.setContent("Before after", { contentType: "markdown" }));
  await act(async () => multiline.commands.setTextSelection({ from: 8, to: 13 }));
  assert((await key(multiline.view, "d", { metaKey: true })).defaultPrevented);
  assert.match(multiline.getText(), /^Before \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} GMT[^ ]* \([^)]+\)$/);
  assert.equal((await key(multiline.view, "d", { metaKey: true, altKey: true })).defaultPrevented, false);
  checks.push("Command+D replaces the current selection with an unambiguous local timestamp");

  await act(async () => multiline.commands.setContent("| First | Second |\n| --- | --- |\n| Alpha | Beta |", { contentType: "markdown" }));
  let alpha = 0;
  multiline.state.doc.descendants((node, position) => { if (node.isText && node.text === "Alpha") alpha = position; });
  await act(async () => multiline.commands.setTextSelection(alpha + 5));
  await key(multiline.view, "Enter");
  await act(async () => multiline.commands.insertContent("Next line"));
  assert(multiline.getMarkdown().includes("Alpha<br>Next line"));
  assert.equal(getRichDocumentFallbackReason(multiline.getMarkdown()), null);
  assert.equal(editor("split-1"), multiline, "A cell newline must not replace the live editor with a source fallback.");
  assert(block("split-1").querySelector("td br"));
  const reloadedTable = new Editor({ extensions: createRichDocumentExtensions(), content: multiline.getMarkdown(), contentType: "markdown" });
  assert.deepEqual(reloadedTable.getJSON(), multiline.getJSON());
  reloadedTable.destroy();
  const tableBefore = block("split-1").querySelector("table")!;
  await act(async () => (block("split-1").querySelector('[aria-label="Add row to table"]') as any).click());
  assert.equal(tableBefore.querySelectorAll("tr").length, 3);
  await act(async () => (block("split-1").querySelector('[aria-label="Add column to table"]') as any).click());
  assert.equal(tableBefore.querySelectorAll("tr")[0].children.length, 3);
  assert.equal(block("split-1").querySelector("table"), tableBefore);
  assert(!multiline.getMarkdown().includes("Add row"));
  checks.push("table cell newlines stay editable and persist while edge controls append rows and columns without replacing the table");

  await act(async () => updateBlocks((items: any[]) => items.map((item) => item.id === "stream" ? { ...item, content: "## Stable heading\n\nGrowing text" } : item)));
  const headingBefore = block("stream").querySelector("h2");
  const paragraphBefore = block("stream").querySelector("p");
  for (const suffix of [" continues", " continues with **bold**", " continues with **bold** and a table\n\n| A | B |\n| --- | --- |\n| One | Two |"] ) {
    await act(async () => updateBlocks((items: any[]) => items.map((item) => item.id === "stream" ? { ...item, content: "## Stable heading\n\nGrowing text" + suffix } : item)));
    assert.equal(block("stream").querySelector("h2"), headingBefore, "Streaming preserves unchanged heading DOM.");
    assert.equal(block("stream").querySelector("p"), paragraphBefore, "Appending stream text retains its paragraph DOM.");
  }
  checks.push("streaming patches changed content while retaining existing rendered nodes");

  const advanced = block("advanced");
  assert.equal(advanced.querySelector(".tiptap"), null);
  assert(advanced.textContent?.includes("Edit callout source") || advanced.textContent?.includes("Edit wiki link source"));
  await act(async () => (advanced.querySelector(".rich-document-source-action") as any).click());
  const source = advanced.querySelector("textarea") as any;
  assert.equal(source.value, initial[3].content, "Unsupported constructs must remain byte-for-byte intact.");
  await act(async () => source.dispatchEvent(new browser.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
  assert.equal(block("advanced").querySelector("textarea"), null);
  assert.equal(latestBlocks.find((item) => item.id === "advanced").content, initial[3].content);
  await act(async () => (advanced.querySelector(".rich-document-source-action") as any).click());
  const dateSource = advanced.querySelector("textarea") as HTMLTextAreaElement;
  dateSource.setSelectionRange(dateSource.value.length, dateSource.value.length);
  await act(async () => dateSource.dispatchEvent(new browser.KeyboardEvent("keydown", { key: "d", metaKey: true, bubbles: true, cancelable: true })));
  assert.match(dateSource.value.slice(initial[3].content.length), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} GMT[^ ]* \([^)]+\)$/);
  await act(async () => dateSource.dispatchEvent(new browser.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
  checks.push("advanced Markdown has readable preview and a lossless source fallback");

  await act(async () => (block("first").querySelector(".rich-document-grip") as any).click());
  await act(async () => (block("first").querySelector("button[aria-label='Move block down']") as any).click());
  assert.equal(moves.at(-1).id, "first");
  assert.equal(latestBlocks[1].id, "first");
  assert.equal(editor("first"), first, "Reordering must retain existing editor/undo identity.");
  assert.equal(first.view.dom.getAttribute("aria-label"), "Document block 2", "A moved editor's accessible label must reflect its current position without recreating it.");
  checks.push("keyboard-accessible block reorder retains editor identity");

  const linkButton = () => [...block("first").querySelectorAll('button')].find((button) => button.textContent === 'Link') as any;
  await act(async () => linkButton().click());
  const linkField = block("first").querySelector('input[aria-label="Link address"]') as any;
  assert(linkField);
  await act(async () => linkField.click());
  assert(block("first").querySelector('.rich-document-link-form'), "Clicking inside the link editor keeps it open.");
  await act(async () => (block("first").querySelector('select') as any).click());
  assert.equal(block("first").querySelector('.rich-document-link-form'), null, "Clicking elsewhere in the toolbar closes the nested link editor.");
  assert(block("first").querySelector('.rich-document-toolbar'));
  await act(async () => linkButton().click());
  await act(async () => editor("empty").view.dom.click());
  assert.equal(block("first").querySelector('.rich-document-toolbar'), null, "An outside editor click closes formatting despite editor click propagation guards.");
  await act(async () => (block("first").querySelector('.rich-document-grip') as any).click());
  assert.equal(block("first").querySelector('.rich-document-link-form'), null, "Reopening formatting does not reopen the dismissed link editor.");
  await act(async () => (block("first").querySelector('.rich-document-grip') as any).click());
  checks.push("formatting and nested link popups dismiss on outside clicks while preserving inside clicks");

  const features = "## Heading\n\n- [x] complete\n- [ ] todo\n\n| A | B |\n| :--- | ---: |\n| **bold** | text |\n\n```ts\nconst answer = 42;\n```\n\nA ==highlight== and ~~strike~~.\n\n> Nested **quote**.\n\n1. first\n   - child\n2. second\n\nAn [editable link](https://example.com) &amp; escaped \\*stars\\*.";
  const featureEditor = new Editor({ extensions: createRichDocumentExtensions(), content: features, contentType: "markdown" });
  const roundtrip = featureEditor.getMarkdown();
  assert(roundtrip.includes("- [x] complete"));
  assert(roundtrip.includes("**bold**"));
  assert(roundtrip.includes("const answer = 42;"));
  assert(roundtrip.includes("==highlight=="));
  assert(roundtrip.includes("~~strike~~"));
  const second = new Editor({ extensions: createRichDocumentExtensions(), content: roundtrip, contentType: "markdown" });
  assert.deepEqual(second.getJSON(), featureEditor.getJSON(), "Supported formatted features must survive edit/save/reload.");
  assert.equal(splitRichDocumentMarkdown(features).join(""), features);
  assert(splitRichDocumentMarkdown(features).length >= 5);
  assert.equal(getRichDocumentFallbackReason("```mermaid\ngraph TD; A-->B\n```"), "Diagram");
  assert.equal(getRichDocumentFallbackReason("~~~mermaid\ngraph TD; A-->B\n~~~"), "Diagram");
  assert.equal(getRichDocumentFallbackReason("```html\n<!-- A [[literal]] code example -->\n<img src='demo'>\n```"), null, "Literal code examples remain directly editable code, not advanced Markdown fallback.");
  featureEditor.destroy(); second.destroy();
  checks.push("headings, task lists, tables, code, highlights, and strike safely roundtrip");

  await act(async () => updateBlocks([]));
  await settle();
  const emptyDraft = (container.querySelector('.is-continuation .tiptap') as any).editor as InstanceType<typeof Editor>;
  assert(emptyDraft.view.dom.getAttribute('data-placeholder')?.includes('Space'));
  assert.equal(container.querySelector('.rich-document-hint, .rich-document-add'), null);
  assert(![...container.querySelectorAll('button')].some((button) => button.textContent?.includes('Add a block') || button.textContent === 'Add block'));
  const beforeEmptyFocus = { updates: updates.length, insertions: insertions.length };
  await act(async () => emptyDraft.commands.focus());
  await settle();
  assert.deepEqual({ updates: updates.length, insertions: insertions.length }, beforeEmptyFocus,
    "Mounting and focusing the empty writing area never persists a blank block");
  await act(async () => emptyDraft.commands.insertContent('First typed paragraph'));
  await settle();
  assert.equal(latestBlocks.length, 1);
  const firstTypedId = latestBlocks[0].id;
  assert.equal(latestBlocks[0].content, 'First typed paragraph');
  assert.equal(editor(firstTypedId), emptyDraft, "Saving the first text retains the actual editor, undo stack, and IME/caret identity");
  assert.equal(emptyDraft.state.selection.from, emptyDraft.state.doc.content.size - 1);
  assert(emptyDraft.isFocused);
  checks.push("empty writing area persists only typing while retaining editor and caret identity");

  await key(emptyDraft.view, 'Enter');
  await settle();
  const secondTypedId = latestBlocks[1].id;
  await act(async () => editor(secondTypedId).commands.insertContent('Second paragraph'));
  const beforeAppend = structuredClone(latestBlocks);
  const continuation = (container.querySelector('.is-continuation .tiptap') as any).editor as InstanceType<typeof Editor>;
  const insertionsBeforeFocus = insertions.length;
  await act(async () => continuation.commands.focus());
  await settle();
  assert.equal(insertions.length, insertionsBeforeFocus);
  await act(async () => continuation.commands.insertContent('Third paragraph from the blank end area'));
  await settle();
  assert.deepEqual(latestBlocks.slice(0, 2), beforeAppend, "Appending leaves existing blocks and their metadata intact");
  assert.equal(latestBlocks[2].content, 'Third paragraph from the blank end area');
  assert.equal(editor(latestBlocks[2].id), continuation);
  checks.push("Enter and the blank end area append paragraphs without changing earlier blocks");

  const aiContinuation = (container.querySelector('.is-continuation .tiptap') as any).editor as InstanceType<typeof Editor>;
  await act(async () => aiContinuation.commands.focus());
  await key(aiContinuation.view, ' ');
  await settle();
  const aiBlock = latestBlocks.at(-1);
  assert.equal(invocations.at(-1).blockId, aiBlock.id, "AI receives a real insertion target after an explicit Space invocation");
  assert.equal(aiBlock.content, '');
  assert.equal(editor(aiBlock.id), aiContinuation);
  await act(async () => invocations.at(-1).restoreFocus({ restoreSpaces: true }));
  assert.equal(aiContinuation.getText(), ' ', "Dismissal restores the literal space and caret even when empty-paragraph Markdown serializes it away");
  assert(aiContinuation.isFocused);
  checks.push("the blank end area's Space shortcut preserves AI insertion and dismissal behavior");

  const specialBlocks = [
    { ...initial[0], id: 'diagram', content: '```mermaid\ngraph TD; A-->B\n```' },
    { ...initial[0], id: 'code', content: '```ts\nconst result = 42;\n```' },
  ];
  await act(async () => updateBlocks(specialBlocks));
  await settle();
  const afterSpecial = (container.querySelector('.is-continuation .tiptap') as any).editor as InstanceType<typeof Editor>;
  await act(async () => { afterSpecial.commands.focus(); afterSpecial.commands.insertContent('A paragraph after the diagram and code.'); });
  assert.deepEqual(latestBlocks.slice(0, 2), specialBlocks);
  assert.equal(latestBlocks.at(-1).content, 'A paragraph after the diagram and code.');
  checks.push("writing after diagrams and code preserves their original source blocks");
  console.log(JSON.stringify({ checks }));
} finally {
  await act(async () => root.unmount());
  await browser.happyDOM.close();
}
