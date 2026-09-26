import { Extension, type Editor, type EditorEvents, type JSONContent } from "@tiptap/core";
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
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type DragEvent as ReactDragEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import type { DocumentBlock } from "@margin-chat/workspace-contracts";
import { renderObsidianMarkdownToHtml } from "../lib/markdown";
import { documentPositionAtMarkdownOffset, getRichDocumentFallbackReason, markdownOffsetAtDocumentPosition } from "../lib/richDocumentMarkdown";
import { createDocumentMathExtensions, type EditEquation } from "../lib/documentMath";
import MathEquationDialog from "./MathEquationDialog";
import { useOutsideDismiss } from "../lib/useOutsideDismiss";
import type { DocumentEditFocus, DocumentEditOptions } from "../lib/documentEditHistory";
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
  onUpdateBlock: (blockId: string, markdown: string, edit?: DocumentEditOptions) => void;
  onReorderBlock?: (blockId: string, beforeBlockId: string | null) => void;
  moveTargets?: Array<{ id: string; title: string }>;
  onMoveBlock?: (sourceConversationId: string, blockId: string, targetConversationId: string, beforeBlockId: string | null) => void;
  onSplitBlock?: (blockId: string, before: string, after: string, edit?: DocumentEditOptions) => string | void;
  onInsertBlock?: (afterBlockId: string | null, markdown: string, edit?: DocumentEditOptions) => string | void;
  onDeleteBlock?: (blockId: string, edit?: DocumentEditOptions) => void;
  onHistory?: (action: "undo" | "redo") => DocumentEditFocus | null;
  onInvokeAI?: (invocation: RichDocumentInvocation) => void;
  onSelectionChange?: (selection: RichDocumentSelection | null) => void;
  readOnlyBlockIds?: string[];
  decorations?: Record<string, RichDocumentDecoration[]>;
  renderAfterBlock?: (block: DocumentBlock) => ReactNode;
  renderBlockPreview?: (block: DocumentBlock) => ReactNode;
  hidePlaceholder?: boolean;
  ariaLabel?: string;
  className?: string;
}

const BLOCK_DRAG_TYPE = "application/x-margin-document-block";
type BlockDrag = { sourceConversationId: string; blockId: string; valid: () => boolean; canTransfer: () => boolean; stop: () => void };
type BlockDropPosition = { beforeBlockId: string | null; indicatorBlockId: string | null; edge: "before" | "after" };
type BlockDropSurface = {
  preview: (drag: BlockDrag, x: number, y: number) => boolean;
  drop: (drag: BlockDrag, x: number, y: number) => void;
  clear: () => void;
};
// Only a live grip gesture can move a block. Serialized drag data never grants
// external HTML/text drops access to the document move callback.
let activeBlockDrag: BlockDrag | null = null;
const blockDropSurfaces = new Map<HTMLElement, BlockDropSurface>();
function clearBlockDropIndicators(except?: HTMLElement) {
  for (const [element, surface] of blockDropSurfaces) if (element !== except) surface.clear();
}

const lowlight = createLowlight(common);
export function createRichDocumentExtensions(extra: Extension[] = [], options: { undoRedo?: false; onEditEquation?: EditEquation } = {}) {
  const { onEditEquation, ...starterOptions } = options;
  return [
    StarterKit.configure({ link: { openOnClick: false }, underline: false, trailingNode: false, codeBlock: false, ...starterOptions }),
    CodeBlockLowlight.configure({ lowlight }),
    TableKit.configure({ table: { resizable: false, renderWrapper: true } }),
    TaskList, TaskItem.configure({ nested: true }), Highlight,
    ...createDocumentMathExtensions(onEditEquation),
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
  onNativeDragStart: (event: ReactDragEvent<HTMLButtonElement>, id: string) => void;
  onNativeDragEnd: () => void;
  onPointerDragStart: (event: ReactPointerEvent<HTMLButtonElement>, id: string) => void;
  suppressGripClick: () => boolean;
  draggingBlock: string | null;
  dropEdge?: "before" | "after";
  editorIdentity?: string;
  isDraft?: boolean;
  showPlaceholder: boolean;
  onBlockFocusChange: (id: string, focused: boolean) => void;
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
  const [equation, setEquation] = useState<{ latex: string; display: boolean; from: number; to: number; original?: string; document: Editor["state"]["doc"] } | null>(null);
  const [equationError, setEquationError] = useState<string | null>(null);
  const [, updateToolbar] = useState(0);
  const [focused, setFocused] = useState(false);
  const sourceRef = useRef<HTMLTextAreaElement>(null);
  const shellRef = useRef<HTMLElement>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const gripRef = useRef<HTMLButtonElement>(null);
  const linkFormRef = useRef<HTMLFormElement>(null);
  const linkButtonRef = useRef<HTMLButtonElement>(null);
  const readOnly = props.readOnlyBlockIds?.includes(block.id) ?? false;
  const fallback = useMemo(() => getRichDocumentFallbackReason(block.content), [block.content]);
  const editorSource = useRef(fallback ? "" : block.content);
  const editorRef = useRef<Editor | null>(null);
  const beforeEditFocus = useRef<DocumentEditFocus | undefined>(undefined);
  const sourceBeforeFocus = useRef<DocumentEditFocus | undefined>(undefined);
  const sourceId = block.sourceMessageId ?? `document:${block.id}`;
  const toolbarId = useId();
  const placeholder = props.showPlaceholder ? (props.onInvokeAI ? "Write here, or press Space for AI…" : "Write here…") : "";

  function closeToolbar() { setToolbarOpen(false); setLinkOpen(false); }

  useOutsideDismiss(toolbarOpen, closeToolbar, toolbarRef, gripRef);
  useOutsideDismiss(toolbarOpen && linkOpen, () => setLinkOpen(false), linkFormRef, linkButtonRef);

  function selectionBookmark(editor: Editor): DocumentEditFocus {
    const selection = editor.state.selection;
    const from = rawOffset(editor, content.current, selection.from, 1);
    return { blockId: latest.current.block.id, from, to: selection.empty ? from : Math.max(from, rawOffset(editor, content.current, selection.to, -1)) };
  }

  function commit(editor: Editor, group?: string) {
    const markdown = editor.getMarkdown();
    content.current = markdown;
    editorSource.current = markdown;
    latest.current.onUpdateBlock(latest.current.block.id, markdown, { group, beforeFocus: beforeEditFocus.current, afterFocus: selectionBookmark(editor) });
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
    ], { ...(props.onHistory ? { undoRedo: false as const } : {}), onEditEquation(node, position) {
      if (latest.current.readOnlyBlockIds?.includes(latest.current.block.id)) return;
      closeToolbar();
      const document = editorRef.current?.state.doc;
      if (!document) return;
      setEquationError(null);
      setEquation({ latex: node.attrs.latex, display: node.type.name === "blockMath", from: position, to: position + node.nodeSize, original: JSON.stringify(node.toJSON()), document });
    } }),
    content: fallback ? "" : block.content,
    contentType: "markdown",
    editable: !readOnly,
    immediatelyRender: false,
    shouldRerenderOnTransaction: false,
    editorProps: {
      attributes: { class: "rich-document-content message-content", role: "textbox", "aria-multiline": "true", "aria-label": `Document block ${index + 1}`,
        "data-placeholder": placeholder, spellcheck: "true" },
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
          const id = latest.current.onSplitBlock(latest.current.block.id, before, after, { beforeFocus: selectionBookmark(currentEditor) });
          latest.current.focusBlock(id);
          return true;
        }
        if (event.key === "Backspace" && plainModifier && empty && view.state.doc.childCount === 1 && view.state.doc.firstChild?.type.name === "paragraph" && !view.state.doc.firstChild.content.size && (latest.current.blocks.length > 1 || latest.current.isDraft) && latest.current.onDeleteBlock) {
          event.preventDefault();
          const previous = latest.current.blocks[latest.current.index - 1];
          latest.current.onDeleteBlock(latest.current.block.id, { beforeFocus: selectionBookmark(currentEditor) });
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
          closeToolbar();
          latest.current.onSelectionChange?.(null);
        }
        return false;
      },
      handleDOMEvents: {
        mouseup() { const editor = editorRef.current; if (editor) queueMicrotask(() => { if (!editor.isDestroyed) notifySelection(editor); }); return false; },
      },
    },
    onUpdate({ editor, transaction }) {
      if (externalUpdate.current) return;
      const step = transaction.steps.length === 1 ? transaction.steps[0].toJSON() : null;
      const textInput = step?.stepType === "replace" && (!step.slice?.content?.length || step.slice.content.every((node: JSONContent) => node.type === "text"));
      const group = textInput && !transaction.getMeta("paste") && transaction.getMeta("uiEvent") !== "drop"
        ? `${latest.current.block.id}:${step.slice?.content?.length ? "typing" : "deleting"}` : undefined;
      commit(editor, group);
    },
    onSelectionUpdate({ editor }) { notifySelection(editor); if (editor.isFocused) updateToolbar((value) => value + 1); },
    onFocus() { setFocused(true); latest.current.onBlockFocusChange(latest.current.block.id, true); },
    onBlur() { setFocused(false); latest.current.onBlockFocusChange(latest.current.block.id, false); },
  }, [props.editorIdentity ?? block.id]);
  editorRef.current = editor;

  useLayoutEffect(() => {
    if (!editor) return;
    const captureSelection = ({ editor, transaction }: EditorEvents["beforeTransaction"]) => {
      if (transaction.docChanged && !externalUpdate.current) beforeEditFocus.current = selectionBookmark(editor);
    };
    editor.on("beforeTransaction", captureSelection);
    return () => { editor.off("beforeTransaction", captureSelection); };
  }, [editor]);

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
    try { editor.chain().setMeta("addToHistory", false).setContent(block.content, { contentType: "markdown", emitUpdate: false }).run(); editorSource.current = block.content; }
    finally { externalUpdate.current = false; }
  }, [editor, block.content, fallback, sourceMode]);

  useEffect(() => { editor?.setEditable(!readOnly, false); }, [editor, readOnly]);
  useEffect(() => {
    if (!editor) return;
    const editorProps = editor.options.editorProps;
    editor.setOptions({ editorProps: { ...editorProps, attributes: { ...(typeof editorProps.attributes === "object" ? editorProps.attributes : {}), "aria-label": `Document block ${index + 1}`, "data-placeholder": placeholder } } });
  }, [editor, index, placeholder]);
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
      editor.chain().setMeta("addToHistory", false).setContent(content.current, { contentType: "markdown", emitUpdate: false }).run();
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

  function openEquation() {
    if (!editor || readOnly) return;
    const { from, to } = editor.state.selection;
    const node = editor.state.doc.nodeAt(from);
    const existing = node && ["inlineMath", "blockMath"].includes(node.type.name) && to === from + node.nodeSize;
    closeToolbar();
    setEquationError(null);
    setEquation({ from, to, latex: existing ? node.attrs.latex : editor.state.doc.textBetween(from, to),
      display: existing ? node.type.name === "blockMath" : false, original: existing ? JSON.stringify(node.toJSON()) : undefined, document: editor.state.doc });
  }

  function closeEquation() { setEquation(null); if (editor && !editor.isDestroyed) editor.commands.focus(); }

  function saveEquation(latex: string, display: boolean) {
    if (!editor || !equation || readOnly || editor.isDestroyed) return;
    const { from, to, original } = equation;
    // Do not insert at stale offsets when incoming content changed this block.
    if (!editor.state.doc.eq(equation.document) || to > editor.state.doc.content.size || original && JSON.stringify(editor.state.doc.nodeAt(from)?.toJSON()) !== original) {
      setEquationError("This document changed while you were editing. Copy your equation, then reopen the equation editor to choose its position.");
      return;
    }
    const math: JSONContent = { type: display ? "blockMath" : "inlineMath", attrs: { latex: latex.trim() } };
    const value = !display && !editor.state.doc.resolve(from).parent.inlineContent ? { type: "paragraph", content: [math] } : math;
    editor.chain().focus().insertContentAt({ from, to }, value).run();
    setEquation(null);
  }

  return <section ref={shellRef} className={`rich-document-block${focused ? " is-focused" : ""}${props.draggingBlock === block.id ? " is-dragging" : ""}${props.dropEdge ? ` is-drop-${props.dropEdge}` : ""}${readOnly ? " is-streaming" : ""}${props.isDraft ? " is-continuation" : ""}${!block.content ? " is-empty" : ""}`}
    data-document-block-id={block.id} data-message-id={sourceId} data-conversation-id={props.conversationId} data-message-bubble="true" data-selection-source="document" data-chat-outline-id={`message-document:${block.id}`}>
    <div className="rich-document-block-gutter" contentEditable={false}>
      <button ref={gripRef} type="button" className="rich-document-grip" aria-label={`Block ${index + 1} actions and formatting`} title="Drag to move · Click for formatting" aria-expanded={toolbarOpen} aria-controls={toolbarId}
        disabled={readOnly || props.isDraft} draggable={Boolean(props.onReorderBlock || props.onMoveBlock) && !readOnly && !props.isDraft}
        onPointerDown={(event) => props.onPointerDragStart(event, block.id)}
        onDragStart={(event) => props.onNativeDragStart(event, block.id)}
        onDragEnd={props.onNativeDragEnd}
        onClick={(event) => { event.stopPropagation(); if (props.suppressGripClick()) { event.preventDefault(); return; } if (toolbarOpen) closeToolbar(); else setToolbarOpen(true); }}><GripIcon /></button>
    </div>
    <div className="rich-document-block-main">
      {toolbarOpen && !readOnly && <div ref={toolbarRef} id={toolbarId} className="rich-document-toolbar" role="group" aria-label={`Format block ${index + 1}`} onClick={(event) => event.stopPropagation()}>
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
          <button ref={linkButtonRef} type="button" aria-pressed={editor.isActive("link")} onMouseDown={(event) => event.preventDefault()} onClick={() => { setLinkUrl(editor.getAttributes("link").href ?? ""); setLinkOpen((value) => !value); }}>Link</button>
          <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={openEquation} title="Insert a LaTeX equation">Math</button>
          {editor.isActive("table") && <><button type="button" onClick={() => editor.chain().focus().addRowAfter().run()}>+ Row</button><button type="button" onClick={() => editor.chain().focus().addColumnAfter().run()}>+ Column</button></>}
        </>}
        {props.onInvokeAI && <button type="button" className="rich-document-ask" onMouseDown={(event) => event.preventDefault()} onClick={() => { if (editor && !fallback && !sourceMode) invoke(editor); else { const field = sourceRef.current; props.onInvokeAI?.({ blockId: block.id, markdown: content.current, offset: field?.selectionStart ?? content.current.length, rect: shellRef.current!.getBoundingClientRect(), restoreFocus() { field?.focus(); } }); } }}>Ask AI</button>}
        <button type="button" onClick={() => { if (sourceMode) finishSource(); else { setSourceMode(true); setTimeout(() => sourceRef.current?.focus(), 0); } }}>{sourceMode ? "Done" : "Edit Markdown"}</button>
        {props.onReorderBlock && <><button type="button" disabled={!index} onClick={() => props.onReorderBlock?.(block.id, props.blocks[index - 1].id)} aria-label="Move block up">↑</button><button type="button" disabled={index === props.blocks.length - 1} onClick={() => props.onReorderBlock?.(block.id, props.blocks[index + 2]?.id ?? null)} aria-label="Move block down">↓</button></>}
        {props.onMoveBlock && !props.isDraft && props.moveTargets?.some((target) => target.id !== props.conversationId) ? <select className="rich-document-move-target" aria-label="Move block to document" value="" onChange={(event) => {
          const targetId = event.target.value;
          if (!targetId || targetId === props.conversationId) return;
          closeToolbar();
          props.onMoveBlock?.(props.conversationId, block.id, targetId, null);
        }}><option value="" disabled>Move to document…</option>{props.moveTargets.filter((target) => target.id !== props.conversationId).map((target) => <option key={target.id} value={target.id}>{target.title || "Untitled document"}</option>)}</select> : null}
        <button type="button" className="rich-document-toolbar-close" aria-label="Close block actions" onClick={closeToolbar}>×</button>
        {linkOpen && editor && <form ref={linkFormRef} className="rich-document-link-form" onSubmit={(event) => { event.preventDefault(); if (!linkUrl.trim()) editor.chain().focus().extendMarkRange("link").unsetLink().run(); else editor.chain().focus().extendMarkRange("link").setLink({ href: linkUrl.trim() }).run(); setLinkOpen(false); }}>
          <input aria-label="Link address" placeholder="https://…" value={linkUrl} onChange={(event) => setLinkUrl(event.target.value)} autoFocus />
          <button type="submit">Apply link</button><button type="button" onClick={() => { editor.chain().focus().extendMarkRange("link").unsetLink().run(); setLinkOpen(false); }}>Remove link</button>
        </form>}
      </div>}
      {readOnly && <div className="rich-document-streaming-label" role="status">Writing…</div>}
      {sourceMode ? <div className="rich-document-source"><div className="rich-document-source-label"><span>Markdown source</span><button type="button" onClick={finishSource}>Done</button></div><textarea ref={sourceRef} value={block.content} readOnly={readOnly} aria-label={`Markdown for block ${index + 1}`} spellCheck={false}
        onBeforeInput={(event) => { sourceBeforeFocus.current = { blockId: block.id, from: event.currentTarget.selectionStart, to: event.currentTarget.selectionEnd }; }}
        onChange={(event) => { content.current = event.target.value; props.onUpdateBlock(block.id, event.target.value, {
          group: `${block.id}:source`, beforeFocus: sourceBeforeFocus.current,
          afterFocus: { blockId: block.id, from: event.currentTarget.selectionStart, to: event.currentTarget.selectionEnd },
        }); }} onSelect={sourceSelection}
        onKeyDown={(event) => { sourceBeforeFocus.current = { blockId: block.id, from: event.currentTarget.selectionStart, to: event.currentTarget.selectionEnd }; if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); finishSource(); } }} /></div>
        : fallback ? <div className="rich-document-preserved"><div className="rich-document-preserved-preview">{props.renderBlockPreview?.(block) ?? (typeof window === "undefined" ? <pre>{block.content}</pre> : <div className="message-content" dangerouslySetInnerHTML={{ __html: renderObsidianMarkdownToHtml(block.content) }} />)}</div><button type="button" className="rich-document-source-action" disabled={readOnly} onClick={() => { setSourceMode(true); setTimeout(() => sourceRef.current?.focus(), 0); }}>Edit {fallback.toLowerCase()} source</button></div>
        : <EditorContent editor={editor} />}
    </div>
    {props.renderAfterBlock?.(block)}
    {equation && !readOnly && <MathEquationDialog latex={equation.latex} display={equation.display} editing={equation.original !== undefined} error={equationError} onSave={saveEquation} onClose={closeEquation} />}
  </section>;
}

export default function RichDocumentEditor(props: RichDocumentEditorProps) {
  const latest = useRef(props);
  latest.current = props;
  const rootRef = useRef<HTMLDivElement>(null);
  const editors = useRef(new Map<string, Editor>());
  const pendingFocus = useRef<{ id: string; end: boolean } | null>(null);
  const pendingHistoryFocus = useRef<DocumentEditFocus | null>(null);
  const [historyRevision, setHistoryRevision] = useState(0);
  const [draggingBlock, setDraggingBlock] = useState<string | null>(null);
  const [dropPosition, setDropPosition] = useState<BlockDropPosition | null>(null);
  const pointerCleanup = useRef<(() => void) | null>(null);
  const suppressClick = useRef(false);
  const [focusedBlockId, setFocusedBlockId] = useState<string | null>(null);
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
  const emptyBlocks = visibleBlocks.filter((block) => !block.content && !props.readOnlyBlockIds?.includes(block.id));
  const placeholderBlockId = props.hidePlaceholder ? undefined : (emptyBlocks.find((block) => block.id === focusedBlockId) ?? emptyBlocks.at(-1))?.id;

  function dropAt(drag: BlockDrag, x: number, y: number): BlockDropPosition | null {
    const current = latest.current;
    if (!drag.valid() || (drag.sourceConversationId === current.conversationId ? !current.onReorderBlock : !drag.canTransfer() || !current.onMoveBlock)) return null;
    const shells = [...(rootRef.current?.querySelectorAll<HTMLElement>(":scope > .rich-document-block") ?? [])];
    const shell = shells.find((element) => y < element.getBoundingClientRect().bottom) ?? shells.at(-1);
    if (!shell) return { beforeBlockId: null, indicatorBlockId: null, edge: "after" };
    const blockId = shell.dataset.documentBlockId!;
    if (current.readOnlyBlockIds?.includes(blockId)) return null;
    if (shell.classList.contains("is-continuation") || !current.blocks.find((block) => block.id === blockId)?.content) {
      return { beforeBlockId: null, indicatorBlockId: null, edge: "after" };
    }
    const bounds = shell.getBoundingClientRect();
    const before = y < bounds.top + bounds.height / 2;
    const index = current.blocks.findIndex((block) => block.id === blockId);
    return { beforeBlockId: before ? blockId : current.blocks[index + 1]?.id ?? null, indicatorBlockId: blockId, edge: before ? "before" : "after" };
  }
  const dropSurface = useRef<BlockDropSurface>(null!);
  dropSurface.current = {
    clear: () => setDropPosition(null),
    preview(drag, x, y) {
      clearBlockDropIndicators(rootRef.current ?? undefined);
      const position = dropAt(drag, x, y);
      setDropPosition(position);
      return !!position;
    },
    drop(drag, x, y) {
      const position = dropAt(drag, x, y);
      drag.stop();
      if (!position) return;
      if (drag.sourceConversationId === latest.current.conversationId) {
        if (position.beforeBlockId === drag.blockId) return;
        latest.current.onReorderBlock?.(drag.blockId, position.beforeBlockId);
      } else latest.current.onMoveBlock?.(drag.sourceConversationId, drag.blockId, latest.current.conversationId, position.beforeBlockId);
      setAnnouncement("Block moved.");
    },
  };
  useEffect(() => {
    const element = rootRef.current!;
    blockDropSurfaces.set(element, {
      preview: (drag, x, y) => dropSurface.current.preview(drag, x, y),
      drop: (drag, x, y) => dropSurface.current.drop(drag, x, y),
      clear: () => dropSurface.current.clear(),
    });
    return () => {
      blockDropSurfaces.delete(element);
      pointerCleanup.current?.();
      if (activeBlockDrag?.sourceConversationId === latest.current.conversationId) activeBlockDrag.stop();
    };
  }, []);

  function startDrag(blockId: string): BlockDrag | null {
    const current = latest.current;
    if ((!current.onReorderBlock && !current.onMoveBlock) || current.readOnlyBlockIds?.includes(blockId) || !current.blocks.some((block) => block.id === blockId)) return null;
    activeBlockDrag?.stop();
    const drag: BlockDrag = { sourceConversationId: current.conversationId, blockId,
      valid: () => latest.current.conversationId === drag.sourceConversationId && latest.current.blocks.some((block) => block.id === blockId) && !latest.current.readOnlyBlockIds?.includes(blockId),
      canTransfer: () => !!latest.current.onMoveBlock,
      stop() {
        if (activeBlockDrag === drag) activeBlockDrag = null;
        pointerCleanup.current?.();
        setDraggingBlock(null);
        clearBlockDropIndicators();
      },
    };
    activeBlockDrag = drag;
    setDraggingBlock(blockId);
    return drag;
  }
  function nativeDragStart(event: ReactDragEvent<HTMLButtonElement>, blockId: string) {
    event.stopPropagation();
    if (pointerCleanup.current) { event.preventDefault(); return; }
    const drag = startDrag(blockId);
    if (!drag) { event.preventDefault(); return; }
    event.dataTransfer.setData(BLOCK_DRAG_TYPE, JSON.stringify({ sourceConversationId: drag.sourceConversationId, blockId }));
    event.dataTransfer.effectAllowed = "move";
  }
  function pointerDragStart(event: ReactPointerEvent<HTMLButtonElement>, blockId: string) {
    suppressClick.current = false;
    const current = latest.current;
    if (event.button !== 0 || event.isPrimary === false || pointerCleanup.current || (!current.onReorderBlock && !current.onMoveBlock)
      || current.readOnlyBlockIds?.includes(blockId) || !current.blocks.some((block) => block.id === blockId)) return;
    const grip = event.currentTarget;
    const pointerId = event.pointerId;
    const startX = event.clientX;
    const startY = event.clientY;
    let drag: BlockDrag | null = null;
    function surfaceAt(x: number, y: number) {
      // Hit-test painted content so a scrolled pane behind a pinned pane cannot
      // receive the block merely because its unclipped rectangle overlaps it.
      const hit = document.elementFromPoint(x, y);
      if (hit?.closest(".rich-document-toolbar")) return null;
      const element = hit?.closest<HTMLElement>("[data-block-editor-conversation-id]");
      return element ? blockDropSurfaces.get(element) ?? null : null;
    }
    function move(pointer: PointerEvent) {
      if (pointer.pointerId !== pointerId) return;
      if (!drag) {
        if (Math.hypot(pointer.clientX - startX, pointer.clientY - startY) < 6) return;
        drag = startDrag(blockId);
        if (!drag) { cleanup(); return; }
        suppressClick.current = true;
        try { grip.setPointerCapture?.(pointerId); } catch { /* Window listeners also track the gesture. */ }
      }
      pointer.preventDefault();
      const surface = surfaceAt(pointer.clientX, pointer.clientY);
      if (surface) surface.preview(drag, pointer.clientX, pointer.clientY);
      else clearBlockDropIndicators();
    }
    function finish(pointer?: PointerEvent) {
      if (pointer && pointer.pointerId !== pointerId) return;
      const surface = pointer && drag ? surfaceAt(pointer.clientX, pointer.clientY) : null;
      cleanup();
      if (!drag) return;
      suppressClick.current = true;
      pointer?.preventDefault();
      if (surface && pointer) surface.drop(drag, pointer.clientX, pointer.clientY);
      else drag.stop();
    }
    function cancel(pointer?: PointerEvent) { if (!pointer || pointer.pointerId === pointerId) finish(); }
    function blur() { finish(); }
    function escape(key: globalThis.KeyboardEvent) { if (key.key === "Escape") { key.preventDefault(); finish(); } }
    function cleanup() {
      pointerCleanup.current = null;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("blur", blur);
      window.removeEventListener("keydown", escape, true);
      grip.removeEventListener("lostpointercapture", cancel);
      if (grip.hasPointerCapture?.(pointerId)) grip.releasePointerCapture(pointerId);
    }
    pointerCleanup.current = cleanup;
    window.addEventListener("pointermove", move, { passive: false });
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("blur", blur);
    window.addEventListener("keydown", escape, true);
    grip.addEventListener("lostpointercapture", cancel);
  }
  function isBlockDrag(event: ReactDragEvent) {
    return !!activeBlockDrag || Array.from(event.dataTransfer.types ?? []).includes(BLOCK_DRAG_TYPE);
  }
  function materializeDraft(markdown: string, edit?: DocumentEditOptions) {
    const existing = draftIds.current.get(draft.id);
    if (existing) return existing;
    const id = props.onInsertBlock?.(lastBlock?.id ?? null, markdown, edit);
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
      if (pendingHistoryFocus.current) queueMicrotask(restoreHistoryFocus);
    }
  }
  function restoreHistoryFocus() {
    const historyFocus = pendingHistoryFocus.current;
    if (!historyFocus) return;
    const block = visibleBlocks.find((item) => item.id === historyFocus.blockId) ?? visibleBlocks.at(-1);
    if (!block) return;
    const shell = [...(rootRef.current?.querySelectorAll<HTMLElement>("[data-document-block-id]") ?? [])].find((item) => item.dataset.documentBlockId === block.id);
    const source = shell?.querySelector<HTMLTextAreaElement>(".rich-document-source textarea");
    if (source) {
      source.focus();
      source.setSelectionRange(Math.min(historyFocus.from, source.value.length), Math.min(historyFocus.to, source.value.length));
    } else {
      const editor = editors.current.get(block.id);
      if (getRichDocumentFallbackReason(block.content)) {
        shell?.querySelector<HTMLButtonElement>(".rich-document-source-action, .rich-document-grip")?.focus();
      } else {
        // Restored blocks mount their TipTap editor after the first render.
        // Keep the bookmark until registerEditor can restore the actual caret.
        if (!editor || editor.isDestroyed) return;
        const from = editorPosition(editor, block.content, historyFocus.from, 1);
        editor.commands.setTextSelection({ from, to: historyFocus.from === historyFocus.to ? from : editorPosition(editor, block.content, historyFocus.to, -1) });
        editor.commands.focus(undefined, { scrollIntoView: false });
      }
    }
    pendingHistoryFocus.current = null;
  }
  useLayoutEffect(restoreHistoryFocus, [historyRevision, props.blocks]);

  return <div ref={rootRef} data-block-editor-conversation-id={props.conversationId} className={`rich-document-editor ${props.className ?? ""}`} role="group" aria-label={props.ariaLabel ?? "Editable document"} onClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}
    onKeyDownCapture={(event) => {
      if (!props.onHistory || !(event.metaKey || event.ctrlKey) || event.altKey || event.key.toLowerCase() !== "z" || event.nativeEvent.isComposing) return;
      const target = event.target instanceof Element ? event.target : null;
      if (!target || target.closest(".document-ai-composer, .document-prompt-history, .rich-document-link-form, .math-equation-dialog, .is-streaming")) return;
      if (target.closest("input, textarea") && !target.closest(".rich-document-source")) return;
      event.preventDefault();
      event.stopPropagation();
      pendingFocus.current = null;
      const focus = props.onHistory(event.shiftKey ? "redo" : "undo");
      if (focus) { pendingHistoryFocus.current = focus; setHistoryRevision((revision) => revision + 1); setAnnouncement(event.shiftKey ? "Edit redone." : "Edit undone."); }
    }}
    onDragOverCapture={(event) => {
      if (!isBlockDrag(event)) return;
      // Capture prevents ProseMirror from interpreting an internal block move as pasted content.
      event.preventDefault(); event.stopPropagation();
      if ((event.target as Element).closest(".rich-document-toolbar")) { clearBlockDropIndicators(); event.dataTransfer.dropEffect = "none"; return; }
      const accepted = activeBlockDrag && dropSurface.current.preview(activeBlockDrag, event.clientX, event.clientY);
      event.dataTransfer.dropEffect = accepted ? "move" : "none";
    }}
    onDragLeaveCapture={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropPosition(null); }}
    onDropCapture={(event) => {
      if (!isBlockDrag(event)) return;
      event.preventDefault(); event.stopPropagation();
      if ((event.target as Element).closest(".rich-document-toolbar")) { activeBlockDrag?.stop(); return; }
      if (activeBlockDrag) dropSurface.current.drop(activeBlockDrag, event.clientX, event.clientY);
    }}>
    {visibleBlocks.map((block, index) => {
      const isDraft = block.id === draft.id;
      const identity = editorIdentities.current.get(block.id) ?? block.id;
      return <RichBlock key={identity} editorIdentity={identity} {...props} block={block} index={index} isDraft={isDraft}
        showPlaceholder={block.id === placeholderBlockId} onBlockFocusChange={(id, focused) => setFocusedBlockId((current) => focused ? id : current === id ? null : current)}
        focusBlock={focusBlock} registerEditor={registerEditor} draggingBlock={draggingBlock}
        dropEdge={dropPosition?.indicatorBlockId === block.id ? dropPosition.edge : undefined}
        onNativeDragStart={nativeDragStart} onNativeDragEnd={() => { if (!pointerCleanup.current && activeBlockDrag?.sourceConversationId === props.conversationId) activeBlockDrag.stop(); }}
        onPointerDragStart={pointerDragStart} suppressGripClick={() => { const suppressed = suppressClick.current; suppressClick.current = false; return suppressed; }}
        onUpdateBlock={(id, markdown, edit) => {
          const savedId = draftIds.current.get(id);
          if (savedId) props.onUpdateBlock(savedId, markdown, edit && { ...edit,
            beforeFocus: edit.beforeFocus && { ...edit.beforeFocus, blockId: savedId }, afterFocus: edit.afterFocus && { ...edit.afterFocus, blockId: savedId },
          });
          else if (isDraft) { if (markdown) materializeDraft(markdown, edit); }
          else props.onUpdateBlock(id, markdown, edit);
        }}
        onSplitBlock={isDraft ? (id, before, after, edit) => {
          const savedId = draftIds.current.get(id);
          return savedId ? props.onSplitBlock?.(savedId, before, after, edit) : materializeDraft(before || after, edit);
        } : props.onSplitBlock}
        onDeleteBlock={isDraft ? () => focusBlock(lastBlock?.id, true) : props.onDeleteBlock}
        onInvokeAI={props.onInvokeAI ? (invocation) => {
          const id = isDraft ? materializeDraft(invocation.markdown) : block.id;
          if (id) props.onInvokeAI?.({ ...invocation, blockId: id });
        } : undefined}
        onReorderBlock={props.onReorderBlock ? (id, beforeId) => { props.onReorderBlock?.(id, beforeId === draft.id ? null : beforeId); setAnnouncement("Block moved."); } : undefined} />;
    })}
    {dropPosition && !dropPosition.indicatorBlockId ? <div className="rich-document-drop-end" aria-hidden="true" /> : null}
    <span className="rich-document-announcement" role="status" aria-live="polite">{announcement}</span>
  </div>;
}
