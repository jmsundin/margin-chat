import assert from "node:assert/strict";
import { Window } from "happy-dom";

const browser = new Window({ url: "http://continuous-editor.test" });
for (const name of ["window", "document", "navigator", "HTMLElement", "Element", "Node", "NodeFilter", "Text", "Document", "DocumentFragment", "MutationObserver", "ResizeObserver", "Event", "MouseEvent", "KeyboardEvent", "Range", "DOMRect", "DOMParser", "getComputedStyle", "HTMLInputElement", "HTMLTextAreaElement", "ShadowRoot"]) {
  const value = name === "window" ? browser : (browser as any)[name];
  if (value !== undefined) Object.defineProperty(globalThis, name, { configurable: true, value: name === "getComputedStyle" ? value.bind(browser) : value });
}
Object.defineProperty(globalThis, "requestAnimationFrame", { configurable: true, value: (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0) });
Object.defineProperty(globalThis, "cancelAnimationFrame", { configurable: true, value: clearTimeout });
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const { act, createElement, useState } = await import("react");
const { createRoot } = await import("react-dom/client");
const { EditorView } = await import("@tiptap/pm/view");
const { default: RichDocumentEditor } = await import("../../client/src/components/RichDocumentEditor");

const checks: string[] = [];
const date = "2026-10-11T12:00:00.000Z";
let viewUpdates = 0;
const updateState = EditorView.prototype.updateState;
EditorView.prototype.updateState = function (this: any, state: any) {
  viewUpdates += 1;
  if (viewUpdates > 5000) { console.error("The editor kept updating itself."); process.exit(1); }
  return updateState.call(this, state);
};

type Block = { id: string; kind: "markdown"; content: string; createdAt: string; updatedAt: string; [key: string]: unknown };
const line = (id: string, content: string, extra: Record<string, unknown> = {}): Block => ({ id, kind: "markdown", content, createdAt: date, updatedAt: date, ...extra });
const ai = { sourceMessageId: "answer", generationId: "generation" };

async function settle() { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); }); }
async function mount(initial: Block[]) {
  const state = { blocks: initial, saves: 0, selections: [] as any[], set: null as unknown as (blocks: Block[]) => void };
  function Host() {
    const [blocks, setBlocks] = useState(initial);
    state.blocks = blocks;
    state.set = setBlocks;
    return createElement(RichDocumentEditor, {
      conversationId: "lines", blocks, sourceMessages: [{ id: "answer", role: "assistant" }],
      onChangeBlocks(next: Block[]) { state.saves += 1; setBlocks(next); },
      onSelectionChange(value: unknown) { state.selections.push(value); },
    });
  }
  const container = browser.document.createElement("div");
  browser.document.body.append(container);
  const root = createRoot(container as unknown as Element);
  await act(async () => root.render(createElement(Host)));
  await settle();
  const editor = (container.querySelector(".tiptap") as any).editor;
  return {
    state, editor,
    /** The document position just before `text`, plus `offset`. */
    at(text: string, offset = 0) {
      let found = -1;
      editor.state.doc.descendants((node: any, position: number) => { if (found < 0 && node.isText && node.text.includes(text)) found = position + node.text.indexOf(text); });
      assert(found >= 0, `Missing text ${text}`);
      return found + offset;
    },
    lines: () => { const out: string[] = []; editor.state.doc.forEach((node: any) => out.push(`${node.attrs.id}:${node.childCount}`)); return out; },
    async key(name: string) {
      const event = new browser.KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true });
      await act(async () => { editor.view.dom.dispatchEvent(event); });
      await settle();
    },
    async run(command: () => void) { await act(async () => { editor.commands.focus(); command(); }); await settle(); },
    async unmount() { await act(async () => root.unmount()); container.remove(); },
  };
}
const saved = (blocks: Block[]) => blocks.map((block) => ({ id: block.id, content: block.content, sourceMessageId: block.sourceMessageId, generationId: block.generationId, authorship: block.authorship }));

try {
  {
    // An autolinked word on open must not count as an edit that splits saved blocks.
    viewUpdates = 0;
    const doc = await mount([line("first", "Read the notes in app.py\n\nSecond para"), line("answer", "P1 text\n\nP2 text\n\nP3 text", ai), line("last", "Last")]);
    assert.equal(doc.state.saves, 0, "Opening a document never saves it.");
    assert.deepEqual(doc.lines().slice(0, 3), ["first:2", "answer:3", "last:1"], "Opening keeps saved multi-line blocks together.");
    assert(viewUpdates < 20, `Opening settles (${viewUpdates} view updates).`);
    let links = 0;
    doc.editor.state.doc.descendants((node: any) => { if (node.marks?.some((mark: any) => mark.type.name === "link")) links += 1; });
    assert.equal(links, 0, "Opening does not autolink saved text.");
    await doc.unmount();
    checks.push("opening a document with autolinkable text and multi-line blocks neither saves nor loops");
  }

  {
    // Backspace at the start of a multi-line block joins only its first line; the block keeps its identity.
    const doc = await mount([line("intro", "Intro", { authorship: "user" }), line("answer", "P1 text\n\nP2 text\n\nP3 text", ai)]);
    await doc.run(() => doc.editor.commands.setTextSelection(doc.at("P1 text")));
    await doc.key("Backspace");
    const [intro, answer, rest] = saved(doc.state.blocks);
    assert.deepEqual(intro, { id: "intro", content: "IntroP1 text", sourceMessageId: undefined, generationId: undefined, authorship: "user" });
    assert.deepEqual(answer, { id: "answer", content: "P2 text", ...ai, authorship: "ai" });
    assert.deepEqual({ ...rest, id: undefined }, { id: undefined, content: "P3 text", ...ai, authorship: "ai" });
    await doc.unmount();

    const forward = await mount([line("intro", "Intro", { authorship: "user" }), line("answer", "P1 text\n\nP2 text", ai)]);
    await forward.run(() => forward.editor.commands.setTextSelection(forward.at("Intro", 5)));
    await forward.key("Delete");
    assert.deepEqual(saved(forward.state.blocks).map((block) => [block.id, block.content, block.generationId]), [["intro", "IntroP1 text", undefined], ["answer", "P2 text", "generation"]]);
    await forward.unmount();
    checks.push("Backspace and Delete at a line's edge keep the joined block's identity and provenance on its remaining lines");
  }

  {
    // The editor's own joins stay inside a block: Backspace at the start of a quote unwraps it.
    const doc = await mount([line("intro", "Intro", { authorship: "user" }), line("quote", "> quoted text", ai)]);
    await doc.run(() => doc.editor.commands.setTextSelection(doc.at("quoted text")));
    await doc.key("Backspace");
    assert.deepEqual(saved(doc.state.blocks).map((block) => [block.id, block.content]), [["intro", "Intro"], ["quote", "quoted text"]]);
    await doc.unmount();

    const list = await mount([line("list", "- one\n- two", { authorship: "user" }), line("after", "After", { authorship: "user" })]);
    await list.run(() => list.editor.commands.setTextSelection(list.at("two", 3)));
    await list.key("Delete");
    assert.deepEqual(saved(list.state.blocks).map((block) => [block.id, block.content]), [["list", "- one\n- twoAfter"]], "Delete at the end of a list joins the next line into it.");
    await list.unmount();
    checks.push("joins inside a quote or list never move a line into another block's identity");
  }

  {
    // Only text that was in a line keeps that line's AI provenance.
    const pasted = await mount([line("answer", "AI line", ai)]);
    await pasted.run(() => {
      pasted.editor.commands.setTextSelection(pasted.at("AI line", 7));
      pasted.editor.commands.insertContent([{ type: "paragraph", content: [{ type: "text", text: "Mine" }] }, { type: "paragraph", content: [{ type: "text", text: "My own paragraph" }] }]);
    });
    const [answer, ...mine] = saved(pasted.state.blocks);
    assert.deepEqual(answer, { id: "answer", content: "AI line", ...ai, authorship: undefined });
    assert.deepEqual(mine.map((block) => [block.content, block.sourceMessageId, block.generationId, block.authorship]), [["Mine", undefined, undefined, "user"], ["My own paragraph", undefined, undefined, "user"]]);
    await pasted.unmount();

    const split = await mount([line("answer", "First half second half", ai)]);
    await split.run(() => split.editor.commands.setTextSelection(split.at(" second")));
    await split.key("Enter");
    assert.deepEqual(saved(split.state.blocks).map((block) => [block.content.trim(), block.generationId, block.authorship]), [["First half", "generation", "mixed"], ["second half", "generation", "mixed"]],
      "Enter inside an AI line splits it into two edited AI lines.");
    await split.unmount();

    const pushed = await mount([line("answer", "AI line", ai)]);
    await pushed.run(() => pushed.editor.commands.setTextSelection(pushed.at("AI line")));
    await pushed.key("Enter");
    const [blank, moved] = pushed.state.blocks;
    assert.equal(moved, pushed.state.blocks.find((block) => block.id === "answer"), "Enter at the start of a line moves the line down unchanged.");
    assert.deepEqual([blank.content, blank.generationId, blank.authorship], ["", undefined, "user"]);
    await pushed.unmount();

    const typed = await mount([line("answer", "AI line", ai)]);
    await typed.run(() => typed.editor.commands.setTextSelection(typed.at("AI line", 7)));
    await typed.key("Enter");
    await typed.run(() => typed.editor.commands.insertContent("Mine"));
    assert.deepEqual(saved(typed.state.blocks).map((block) => [block.content, block.generationId, block.authorship]), [["AI line", "generation", undefined], ["Mine", undefined, "user"]]);
    await typed.unmount();
    checks.push("pasted or typed lines are the user's; text split off an AI line stays in its generation");
  }

  {
    // A selection that only reaches the start of the next line does not include it.
    const doc = await mount([line("alpha", "Alpha"), line("beta", "Beta"), line("gamma", "Gamma")]);
    await doc.run(() => {});
    await doc.run(() => doc.editor.commands.setTextSelection({ from: doc.at("Alpha"), to: doc.at("Beta") }));
    const reach = doc.state.selections.at(-1);
    assert.equal(reach?.sourceBlockId, "alpha");
    assert.equal(reach?.quote, "Alpha");
    assert.equal(reach?.joinBlockIds, undefined);
    await doc.run(() => doc.editor.commands.setTextSelection({ from: doc.at("Alpha", 5), to: doc.at("Gamma", 2) }));
    const start = doc.state.selections.at(-1);
    assert.deepEqual([start?.sourceBlockId, start?.quote, start?.joinBlockIds], ["beta", "Beta\n\nGa", ["gamma"]], "A selection starting at a line's end leaves that line out.");
    await doc.run(() => doc.editor.commands.setTextSelection({ from: doc.at("Alpha", 5), to: doc.at("Beta") }));
    assert.equal(doc.state.selections.at(-1), null, "Selecting only a line break selects no passage.");
    await doc.unmount();
    checks.push("a selection that only touches the edge of a line leaves that line out of the passage");
  }

  {
    // Saved changes across lines (redo, AI output) replace those lines, never duplicate them.
    const doc = await mount([line("only", "")]);
    await act(async () => doc.state.set([line("only", "abc"), line("next", "def")]));
    await settle();
    const lines: string[] = [];
    doc.editor.state.doc.forEach((node: any) => lines.push(`${node.attrs.id}:${node.textContent}`));
    assert.deepEqual(lines.slice(0, 2), ["only:abc", "next:def"]);
    assert.equal(lines.length, 3, "Only the empty typing line follows the saved lines.");
    assert.equal(doc.state.saves, 0);
    await doc.unmount();
    checks.push("saved changes that span lines replace them in place");
  }

  console.log(JSON.stringify({ checks }));
} finally {
  await browser.happyDOM.close();
}
