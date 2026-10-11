import assert from "node:assert/strict";

/**
 * A document is one editor; each block is a top-level node in it. This view of
 * one block keeps the positions tests use relative to the block, as they were
 * when every block had its own editor: position 0 is the block's start.
 */
export function blockEditor(root: ParentNode, id: string): any {
  const section = root.querySelector(`[data-document-block-id="${id.replace(/["\\]/g, "\\$&")}"]`);
  assert(section, `Missing block ${id}`);
  const dom = section.closest(".tiptap") as any;
  assert(dom?.editor, `Missing document editor for block ${id}`);
  const editor = dom.editor;
  const locate = () => {
    let found: { node: any; pos: number } | null = null;
    editor.state.doc.forEach((node: any, pos: number) => { if (!found && node.attrs.id === id) found = { node, pos }; });
    assert(found, `Block ${id} is not in the editor`);
    return found as { node: any; pos: number };
  };
  const start = () => locate().pos + 1;
  const end = () => { const { node, pos } = locate(); return pos + node.nodeSize - 1; };
  const inside = () => { const { from, to } = editor.state.selection; return from >= start() - 1 && to <= end() + 1; };
  const absolute = (value: number | { from: number; to: number }) => typeof value === "number" ? value + start() : { from: value.from + start(), to: value.to + start() };
  const commands: Record<string, (...args: any[]) => any> = {
    focus(at?: "start" | "end") {
      editor.commands.focus(undefined, { scrollIntoView: false });
      if (!inside() || at) editor.commands.setTextSelection(at === "end" ? end() - 1 : start() + 1);
      return true;
    },
    setTextSelection(value: number | { from: number; to: number }) { return editor.commands.setTextSelection(absolute(value)); },
    selectAll() { return editor.commands.setTextSelection({ from: start() + 1, to: end() - 1 }); },
    setContent(content: string, options?: { contentType?: string }) {
      // The editor parses Markdown into lines itself; a block holds those lines.
      const lines = options?.contentType === "markdown" ? content ? editor.markdown.parse(content).content ?? [] : [] : content;
      editor.commands.insertContentAt({ from: start(), to: end() }, lines?.length ? lines : { type: "paragraph" });
      return true;
    },
  };
  return {
    editor,
    view: editor.view,
    section,
    /** The document position of a position in this block. */
    position: (value: number) => value + start(),
    markdown: { serialize: (json: any) => editor.markdown.serialize({ type: "doc", content: json.content ?? [] }) },
    get state() {
      const { node } = locate();
      const offset = start();
      const selection = editor.state.selection;
      return { doc: node, selection: { from: selection.from - offset, to: selection.to - offset, empty: selection.empty } };
    },
    get isFocused() { return editor.isFocused && inside(); },
    get isEditable() { return editor.isEditable && !section.classList.contains("is-streaming"); },
    get isDestroyed() { return editor.isDestroyed; },
    getMarkdown() { return editor.markdown.serialize({ type: "doc", content: locate().node.toJSON().content ?? [] }); },
    getText() { return locate().node.textContent; },
    getJSON() { return { type: "doc", content: locate().node.toJSON().content ?? [] }; },
    isActive: (...args: any[]) => editor.isActive(...args),
    chain: () => editor.chain(),
    commands: new Proxy(commands, { get: (target, name: string) => target[name] ?? editor.commands[name] }),
  };
}

/**
 * The single editor that holds every block of a document. Reading or replacing
 * its Markdown covers every saved block, as reading one editor's Markdown did.
 */
const documentViews = new WeakMap<object, any>();
export function documentEditor(root: ParentNode): any {
  const dom = root.querySelector(".rich-document-editor .tiptap") as any;
  assert(dom?.editor, "Missing document editor");
  const editor = dom.editor;
  // One view per editor, so tests can compare editor identity.
  if (documentViews.has(editor)) return documentViews.get(editor);
  const commands = new Proxy({}, { get: (_target, name: string) => name === "setContent"
    ? (content: unknown, options?: { contentType?: string }) => typeof content === "string" ? (replaceDocument(editor, content), true) : editor.commands.setContent(content, options)
    : editor.commands[name] });
  const view = new Proxy(editor, { get: (target, name) => name === "getMarkdown" ? () => documentMarkdown(target) : name === "commands" ? commands : Reflect.get(target, name, target) });
  documentViews.set(editor, view);
  return view;
}

/** Every saved block's Markdown in order, skipping the empty line kept for typing after the document. */
export function documentMarkdown(editor: any): string {
  const blocks: string[] = [];
  editor.state.doc.forEach((node: any) => {
    if (!String(node.attrs.id ?? "").startsWith("draft:")) blocks.push(editor.markdown.serialize({ type: "doc", content: node.toJSON().content ?? [] }));
  });
  return blocks.join("\n\n");
}

/** Replace a whole document the way select-all and typing or pasting would. */
export function replaceDocument(editor: any, markdown: string) {
  // Selecting the text of every line, as a person would; positions are clamped to the first and last text.
  editor.commands.setTextSelection({ from: 0, to: editor.state.doc.content.size });
  // The editor parses Markdown into lines itself; the document node only holds blocks.
  if (markdown) editor.commands.insertContent(editor.markdown.parse(markdown).content ?? []);
  else editor.commands.deleteSelection();
}
