import { Extension, type Editor, type JSONContent } from "@tiptap/core";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { Markdown } from "@tiptap/markdown";
import { TableKit } from "@tiptap/extension-table";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import Highlight from "@tiptap/extension-highlight";
import CodeBlockLowlight from "@tiptap/extension-code-block-lowlight";
import { common, createLowlight } from "lowlight";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { DocumentBlock } from "@margin-chat/workspace-contracts";
import { renderObsidianMarkdownToHtml } from "../lib/markdown";
import { documentPositionAtMarkdownOffset, getRichDocumentFallbackReason, markdownOffsetAtDocumentPosition } from "../lib/richDocumentMarkdown";
import "./RichDocumentEditor.css";

export type RichDocumentRect = { left: number; top: number; width: number; height: number };
export interface RichDocumentSelection {
  conversationId: string;
  messageId: string;
  sourceBlockId: string;
  quote: string;
  startOffset: number;
  endOffset: number;
  rect: RichDocumentRect;
}
export interface RichDocumentInvocation {
  blockId: string;
  markdown: string;
  /** A UTF-16 offset in markdown, never a rendered-text or ProseMirror position. */
  offset: number;
  selection?: { startOffset: number; endOffset: number; quote: string };
  rect: RichDocumentRect;
  restoreFocus: (options?: { restoreSpaces?: boolean }) => void;
}
export interface RichDocumentDecoration {
  from: number;
  to: number;
  branchIds?: string[];
  noteIds?: string[];
}
export interface RichDocumentEditorProps {
  conversationId: string;
  blocks: DocumentBlock[];
  onUpdateBlock: (blockId: string, markdown: string) => void;
  onReorderBlock?: (blockId: string, beforeBlockId: string | null) => void;
  onSplitBlock?: (blockId: string, before: string, after: string) => string | void;
  onInsertBlock?: (afterBlockId: string | null, markdown: string) => string | void;
  onDeleteBlock?: (blockId: string) => void;
  onInvokeAI?: (invocation: RichDocumentInvocation) => void;
  onSelectionChange?: (selection: RichDocumentSelection | null) => void;
  readOnlyBlockIds?: string[];
  decorations?: Record<string, RichDocumentDecoration[]>;
  renderAfterBlock?: (block: DocumentBlock) => ReactNode;
  renderBlockPreview?: (block: DocumentBlock) => ReactNode;
  ariaLabel?: string;
  className?: string;
}

const lowlight = createLowlight(common);
export function createRichDocumentExtensions(extra: Extension[] = []) {
  return [
    StarterKit.configure({ link: { openOnClick: false }, underline: false, trailingNode: false, codeBlock: false }),
    CodeBlockLowlight.configure({ lowlight }),
    TableKit.configure({ table: { resizable: false, renderWrapper: true } }),
    TaskList, TaskItem.configure({ nested: true }), Highlight,
    Markdown.configure({ markedOptions: { gfm: true, breaks: false } }), ...extra,
  ];
}

function serialize(editor: Editor, content: JSONContent) { return editor.markdown!.serialize(content); }
function rawOffset(editor: Editor, markdown: string, position: number, affinity: -1 | 1 = 1) {
  return markdownOffsetAtDocumentPosition(editor.state.doc, (content) => serialize(editor, content), markdown, position, affinity);
}
function editorPosition(editor: Editor, markdown: string, offset: number, affinity: -1 | 1 = 1) {
  return documentPositionAtMarkdownOffset(editor.state.doc, (content) => serialize(editor, content), markdown, offset, affinity);
}
function cursorRect(editor: Editor): RichDocumentRect {
  try {
    const range = window.getSelection()?.rangeCount ? window.getSelection()!.getRangeAt(0).getBoundingClientRect() : null;
    if (range?.width || range?.height) return { left: range.left, top: range.top, width: range.width, height: range.height };
    const point = editor.view.coordsAtPos(editor.state.selection.head);
    return { left: point.left, top: point.top, width: point.right - point.left, height: point.bottom - point.top };
  } catch {
    const rect = editor.view.dom.getBoundingClientRect();
    return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
  }
}

function GripIcon() {
  return <svg width="16" height="20" viewBox="0 0 16 20" fill="currentColor" aria-hidden="true">{[5, 10, 15].flatMap((cy) => [5, 11].map((cx) => <circle key={`${cx}-${cy}`} cx={cx} cy={cy} r="1.3" />))}</svg>;
}

function documentDecorations(editor: Editor, markdown: string, ranges: RichDocumentDecoration[], blockId: string): DecorationSet {
  const valid = ranges.filter((range) => range.to > range.from && range.from >= 0 && range.to <= markdown.length);
  const boundaries = [...new Set(valid.flatMap((range) => [range.from, range.to]))].sort((a, b) => a - b);
  const decorations: Decoration[] = [];
  let headingIndex = 0;
  editor.state.doc.descendants((node, position) => {
    if (node.type.name === "heading" && node.attrs.level <= 3) decorations.push(Decoration.node(position, position + node.nodeSize, { "data-chat-outline-id": `heading-document:${blockId}-${headingIndex++}` }));
  });
  let trailingPosition = editor.state.doc.content.size;
  for (let index = editor.state.doc.childCount - 1; index > 0; index -= 1) {
    const node = editor.state.doc.child(index);
    trailingPosition -= node.nodeSize;
    if (node.type.name !== "paragraph" || node.textContent.trim()) break;
    decorations.push(Decoration.node(trailingPosition, trailingPosition + node.nodeSize, { class: "rich-document-trailing-space" }));
  }
  for (let index = 0; index < boundaries.length - 1; index += 1) {
    const start = boundaries[index];
    const end = boundaries[index + 1];
    const active = valid.filter((range) => range.from <= start && range.to >= end);
    if (!active.length) continue;
    const from = editorPosition(editor, markdown, start, 1);
    const to = editorPosition(editor, markdown, end, -1);
    if (to <= from) continue;
    const branches = [...new Set(active.flatMap((range) => range.branchIds ?? []))];
    const notes = [...new Set(active.flatMap((range) => range.noteIds ?? []))];
    decorations.push(Decoration.inline(from, to, {
      class: `message-anchor${notes.length ? " message-note-anchor" : ""}`,
      "data-annotation-branches": JSON.stringify(branches), "data-annotation-notes": JSON.stringify(notes),
      tabindex: "0", role: branches.length ? "link" : "button", "aria-label": branches.length && notes.length ? "Preview linked chats and notes" : branches.length ? "Preview linked chat" : "Preview linked note",
    }));
  }
  return DecorationSet.create(editor.state.doc, decorations);
}

type BlockProps = RichDocumentEditorProps & {
  block: DocumentBlock;
  index: number;
  focusBlock: (id: string | void, end?: boolean) => void;
  registerEditor: (id: string, editor: Editor | null) => void;
  onDragBlock: (id: string | null) => void;
  draggingBlock: string | null;
  editorIdentity?: string;
  isDraft?: boolean;
};

function RichBlock(props: BlockProps) {
  const { block, index } = props;
  const latest = useRef(props);
  latest.current = props;
  const content = useRef(block.content);
  const externalUpdate = useRef(false);
  const suppressSpace = useRef(false);
  const [sourceMode, setSourceMode] = useState(false);
  const [toolbarOpen, setToolbarOpen] = useState(false);
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkUrl, setLinkUrl] = useState("");
  const [, updateToolbar] = useState(0);
  const [focused, setFocused] = useState(false);
  const sourceRef = useRef<HTMLTextAreaElement>(null);
  const shellRef = useRef<HTMLElement>(null);
  const readOnly = props.readOnlyBlockIds?.includes(block.id) ?? false;
  const fallback = getRichDocumentFallbackReason(block.content);
  const editorSource = useRef(fallback ? "" : block.content);
  const editorRef = useRef<Editor | null>(null);
  const sourceId = block.sourceMessageId ?? `document:${block.id}`;
  const toolbarId = useId();

  function commit(editor: Editor) {
    const markdown = editor.getMarkdown();
    content.current = markdown;
    editorSource.current = markdown;
    latest.current.onUpdateBlock(latest.current.block.id, markdown);
    return markdown;
  }

  function notifySelection(editor: Editor) {
    if (!latest.current.onSelectionChange || !editor.isFocused) return;
    const { from, to, empty } = editor.state.selection;
    if (empty) { latest.current.onSelectionChange(null); return; }
    const startOffset = rawOffset(editor, content.current, from, 1);
    const endOffset = rawOffset(editor, content.current, to, -1);
    if (endOffset <= startOffset) return;
    const current = latest.current;
    current.onSelectionChange?.({ conversationId: current.conversationId, messageId: current.block.sourceMessageId ?? `document:${current.block.id}`, sourceBlockId: current.block.id,
      startOffset, endOffset, quote: content.current.slice(startOffset, endOffset), rect: cursorRect(editor) });
  }

  function invoke(editor: Editor, spaces = 0) {
    const current = latest.current;
    if (!current.onInvokeAI || current.readOnlyBlockIds?.includes(current.block.id)) return false;
    const { from, to, empty } = editor.state.selection;
    const markdown = content.current;
    const offset = rawOffset(editor, markdown, from);
    const endOffset = rawOffset(editor, markdown, to, -1);
    current.onInvokeAI({ blockId: current.block.id, markdown, offset, rect: cursorRect(editor),
      selection: !empty && endOffset > offset ? { startOffset: offset, endOffset, quote: markdown.slice(offset, endOffset) } : undefined,
      restoreFocus(options) {
        suppressSpace.current = true;
        if (editor.isDestroyed) return;
        const position = editorPosition(editor, content.current, Math.min(offset, content.current.length));
        editor.commands.focus();
        editor.commands.setTextSelection(position);
        if (options?.restoreSpaces && spaces) editor.commands.insertContent(" ".repeat(spaces));
      },
    });
    return true;
  }

  const editor: Editor | null = useEditor({
    extensions: createRichDocumentExtensions([
      Extension.create({
        name: "documentAnnotationRanges",
        addProseMirrorPlugins() {
          const editor = this.editor;
          return [new Plugin({ key: new PluginKey("documentAnnotationRanges"), props: {
            decorations() { return documentDecorations(editor, content.current, latest.current.decorations?.[latest.current.block.id] ?? [], latest.current.block.id); },
          } })];
        },
      }),
    ]),
    content: fallback ? "" : block.content,
    contentType: "markdown",
    editable: !readOnly,
    immediatelyRender: false,
    shouldRerenderOnTransaction: false,
    editorProps: {
      attributes: { class: "rich-document-content message-content", role: "textbox", "aria-multiline": "true", "aria-label": `Document block ${index + 1}`,
        "data-placeholder": props.onInvokeAI ? "Write here, or press Space for AI…" : "Write here…", spellcheck: "true" },
      handleKeyDown(view, event): boolean {
        const currentEditor = editorRef.current;
        if (!currentEditor || event.isComposing || view.composing || event.repeat || latest.current.readOnlyBlockIds?.includes(latest.current.block.id)) return false;
        if (event.target instanceof Element && event.target.closest(".message-anchor") && (event.key === " " || event.key === "Enter")) {
          // The annotation preview/source handler owns activation of a focused saved highlight.
          event.preventDefault();
          return true;
        }
        if (event.key !== " ") suppressSpace.current = false;
        const { $from, empty, from } = view.state.selection;
        const plainModifier = !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey;
        const inCode = $from.parent.type.spec.code || $from.marks().some((mark) => mark.type.name === "code");
        if (event.key === " " && plainModifier && empty && !inCode && !suppressSpace.current && latest.current.onInvokeAI) {
          const emptyParagraph = $from.depth === 1 && $from.parent.isTextblock && !$from.parent.textContent;
          const preceding = $from.parent.textBetween(0, $from.parentOffset, "", "");
          // Two deliberate spaces after text summon AI; indentation and code stay ordinary typing.
          const doubleSpace = /\S $/.test(preceding);
          if (emptyParagraph || doubleSpace) {
            event.preventDefault();
            if (doubleSpace) currentEditor.commands.deleteRange({ from: from - 1, to: from });
            return invoke(currentEditor, doubleSpace ? 2 : 1);
          }
        }
        if (event.key === "Enter" && plainModifier && empty && $from.depth === 1 && ["paragraph", "heading"].includes($from.parent.type.name) && latest.current.onSplitBlock) {
          event.preventDefault();
          // Split the structured document, so marks/headings are closed on both sides.
          const before = serialize(currentEditor, view.state.doc.cut(0, from).toJSON());
          const after = serialize(currentEditor, view.state.doc.cut(from).toJSON());
          const id = latest.current.onSplitBlock(latest.current.block.id, before, after);
          latest.current.focusBlock(id);
          return true;
        }
        if (event.key === "Backspace" && plainModifier && empty && !view.state.doc.textContent && view.state.doc.childCount === 1 && (latest.current.blocks.length > 1 || latest.current.isDraft) && latest.current.onDeleteBlock) {
          event.preventDefault();
          const previous = latest.current.blocks[latest.current.index - 1];
          latest.current.onDeleteBlock(latest.current.block.id);
          if (previous) latest.current.focusBlock(previous.id, true);
          return true;
        }
        if (plainModifier && empty && (event.key === "ArrowUp" && from <= 1 || event.key === "ArrowDown" && from >= view.state.doc.content.size - 1)) {
          const direction = event.key === "ArrowUp" ? -1 : 1;
          const neighbor = latest.current.blocks[latest.current.index + direction];
          if (neighbor && !latest.current.readOnlyBlockIds?.includes(neighbor.id)) {
            event.preventDefault();
            latest.current.focusBlock(neighbor.id, direction < 0);
            return true;
          }
        }
        if (event.key === "Escape") {
          setToolbarOpen(false);
          latest.current.onSelectionChange?.(null);
        }
        return false;
      },
      handleDOMEvents: {
        mouseup() { const editor = editorRef.current; if (editor) queueMicrotask(() => { if (!editor.isDestroyed) notifySelection(editor); }); return false; },
      },
    },
    onUpdate({ editor }) { if (!externalUpdate.current) commit(editor); },
    onSelectionUpdate({ editor }) { notifySelection(editor); if (editor.isFocused) updateToolbar((value) => value + 1); },
    onFocus() { setFocused(true); },
    onBlur() { setFocused(false); },
  }, [props.editorIdentity ?? block.id]);
  editorRef.current = editor;

  useLayoutEffect(() => {
    if (!editor) return;
    props.registerEditor(block.id, editor);
    return () => props.registerEditor(block.id, null);
  }, [editor, block.id]);

  useLayoutEffect(() => {
    if (!editor) return;
    content.current = block.content;
    if (block.content === editorSource.current || fallback || sourceMode) return;
    externalUpdate.current = true;
    try { editor.commands.setContent(block.content, { contentType: "markdown", emitUpdate: false }); editorSource.current = block.content; }
    finally { externalUpdate.current = false; }
  }, [editor, block.content, fallback, sourceMode]);

  useEffect(() => { editor?.setEditable(!readOnly, false); }, [editor, readOnly]);
  useEffect(() => {
    if (!editor) return;
    const editorProps = editor.options.editorProps;
    editor.setOptions({ editorProps: { ...editorProps, attributes: { ...(typeof editorProps.attributes === "object" ? editorProps.attributes : {}), "aria-label": `Document block ${index + 1}` } } });
  }, [editor, index]);
  useEffect(() => {
    if (editor && !editor.isDestroyed) editor.view.dispatch(editor.state.tr.setMeta("documentAnnotationRanges", true));
  }, [editor, props.decorations?.[block.id]]);
  useLayoutEffect(() => {
    shellRef.current?.querySelectorAll("h1,h2,h3").forEach((heading, headingIndex) => { (heading as HTMLElement).dataset.chatOutlineId = `heading-document:${block.id}-${headingIndex}`; });
    if (sourceRef.current) { sourceRef.current.style.height = "auto"; sourceRef.current.style.height = `${Math.max(96, sourceRef.current.scrollHeight)}px`; }
  }, [block.content, sourceId, sourceMode, editor]);

  function finishSource() {
    setSourceMode(false);
    if (editor && !getRichDocumentFallbackReason(content.current)) {
      externalUpdate.current = true;
      editor.commands.setContent(content.current, { contentType: "markdown", emitUpdate: false });
      editorSource.current = content.current;
      externalUpdate.current = false;
      editor.commands.focus();
    }
  }
  function sourceSelection() {
    const field = sourceRef.current;
    if (!field || field.selectionStart === field.selectionEnd) return;
    const { selectionStart: startOffset, selectionEnd: endOffset } = field;
    const rect = field.getBoundingClientRect();
    props.onSelectionChange?.({ conversationId: props.conversationId, messageId: sourceId, sourceBlockId: block.id, quote: field.value.slice(startOffset, endOffset), startOffset, endOffset,
      rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height } });
  }

  function format(value: string) {
    if (!editor) return;
    const chain = editor.chain().focus();
    if (value === "paragraph") chain.setParagraph().run();
    else if (value === "heading1") chain.toggleHeading({ level: 1 }).run();
    else if (value === "heading2") chain.toggleHeading({ level: 2 }).run();
    else if (value === "heading3") chain.toggleHeading({ level: 3 }).run();
    else if (value === "bullet") chain.toggleBulletList().run();
    else if (value === "ordered") chain.toggleOrderedList().run();
    else if (value === "task") chain.toggleTaskList().run();
    else if (value === "quote") chain.toggleBlockquote().run();
    else if (value === "code") chain.toggleCodeBlock().run();
    else if (value === "table") chain.insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run();
    updateToolbar((value) => value + 1);
  }

  return <section ref={shellRef} className={`rich-document-block${focused ? " is-focused" : ""}${props.draggingBlock === block.id ? " is-dragging" : ""}${readOnly ? " is-streaming" : ""}${props.isDraft ? " is-continuation" : ""}${!block.content ? " is-empty" : ""}`}
    data-document-block-id={block.id} data-message-id={sourceId} data-conversation-id={props.conversationId} data-message-bubble="true" data-selection-source="document" data-chat-outline-id={`message-document:${block.id}`}
    onDragOver={(event) => { if (props.draggingBlock && props.draggingBlock !== block.id && props.onReorderBlock && !readOnly) { event.preventDefault(); event.dataTransfer.dropEffect = "move"; } }}
    onDrop={(event) => { if (props.draggingBlock && props.draggingBlock !== block.id && props.onReorderBlock && !readOnly) { event.preventDefault(); event.stopPropagation(); props.onReorderBlock(props.draggingBlock, block.id); props.onDragBlock(null); } }}>
    <div className="rich-document-block-gutter" contentEditable={false}>
      <button type="button" className="rich-document-grip" aria-label={`Block ${index + 1} actions and formatting`} title="Drag to move · Click for formatting" aria-expanded={toolbarOpen} aria-controls={toolbarId}
        disabled={readOnly || props.isDraft} draggable={Boolean(props.onReorderBlock) && !readOnly && !props.isDraft}
        onDragStart={(event) => { event.stopPropagation(); props.onDragBlock(block.id); event.dataTransfer.setData("application/x-margin-document-block", block.id); event.dataTransfer.effectAllowed = "move"; }}
        onDragEnd={() => props.onDragBlock(null)}
        onClick={(event) => { event.stopPropagation(); setToolbarOpen((value) => !value); }}><GripIcon /></button>
    </div>
    <div className="rich-document-block-main">
      {toolbarOpen && !readOnly && <div id={toolbarId} className="rich-document-toolbar" role="group" aria-label={`Format block ${index + 1}`} onClick={(event) => event.stopPropagation()}>
        {!fallback && !sourceMode && editor && <>
          <select aria-label="Block type" value={editor.isActive("heading", { level: 1 }) ? "heading1" : editor.isActive("heading", { level: 2 }) ? "heading2" : editor.isActive("heading", { level: 3 }) ? "heading3" : editor.isActive("taskList") ? "task" : editor.isActive("bulletList") ? "bullet" : editor.isActive("orderedList") ? "ordered" : editor.isActive("codeBlock") ? "code" : editor.isActive("blockquote") ? "quote" : "paragraph"} onChange={(event) => format(event.target.value)}>
            <option value="paragraph">Text</option><option value="heading1">Heading 1</option><option value="heading2">Heading 2</option><option value="heading3">Heading 3</option><option value="bullet">Bullet list</option><option value="ordered">Numbered list</option><option value="task">Checklist</option><option value="quote">Quote</option><option value="code">Code</option><option value="table">Table</option>
          </select>
          {([
            ["Bold", "bold", () => editor.chain().focus().toggleBold().run(), <strong key="b">B</strong>],
            ["Italic", "italic", () => editor.chain().focus().toggleItalic().run(), <em key="i">I</em>],
            ["Strikethrough", "strike", () => editor.chain().focus().toggleStrike().run(), <s key="s">S</s>],
            ["Highlight", "highlight", () => editor.chain().focus().toggleHighlight().run(), <span key="h">Highlight</span>],
            ["Inline code", "code", () => editor.chain().focus().toggleCode().run(), <span key="c">&lt;/&gt;</span>],
          ] as const).map(([label, name, action, text]) => <button key={name} type="button" aria-label={label} title={label} aria-pressed={editor.isActive(name)} onMouseDown={(event) => event.preventDefault()} onClick={() => { action(); updateToolbar((value) => value + 1); }}>{text}</button>)}
          <button type="button" aria-pressed={editor.isActive("link")} onMouseDown={(event) => event.preventDefault()} onClick={() => { setLinkUrl(editor.getAttributes("link").href ?? ""); setLinkOpen((value) => !value); }}>Link</button>
          {editor.isActive("table") && <><button type="button" onClick={() => editor.chain().focus().addRowAfter().run()}>+ Row</button><button type="button" onClick={() => editor.chain().focus().addColumnAfter().run()}>+ Column</button></>}
        </>}
        {props.onInvokeAI && <button type="button" className="rich-document-ask" onMouseDown={(event) => event.preventDefault()} onClick={() => { if (editor && !fallback && !sourceMode) invoke(editor); else { const field = sourceRef.current; props.onInvokeAI?.({ blockId: block.id, markdown: content.current, offset: field?.selectionStart ?? content.current.length, rect: shellRef.current!.getBoundingClientRect(), restoreFocus() { field?.focus(); } }); } }}>Ask AI</button>}
        <button type="button" onClick={() => { if (sourceMode) finishSource(); else { setSourceMode(true); setTimeout(() => sourceRef.current?.focus(), 0); } }}>{sourceMode ? "Done" : "Edit Markdown"}</button>
        {props.onReorderBlock && <><button type="button" disabled={!index} onClick={() => props.onReorderBlock?.(block.id, props.blocks[index - 1].id)} aria-label="Move block up">↑</button><button type="button" disabled={index === props.blocks.length - 1} onClick={() => props.onReorderBlock?.(block.id, props.blocks[index + 2]?.id ?? null)} aria-label="Move block down">↓</button></>}
        <button type="button" className="rich-document-toolbar-close" aria-label="Close block actions" onClick={() => setToolbarOpen(false)}>×</button>
        {linkOpen && editor && <form className="rich-document-link-form" onSubmit={(event) => { event.preventDefault(); if (!linkUrl.trim()) editor.chain().focus().extendMarkRange("link").unsetLink().run(); else editor.chain().focus().extendMarkRange("link").setLink({ href: linkUrl.trim() }).run(); setLinkOpen(false); }}>
          <input aria-label="Link address" placeholder="https://…" value={linkUrl} onChange={(event) => setLinkUrl(event.target.value)} autoFocus />
          <button type="submit">Apply link</button><button type="button" onClick={() => { editor.chain().focus().extendMarkRange("link").unsetLink().run(); setLinkOpen(false); }}>Remove link</button>
        </form>}
      </div>}
      {readOnly && <div className="rich-document-streaming-label" role="status">Writing…</div>}
      {sourceMode ? <div className="rich-document-source"><div className="rich-document-source-label"><span>Markdown source</span><button type="button" onClick={finishSource}>Done</button></div><textarea ref={sourceRef} value={block.content} readOnly={readOnly} aria-label={`Markdown for block ${index + 1}`} spellCheck={false}
        onChange={(event) => { content.current = event.target.value; props.onUpdateBlock(block.id, event.target.value); }} onSelect={sourceSelection}
        onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); finishSource(); } }} /></div>
        : fallback ? <div className="rich-document-preserved"><div className="rich-document-preserved-preview">{props.renderBlockPreview?.(block) ?? (typeof window === "undefined" ? <pre>{block.content}</pre> : <div className="message-content" dangerouslySetInnerHTML={{ __html: renderObsidianMarkdownToHtml(block.content) }} />)}</div><button type="button" className="rich-document-source-action" disabled={readOnly} onClick={() => { setSourceMode(true); setTimeout(() => sourceRef.current?.focus(), 0); }}>Edit {fallback.toLowerCase()} source</button></div>
        : <EditorContent editor={editor} />}
    </div>
    {props.renderAfterBlock?.(block)}
  </section>;
}

export default function RichDocumentEditor(props: RichDocumentEditorProps) {
  const editors = useRef(new Map<string, Editor>());
  const pendingFocus = useRef<{ id: string; end: boolean } | null>(null);
  const [draggingBlock, setDraggingBlock] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const draftIdentity = useId();
  const [draftNumber, setDraftNumber] = useState(0);
  // The blank continuation is local until an edit. Keep its React/Tiptap key
  // when it receives a saved ID so typing, composition, and undo stay intact.
  const draftIds = useRef(new Map<string, string>());
  const editorIdentities = useRef(new Map<string, string>());
  const draft: DocumentBlock = { id: `draft:${props.conversationId}:${draftIdentity}:${draftNumber}`, kind: "markdown", content: "", createdAt: "", updatedAt: "" };
  const lastBlock = props.blocks.at(-1);
  const needsContinuation = props.onInsertBlock && (!lastBlock || lastBlock.content || props.readOnlyBlockIds?.includes(lastBlock.id));
  const visibleBlocks = needsContinuation ? [...props.blocks, draft] : props.blocks;
  function materializeDraft(markdown: string) {
    const existing = draftIds.current.get(draft.id);
    if (existing) return existing;
    const id = props.onInsertBlock?.(lastBlock?.id ?? null, markdown);
    if (id) {
      draftIds.current.set(draft.id, id);
      editorIdentities.current.set(id, draft.id);
      setDraftNumber((number) => number + 1);
    }
    return id;
  }
  function focusBlock(id: string | void, end = false) {
    if (!id) return;
    pendingFocus.current = { id, end };
    const editor = editors.current.get(id);
    if (editor) { editor.commands.focus(end ? "end" : "start"); pendingFocus.current = null; }
  }
  function registerEditor(id: string, editor: Editor | null) {
    if (!editor) editors.current.delete(id);
    else {
      editors.current.set(id, editor);
      if (pendingFocus.current?.id === id) {
        const end = pendingFocus.current.end;
        queueMicrotask(() => { if (!editor.isDestroyed) focusBlock(id, end); });
      }
    }
  }
  return <div className={`rich-document-editor ${props.className ?? ""}`} role="group" aria-label={props.ariaLabel ?? "Editable document"} onClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}>
    {visibleBlocks.map((block, index) => {
      const isDraft = block.id === draft.id;
      const identity = editorIdentities.current.get(block.id) ?? block.id;
      return <RichBlock key={identity} editorIdentity={identity} {...props} block={block} index={index} isDraft={isDraft}
        focusBlock={focusBlock} registerEditor={registerEditor} draggingBlock={draggingBlock} onDragBlock={setDraggingBlock}
        onUpdateBlock={(id, markdown) => {
          const savedId = draftIds.current.get(id);
          if (savedId) props.onUpdateBlock(savedId, markdown);
          else if (isDraft) { if (markdown) materializeDraft(markdown); }
          else props.onUpdateBlock(id, markdown);
        }}
        onSplitBlock={isDraft ? (id, before, after) => {
          const savedId = draftIds.current.get(id);
          return savedId ? props.onSplitBlock?.(savedId, before, after) : materializeDraft(before || after);
        } : props.onSplitBlock}
        onDeleteBlock={isDraft ? () => focusBlock(lastBlock?.id, true) : props.onDeleteBlock}
        onInvokeAI={props.onInvokeAI ? (invocation) => {
          const id = isDraft ? materializeDraft(invocation.markdown) : block.id;
          if (id) props.onInvokeAI?.({ ...invocation, blockId: id });
        } : undefined}
        onReorderBlock={props.onReorderBlock ? (id, beforeId) => { props.onReorderBlock?.(id, beforeId === draft.id ? null : beforeId); setAnnouncement("Block moved."); } : undefined} />;
    })}
    <span className="rich-document-announcement" role="status" aria-live="polite">{announcement}</span>
  </div>;
}
