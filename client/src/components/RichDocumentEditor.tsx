import { Extension, Node as TiptapNode, type Editor, type EditorEvents, type JSONContent } from "@tiptap/core";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Document from "@tiptap/extension-document";
import { Markdown } from "@tiptap/markdown";
import { TableKit } from "@tiptap/extension-table";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import Highlight from "@tiptap/extension-highlight";
import CodeBlockLowlight from "@tiptap/extension-code-block-lowlight";
import { common, createLowlight } from "lowlight";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { NodeSelection, Plugin, PluginKey, Selection, TextSelection, type EditorState, type Transaction } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView, type NodeView, type ViewMutationRecord } from "@tiptap/pm/view";
import { lazy, Suspense, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type DragEvent as ReactDragEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { getDocumentBlockAuthorship, type DocumentBlock, type Message } from "@margin-chat/workspace-contracts";
import { renderObsidianMarkdownToHtml } from "../lib/markdown";
import { documentAIInput } from "../lib/documentAIInput";
import { documentPositionAtMarkdownOffset, escapeRichDocumentText, getRichDocumentFallbackReason, markdownOffsetAtDocumentPosition } from "../lib/richDocumentMarkdown";
import { DocumentWikiLink } from "../lib/documentWikiLink";
import { createDocumentMathExtensions, type EditEquation } from "../lib/documentMath";
import MathEquationDialog from "./MathEquationDialog";
import { useOutsideDismiss } from "../lib/useOutsideDismiss";
import { useAppUpdateGuard } from "../lib/appUpdateSafety";
import type { DocumentEditFocus, DocumentEditOptions } from "../lib/documentEditHistory";
import { DocumentTable } from "../lib/documentTable";
import { formatDocumentDateTime } from "../lib/documentDateTime";
import { drawingMarkdown, EMPTY_DRAWING, isDrawingMarkdown, readDrawing } from "../lib/documentDrawing";
import { blockChildGroups, freshDocumentBlockId, isDraftBlockId, reconcileDocumentBlocks, sameBlockList, type EditorBlockState } from "../lib/continuousDocument";
import { useMobileKeyboard } from "./MobileKeyboard";
import DocumentMedia, { MediaInsertForm } from "./DocumentMedia";
import { isMediaFile, parseMediaBlock } from "../lib/documentMedia";
import { useVaultMedia } from "../lib/vaultMedia";
import "./RichDocumentEditor.css";
const DocumentDrawing = lazy(() => import("./DocumentDrawing"));
const DrawingDialog = lazy(() => import("./DocumentDrawing").then((module) => ({ default: module.DrawingDialog })));

export type RichDocumentRect = { left: number; top: number; width: number; height: number };
export interface RichDocumentSelection {
  conversationId: string;
  messageId: string;
  sourceBlockId: string;
  quote: string;
  startOffset: number;
  endOffset: number;
  rect: RichDocumentRect;
  /**
   * The lines after sourceBlockId that the passage continues into. Offsets and
   * quote are in those lines joined with a blank line, as one block saves them;
   * join the lines before anything points at the passage.
   */
  joinBlockIds?: string[];
}
export interface RichDocumentInvocation {
  blockId: string;
  markdown: string;
  /** A UTF-16 offset in markdown, never a rendered-text or ProseMirror position. */
  offset: number;
  selection?: { startOffset: number; endOffset: number; quote: string };
  rect: RichDocumentRect;
  /** A Space shortcut continues an existing typing interaction. */
  typing?: boolean;
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
  sourceMessages?: ReadonlyArray<Pick<Message, "id" | "role">>;
  /**
   * Every edit arrives as the document's complete new block list: typing,
   * new lines, joined lines, pastes and deletions across lines. Blocks keep
   * their IDs; a line split off another one inherits its provenance.
   * Without it the document is read-only.
   */
  onChangeBlocks?: (blocks: DocumentBlock[], edit?: DocumentEditOptions) => void;
  onReorderBlock?: (blockId: string, beforeBlockId: string | null) => void;
  moveTargets?: Array<{ id: string; title: string }>;
  onMoveBlock?: (sourceConversationId: string, blockId: string, targetConversationId: string, beforeBlockId: string | null) => void;
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
type TextEncoder = (text: string, node: JSONContent, parent?: JSONContent) => string;
/** Swaps TipTap's text escaping for one that saves "[1]" and "$5" without creating math. */
const DocumentMarkdown = Markdown.extend({
  onBeforeCreate(event) {
    this.parent?.(event);
    const manager = this.editor.markdown as unknown as { encodeTextForMarkdown: TextEncoder; escapeMarkdownSyntax: (text: string) => string } | undefined;
    if (!manager) return;
    const encode = manager.encodeTextForMarkdown.bind(manager);
    let inLink = false;
    manager.escapeMarkdownSyntax = (text) => escapeRichDocumentText(text, inLink);
    manager.encodeTextForMarkdown = (text, node, parent) => {
      inLink = (node.marks ?? []).some((mark) => (typeof mark === "string" ? mark : mark.type) === "link");
      return encode(text, node, parent);
    };
  },
});
export function createRichDocumentExtensions(extra: Extension[] = [], options: { undoRedo?: false; document?: false; onEditEquation?: EditEquation } = {}) {
  const { onEditEquation, ...starterOptions } = options;
  return [
    StarterKit.configure({ link: { openOnClick: false }, underline: false, trailingNode: false, codeBlock: false, ...starterOptions }),
    CodeBlockLowlight.configure({ lowlight }),
    TableKit.configure({ table: false }), DocumentTable.configure({ resizable: false, renderWrapper: true }),
    TaskList, TaskItem.configure({ nested: true }), Highlight, DocumentWikiLink,
    ...createDocumentMathExtensions(onEditEquation),
    DocumentMarkdown.configure({ markedOptions: { gfm: true, breaks: false } }), ...extra,
  ];
}

// One editor holds the whole document. Each top-level node is a block: a line
// of rich text (`documentBlock`) or a preserved item the editor shows with its
// own UI, such as media, a drawing or Obsidian-only syntax (`documentRawBlock`).
const BLOCK = "documentBlock";
const RAW = "documentRawBlock";
/** Content set from saved blocks: never an edit, never undo history. */
const EXTERNAL = "documentExternalSync";
const annotationKey = new PluginKey<DecorationSet>("documentAnnotationRanges");

/** The React chrome around one block lives in these slots of its node view. */
interface BlockSlots {
  key: number;
  raw: boolean;
  id: () => string;
  section: HTMLElement;
  gutter: HTMLElement;
  top: HTMLElement;
  body: HTMLElement | null;
  content: HTMLElement | null;
  after: HTMLElement;
}
class SlotRegistry {
  private slots = new Set<BlockSlots>();
  private listeners = new Set<() => void>();
  private snapshot: BlockSlots[] = [];
  private scheduled = false;
  private counter = 0;
  nextKey() { return ++this.counter; }
  add(slot: BlockSlots) { this.slots.add(slot); this.changed(); }
  remove(slot: BlockSlots) { this.slots.delete(slot); this.changed(); }
  changed() {
    if (this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      this.snapshot = [...this.slots];
      this.listeners.forEach((listener) => listener());
    });
  }
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  getSnapshot = () => this.snapshot;
}

function element(tag: string, className: string, editable?: false) {
  const node = document.createElement(tag);
  node.className = className;
  if (editable === false) node.contentEditable = "false";
  return node;
}

class BlockView implements NodeView {
  dom: HTMLElement;
  contentDOM: HTMLElement | null;
  private slots: BlockSlots;
  constructor(private node: ProseMirrorNode, private registry: SlotRegistry) {
    const raw = node.type.name === RAW;
    const section = element("section", "rich-document-block");
    const gutter = element("div", "rich-document-block-gutter", false);
    const main = element("div", "rich-document-block-main");
    const top = element("div", "rich-document-block-top", false);
    const after = element("div", "rich-document-block-after", false);
    const content = raw ? null : element("div", "rich-document-content message-content");
    const body = raw ? element("div", "rich-document-raw-body", false) : null;
    main.append(top, (content ?? body)!);
    // The after slot (prompt markers, the AI composer) is the block's own grid child, as it was before.
    section.append(gutter, main, after);
    if (raw) section.contentEditable = "false";
    this.dom = section;
    this.contentDOM = content;
    this.slots = { key: registry.nextKey(), raw, id: () => this.node.attrs.id ?? "", section, gutter, top, body, content, after };
    this.sync();
    registry.add(this.slots);
  }
  private sync() {
    const id = this.node.attrs.id ?? "";
    if (this.dom.dataset.documentBlockId !== id) {
      this.dom.dataset.documentBlockId = id;
      this.dom.dataset.chatOutlineId = `message-document:${id}`;
      this.registry.changed();
    }
  }
  update(node: ProseMirrorNode) {
    if (node.type !== this.node.type) return false;
    this.node = node;
    this.sync();
    return true;
  }
  selectNode() { this.dom.classList.add("is-node-selected"); }
  deselectNode() { this.dom.classList.remove("is-node-selected"); }
  /** ProseMirror owns only the text; the gutter, toolbar and AI controls are React's. */
  stopEvent(event: Event) {
    return !this.contentDOM || !(event.target instanceof Node) || !this.contentDOM.contains(event.target);
  }
  ignoreMutation(mutation: ViewMutationRecord) {
    if (!this.contentDOM) return true;
    if (mutation.target === this.contentDOM && mutation.type === "attributes") return true;
    return !this.contentDOM.contains(mutation.target);
  }
  destroy() { this.registry.remove(this.slots); }
}

function createBlockNodes(registry: SlotRegistry) {
  return [
    Document.extend({ content: `(${BLOCK} | ${RAW})+` }),
    TiptapNode.create({
      name: BLOCK, content: "block+", defining: true,
      addAttributes: () => ({ id: { default: null, rendered: false }, splitFrom: { default: null, rendered: false } }),
      parseHTML: () => [{ tag: "div[data-document-block]" }],
      renderHTML: () => ["div", { "data-document-block": "" }, 0],
      addNodeView: () => ({ node }) => new BlockView(node, registry),
    }),
    TiptapNode.create({
      name: RAW, atom: true, selectable: true, draggable: false,
      addAttributes: () => ({ id: { default: null, rendered: false }, splitFrom: { default: null, rendered: false },
        markdown: { default: "", parseHTML: (node) => node.getAttribute("data-markdown") ?? "", renderHTML: (attrs) => ({ "data-markdown": attrs.markdown }) } }),
      parseHTML: () => [{ tag: "div[data-document-raw-block]" }],
      renderHTML: ({ HTMLAttributes }) => ["div", { "data-document-raw-block": "", ...HTMLAttributes }],
      addNodeView: () => ({ node }) => new BlockView(node, registry),
    }),
  ];
}

function serializeBlock(editor: Editor, json: JSONContent) { return editor.markdown!.serialize({ type: "doc", content: json.content ?? [] }); }
function blockMarkdown(editor: Editor, node: ProseMirrorNode) { return node.type.name === RAW ? node.attrs.markdown as string : serializeBlock(editor, node.toJSON()); }
/** Offsets inside a block are offsets in its own saved Markdown, never document positions. */
function offsetInBlock(editor: Editor, block: ProseMirrorNode, start: number, markdown: string, position: number, affinity: -1 | 1 = 1) {
  if (block.type.name === RAW) return position > start ? markdown.length : 0;
  return markdownOffsetAtDocumentPosition(block, (content) => serializeBlock(editor, content), markdown, position - start - 1, affinity);
}
function positionInBlock(editor: Editor, block: ProseMirrorNode, start: number, markdown: string, offset: number, affinity: -1 | 1 = 1) {
  if (block.type.name === RAW) return start;
  return start + 1 + documentPositionAtMarkdownOffset(block, (content) => serializeBlock(editor, content), markdown, offset, affinity);
}
function findBlock(doc: ProseMirrorNode, id: string) {
  let found: { node: ProseMirrorNode; pos: number } | null = null;
  doc.forEach((node, pos) => { if (!found && node.attrs.id === id) found = { node, pos }; });
  return found as { node: ProseMirrorNode; pos: number } | null;
}
function blockAt(doc: ProseMirrorNode, position: number) {
  const $pos = doc.resolve(Math.max(0, Math.min(doc.content.size, position)));
  if ($pos.depth < 1) {
    const node = $pos.nodeAfter ?? $pos.nodeBefore;
    return node ? { node, pos: $pos.nodeAfter ? position : position - node.nodeSize } : null;
  }
  return { node: $pos.node(1), pos: $pos.before(1) };
}
function isEmptyLine(node: ProseMirrorNode) {
  return node.type.name === BLOCK && node.childCount === 1 && node.firstChild!.type.name === "paragraph" && !node.firstChild!.content.size;
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

/** Highlight, note and branch passages, as inline decorations tagged as anchors. */
function anchorDecorations(editor: Editor, doc: ProseMirrorNode, markdownOf: (id: string) => string | undefined, ranges: Record<string, RichDocumentDecoration[]> | undefined): DecorationSet {
  const decorations: Decoration[] = [];
  if (ranges) doc.forEach((block, start) => {
    const id = block.attrs.id as string | null;
    const markdown = id ? markdownOf(id) : undefined;
    if (!id || markdown === undefined || block.type.name === RAW) return;
    const valid = (ranges[id] ?? []).filter((range) => range.to > range.from && range.from >= 0 && range.to <= markdown.length);
    const boundaries = [...new Set(valid.flatMap((range) => [range.from, range.to]))].sort((a, b) => a - b);
    for (let index = 0; index < boundaries.length - 1; index += 1) {
      const active = valid.filter((range) => range.from <= boundaries[index] && range.to >= boundaries[index + 1]);
      if (!active.length) continue;
      const from = positionInBlock(editor, block, start, markdown, boundaries[index], 1);
      const to = positionInBlock(editor, block, start, markdown, boundaries[index + 1], -1);
      if (to <= from) continue;
      const branches = [...new Set(active.flatMap((range) => range.branchIds ?? []))];
      const notes = [...new Set(active.flatMap((range) => range.noteIds ?? []))];
      decorations.push(Decoration.inline(from, to, {
        class: `message-anchor${notes.length ? " message-note-anchor" : ""}`,
        "data-annotation-branches": JSON.stringify(branches), "data-annotation-notes": JSON.stringify(notes),
        tabindex: "0", role: branches.length ? "link" : "button", "aria-label": branches.length && notes.length ? "Preview linked chats and notes" : branches.length ? "Preview linked chat" : "Preview linked note",
      }, { anchor: true }));
    }
  });
  return DecorationSet.create(doc, decorations);
}

/** Outline targets for headings, and blank trailing paragraphs that hide until the block is focused. */
function structureDecorations(doc: ProseMirrorNode) {
  const decorations: Decoration[] = [];
  doc.forEach((block, start) => {
    if (block.type.name !== BLOCK) return;
    let headingIndex = 0;
    block.descendants((node, position) => {
      if (node.type.name === "heading" && node.attrs.level <= 3) decorations.push(Decoration.node(start + 1 + position, start + 1 + position + node.nodeSize, { "data-chat-outline-id": `heading-document:${block.attrs.id}-${headingIndex++}` }));
      return !node.isTextblock;
    });
    let trailing = start + block.nodeSize - 1;
    for (let index = block.childCount - 1; index > 0; index -= 1) {
      const node = block.child(index);
      trailing -= node.nodeSize;
      if (node.type.name !== "paragraph" || node.textContent.trim()) break;
      decorations.push(Decoration.node(trailing, trailing + node.nodeSize, { class: "rich-document-trailing-space" }));
    }
  });
  return DecorationSet.create(doc, decorations);
}

/** Ranges of blocks that may not change, such as an AI response still being written. */
function lockedRanges(doc: ProseMirrorNode, locked: Set<string>) {
  const ranges: Array<{ from: number; to: number }> = [];
  if (locked.size) doc.forEach((node, pos) => { if (locked.has(node.attrs.id)) ranges.push({ from: pos, to: pos + node.nodeSize }); });
  return ranges;
}
function touchesLocked(tr: Transaction, locked: Set<string>) {
  let ranges = lockedRanges(tr.before, locked);
  if (!ranges.length) return false;
  for (const step of tr.steps) {
    let blocked = false;
    step.getMap().forEach((from, to) => {
      if (ranges.some((range) => from < range.to && to > range.from && !(to === range.from || from === range.to))) blocked = true;
      if (from === to && ranges.some((range) => from > range.from && from < range.to)) blocked = true;
    });
    if (blocked) return true;
    const map = step.getMap();
    ranges = ranges.map((range) => ({ from: map.map(range.from, 1), to: map.map(range.to, -1) }));
  }
  return false;
}

interface EditorControl {
  props: () => RichDocumentEditorProps;
  markdownOf: (id: string) => string | undefined;
  locked: () => Set<string>;
  onKeyDown: (view: EditorView, event: KeyboardEvent) => boolean;
  onTextInput: (from: number, to: number, text: string) => boolean;
  onFiles: (files: File[]) => boolean;
}

function createDocumentExtension(control: EditorControl) {
  return Extension.create({
    name: "continuousDocument",
    addProseMirrorPlugins() {
      const editor = this.editor;
      return [
        new Plugin<DecorationSet>({
          key: annotationKey,
          state: {
            init: (_, state) => anchorDecorations(editor, state.doc, control.markdownOf, control.props().decorations),
            apply(tr, set, _old, state) {
              if (tr.getMeta(annotationKey) || tr.getMeta(EXTERNAL)) return anchorDecorations(editor, state.doc, control.markdownOf, control.props().decorations);
              return tr.docChanged ? set.map(tr.mapping, tr.doc) : set;
            },
          },
          props: {
            decorations(state) {
              const anchors = annotationKey.getState(state)!;
              return anchors.add(state.doc, structureDecorations(state.doc).find());
            },
          },
        }),
        new Plugin({
          key: new PluginKey("documentLockedBlocks"),
          filterTransaction: (tr) => tr.getMeta(EXTERNAL) || !tr.docChanged || !touchesLocked(tr, control.locked()),
        }),
        new Plugin({
          key: new PluginKey("documentLines"),
          // Each line becomes its own block. A block keeps several lines only
          // while a saved passage spans them; lists, tables and code are one node.
          appendTransaction(transactions, oldState, newState) {
            if (!transactions.some((tr) => tr.docChanged) || transactions.every((tr) => tr.getMeta(EXTERNAL))) return null;
            const previous = new Map<string, ProseMirrorNode>();
            oldState.doc.forEach((node) => { if (node.attrs.id) previous.set(node.attrs.id, node); });
            const locked = control.locked();
            const anchors = annotationKey.getState(newState)?.find(undefined, undefined, (spec) => spec.anchor) ?? [];
            const tr = newState.tr.setMeta("addToHistory", transactions.every((item) => item.getMeta("addToHistory") !== false));
            const blocks: Array<{ node: ProseMirrorNode; pos: number }> = [];
            newState.doc.forEach((node, pos) => blocks.push({ node, pos }));
            for (let index = blocks.length - 1; index >= 0; index -= 1) {
              const { node, pos } = blocks[index];
              if (node.type.name !== BLOCK || node.childCount < 2 || locked.has(node.attrs.id)) continue;
              // Untouched blocks keep their saved shape, so opening a document never rewrites it.
              if (node.attrs.id && previous.get(node.attrs.id) === node) continue;
              const children: Array<{ from: number; to: number }> = [];
              let offset = pos + 1;
              node.forEach((child) => { children.push({ from: offset, to: offset + child.nodeSize }); offset += child.nodeSize; });
              const groups = blockChildGroups(children, anchors.filter((decoration) => decoration.from < pos + node.nodeSize && decoration.to > pos));
              const origin = node.attrs.id ?? null;
              for (let group = groups.length - 1; group >= 1; group -= 1) {
                tr.split(children[groups[group][0]].from, 1, [{ type: newState.schema.nodes[BLOCK], attrs: { id: freshDocumentBlockId(), splitFrom: origin } }]);
              }
            }
            const seen = new Set<string>();
            tr.doc.forEach((node, pos) => {
              const id = node.attrs.id as string | null;
              if (id && !seen.has(id) && !(isDraftBlockId(id) && !isEmptyLine(node))) { seen.add(id); return; }
              const next = freshDocumentBlockId();
              seen.add(next);
              tr.setNodeAttribute(pos, "id", next);
            });
            return tr.steps.length ? tr : null;
          },
          props: {
            handleKeyDown: (view, event) => control.onKeyDown(view, event),
            handleTextInput: (_view, from, to, text) => control.onTextInput(from, to, text),
            handlePaste: (_view, event) => {
              const files = [...event.clipboardData?.files ?? []].filter(isMediaFile);
              if (!files.length || !control.onFiles(files)) return false;
              event.preventDefault();
              return true;
            },
            handleDrop: (_view, event) => {
              const files = [...(event as DragEvent).dataTransfer?.files ?? []].filter(isMediaFile);
              if (!files.length || !control.onFiles(files)) return false;
              event.preventDefault();
              return true;
            },
          },
        }),
      ];
    },
  });
}

/** Join the line at the caret onto the end of the previous block (Backspace at its start). */
function joinBackward(state: EditorState, locked: Set<string>, dispatch: (tr: Transaction) => void) {
  const { $from, empty } = state.selection;
  if (!empty || $from.depth !== 2 || $from.parentOffset !== 0 || $from.index(1) !== 0) return false;
  const index = $from.index(0);
  if (!index) return false;
  const current = $from.node(1);
  const start = $from.before(1);
  const previous = state.doc.child(index - 1);
  const previousStart = start - previous.nodeSize;
  if (locked.has(current.attrs.id) || locked.has(previous.attrs.id)) return true;
  if (isEmptyLine(current)) {
    const tr = state.tr.delete(start, start + current.nodeSize);
    tr.setSelection(previous.type.name === RAW ? NodeSelection.create(tr.doc, previousStart) : Selection.near(tr.doc.resolve(previousStart + previous.nodeSize - 1), -1));
    dispatch(tr.scrollIntoView());
    return true;
  }
  if (previous.type.name === RAW) { dispatch(state.tr.setSelection(NodeSelection.create(state.doc, previousStart))); return true; }
  const end = Selection.near(state.doc.resolve(previousStart + previous.nodeSize - 1), -1);
  if (!end.$head.parent.isTextblock) return false;
  const tr = state.tr.delete(end.$head.pos, $from.pos);
  tr.setSelection(TextSelection.create(tr.doc, end.$head.pos));
  dispatch(tr.scrollIntoView());
  return true;
}
/** Join the next block onto the end of this line (Delete at its end). */
function joinForward(state: EditorState, locked: Set<string>, dispatch: (tr: Transaction) => void) {
  const { $from, empty } = state.selection;
  if (!empty || $from.depth !== 2 || $from.parentOffset !== $from.parent.content.size || $from.index(1) !== $from.node(1).childCount - 1) return false;
  const index = $from.index(0);
  if (index >= state.doc.childCount - 1) return false;
  const current = $from.node(1);
  const next = state.doc.child(index + 1);
  const nextStart = $from.after(1);
  if (locked.has(current.attrs.id) || locked.has(next.attrs.id)) return true;
  if (next.type.name === RAW) {
    if (isEmptyLine(current)) dispatch(state.tr.delete($from.before(1), nextStart).scrollIntoView());
    return true;
  }
  const start = Selection.near(state.doc.resolve(nextStart + 1), 1);
  if (!start.$head.parent.isTextblock) return true;
  const tr = state.tr.delete($from.pos, start.$head.pos);
  tr.setSelection(TextSelection.create(tr.doc, $from.pos));
  dispatch(tr.scrollIntoView());
  return true;
}

/** A selection inside one block, as offsets in its Markdown. Cross-block selections have none. */
/**
 * The selection as Markdown offsets in one block. A selection across several
 * lines is reported, when asked for, in those lines joined as one block would
 * save them, with the lines to join.
 */
function blockSelection(editor: Editor, markdownOf: (id: string) => string | undefined, acrossLines?: { locked: Set<string> }) {
  const { doc, selection: { from, to, empty } } = editor.state;
  const first = blockAt(doc, from);
  const last = first && blockAt(doc, to);
  if (!first || !last) return null;
  const id = first.node.attrs.id as string;
  const markdown = markdownOf(id);
  if (markdown === undefined) return null;
  const startAt = (block: typeof first, source: string) => offsetInBlock(editor, block.node, block.pos, source, from, 1);
  const endAt = (block: typeof first, source: string) => offsetInBlock(editor, block.node, block.pos, source, to, -1);
  if (last.pos === first.pos) {
    const start = startAt(first, markdown);
    return { id, node: first.node, pos: first.pos, markdown, from: start, to: empty ? start : Math.max(start, endAt(first, markdown)) };
  }
  if (!acrossLines) return null;
  const lines: Array<{ node: ProseMirrorNode; pos: number }> = [];
  doc.forEach((node, pos) => { if (pos >= first.pos && pos <= last.pos) lines.push({ node, pos }); });
  const ids = lines.map((line) => line.node.attrs.id as string);
  const sources = ids.map((line) => markdownOf(line));
  // Media, streaming text and the unsaved typing line cannot join a passage.
  if (lines.some((line) => line.node.type.name !== BLOCK) || ids.some((line) => isDraftBlockId(line) || acrossLines.locked.has(line))
    || sources.some((source) => source === undefined)) return null;
  const texts = sources as string[];
  const before = texts.slice(0, -1).reduce((length, source) => length + source.length + 2, 0);
  return { id, node: first.node, pos: first.pos, markdown: texts.join("\n\n"), from: startAt(first, markdown), to: before + endAt(last, texts.at(-1)!), joinBlockIds: ids.slice(1) };
}

type BlockDialog = { blockId: string };

export default function RichDocumentEditor(props: RichDocumentEditorProps) {
  const latest = useRef(props);
  latest.current = props;
  const mobileKeyboard = useMobileKeyboard();
  const rootRef = useRef<HTMLDivElement>(null);
  const registry = useMemo(() => new SlotRegistry(), []);
  const slots = useSyncExternalStore(registry.subscribe, registry.getSnapshot, registry.getSnapshot);
  const pendingFocus = useRef<{ id: string; end: boolean } | null>(null);
  /** The text selected by Select block, which stands for the block's whole source. */
  const wholeBlock = useRef<{ id: string; from: number; to: number } | null>(null);
  const pendingHistoryFocus = useRef<DocumentEditFocus | null>(null);
  const [historyRevision, setHistoryRevision] = useState(0);
  const [draggingBlock, setDraggingBlock] = useState<string | null>(null);
  const [dropPosition, setDropPosition] = useState<BlockDropPosition | null>(null);
  const pointerCleanup = useRef<(() => void) | null>(null);
  const suppressClick = useRef(false);
  const [focusedBlockId, setFocusedBlockId] = useState<string | null>(null);
  const [editorFocused, setEditorFocused] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const [toolbarBlockId, setToolbarBlockId] = useState<string | null>(null);
  const [sourceBlockId, setSourceBlockId] = useState<string | null>(null);
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkUrl, setLinkUrl] = useState("");
  const [mediaOpen, setMediaOpen] = useState(false);
  const [mediaError, setMediaError] = useState<{ blockId: string; message: string } | null>(null);
  const [equation, setEquation] = useState<{ latex: string; display: boolean; from: number; to: number; original?: string; document: ProseMirrorNode } | null>(null);
  const [equationError, setEquationError] = useState<string | null>(null);
  const [drawing, setDrawing] = useState<BlockDialog & { markdown: string; original?: string } | null>(null);
  const [drawingError, setDrawingError] = useState<{ blockId: string; message: string } | null>(null);
  const [, updateToolbar] = useState(0);
  useAppUpdateGuard("document-dialog", {
    check: () => linkOpen || equation || drawing ? "Finish or close the link, equation, or drawing editor in each tab before restarting." : null,
  });
  const toolbarRef = useRef<HTMLDivElement>(null);
  const gripRef = useRef<HTMLButtonElement | null>(null);
  const linkFormRef = useRef<HTMLFormElement>(null);
  const linkButtonRef = useRef<HTMLButtonElement>(null);
  const sourceRef = useRef<HTMLTextAreaElement>(null);
  const sourceBeforeFocus = useRef<DocumentEditFocus | undefined>(undefined);
  const beforeEditFocus = useRef<DocumentEditFocus | undefined>(undefined);
  const suppressSpace = useRef(false);
  const literalSpaceInput = useRef(false);
  const vaultMedia = useVaultMedia();
  const vaultMediaRef = useRef(vaultMedia);
  vaultMediaRef.current = vaultMedia;
  const draftIdentity = useId();
  const editable = Boolean(props.onChangeBlocks);
  const readOnlyIds = useMemo(() => new Set(props.readOnlyBlockIds ?? []), [props.readOnlyBlockIds]);
  const readOnlyRef = useRef(readOnlyIds);
  readOnlyRef.current = readOnlyIds;

  // A blank line after the last block is always ready for typing. It is saved
  // only once it holds text.
  const draft: DocumentBlock = { id: `draft:${props.conversationId}:${draftIdentity}`, kind: "markdown", content: "", createdAt: "", updatedAt: "" };
  const lastBlock = props.blocks.at(-1);
  const isRawBlock = (block: DocumentBlock) => Boolean(parseMediaBlock(block.content)) || !readOnlyIds.has(block.id) && Boolean(isDrawingMarkdown(block.content) || getRichDocumentFallbackReason(block.content));
  const needsContinuation = editable && (!lastBlock || lastBlock.content || readOnlyIds.has(lastBlock.id));
  const visibleBlocks = needsContinuation ? [...props.blocks, draft] : props.blocks;
  const visibleRef = useRef(visibleBlocks);
  visibleRef.current = visibleBlocks;
  const blockById = useMemo(() => new Map(visibleBlocks.map((block) => [block.id, block])), [visibleBlocks]);
  const emptyBlocks = visibleBlocks.filter((block) => !block.content && !readOnlyIds.has(block.id));
  const placeholderBlockId = props.hidePlaceholder ? undefined : (emptyBlocks.find((block) => block.id === focusedBlockId) ?? emptyBlocks.at(-1))?.id;
  const placeholder = props.onInvokeAI ? "Write here, or press Space for AI…" : "Write here…";

  /** What each block's node holds in the editor: its Markdown and the node made from it. */
  const cache = useRef(new Map<string, { markdown: string; node: ProseMirrorNode }>());
  const externalUpdate = useRef(false);
  const markdownOf = (id: string) => cache.current.get(id)?.markdown ?? visibleRef.current.find((block) => block.id === id)?.content;

  // The editor's plugins are created once; they reach this render's handlers through `control`.
  const control = useRef<EditorControl>(null!);
  control.current = {
    props: () => latest.current,
    markdownOf: (id) => markdownOf(id),
    locked: () => readOnlyRef.current,
    onKeyDown: (view, event) => handleKeyDown(view, event),
    onTextInput: (from, to, text) => { const editor = editorRef.current; return editor ? handleAIInput(editor, from, to, text) : false; },
    onFiles: (files) => insertMediaFiles(files),
  };
  const proxy = useMemo<EditorControl>(() => ({
    props: () => control.current.props(), markdownOf: (id) => control.current.markdownOf(id), locked: () => control.current.locked(),
    onKeyDown: (view, event) => control.current.onKeyDown(view, event), onTextInput: (from, to, text) => control.current.onTextInput(from, to, text),
    onFiles: (files) => control.current.onFiles(files),
  }), []);

  const editorRef = useRef<Editor | null>(null);
  const editor: Editor | null = useEditor({
    extensions: createRichDocumentExtensions([createDocumentExtension(proxy), ...createBlockNodes(registry) as unknown as Extension[]], {
      document: false, ...(props.onHistory ? { undoRedo: false as const } : {}),
      onEditEquation(node, position) {
        if (readOnlyRef.current.has(blockAt(editorRef.current!.state.doc, position)?.node.attrs.id)) return;
        closeToolbar();
        const document = editorRef.current?.state.doc;
        if (!document) return;
        setEquationError(null);
        setEquation({ latex: node.attrs.latex, display: node.type.name === "blockMath", from: position, to: position + node.nodeSize, original: JSON.stringify(node.toJSON()), document });
      },
    }),
    editable,
    immediatelyRender: false,
    shouldRerenderOnTransaction: false,
    editorProps: {
      attributes: { class: "rich-document-surface", role: "textbox", "aria-multiline": "true", "aria-label": props.ariaLabel ?? "Editable document",
        "data-mobile-keyboard": "", inputmode: mobileKeyboard.inputMode, spellcheck: "true" },
      // Software keyboards may never emit a usable keydown. beforeinput keeps
      // focus changes in the user gesture; handleTextInput covers DOM-diff input.
      handleDOMEvents: {
        beforeinput(view, event) {
          const editor = editorRef.current;
          if (!editor || event.isComposing || !event.cancelable || !["insertText", "insertReplacementText"].includes(event.inputType) || !event.data) return false;
          let { from, to } = view.state.selection;
          const range = event.getTargetRanges?.()[0];
          if (range) {
            try {
              from = view.posAtDOM(range.startContainer, range.startOffset);
              to = view.posAtDOM(range.endContainer, range.endOffset);
            } catch { return false; }
          }
          if (!handleAIInput(editor, from, to, event.data)) return false;
          event.preventDefault();
          return true;
        },
        mouseup() { const editor = editorRef.current; if (editor) queueMicrotask(() => { if (!editor.isDestroyed) notifySelection(editor); }); return false; },
      },
    },
    onUpdate({ editor, transaction }) {
      if (externalUpdate.current || transaction.getMeta(EXTERNAL)) return;
      const step = transaction.steps.length === 1 ? transaction.steps[0].toJSON() : null;
      const textInput = step?.stepType === "replace" && (!step.slice?.content?.length || step.slice.content.every((node: JSONContent) => node.type === "text"));
      const typedIn = textInput ? blockAt(editor.state.doc, editor.state.selection.from)?.node.attrs.id : undefined;
      const group = textInput && typedIn && !transaction.getMeta("paste") && transaction.getMeta("uiEvent") !== "drop"
        ? `${typedIn}:${step.slice?.content?.length ? "typing" : "deleting"}` : undefined;
      commit(editor, group);
    },
    onSelectionUpdate({ editor }) {
      notifySelection(editor);
      const id = blockAt(editor.state.doc, editor.state.selection.head)?.node.attrs.id ?? null;
      setFocusedBlockId((current) => current === id ? current : id);
      if (editor.isFocused) updateToolbar((value) => value + 1);
    },
    onFocus({ editor }) {
      setEditorFocused(true);
      setFocusedBlockId(blockAt(editor.state.doc, editor.state.selection.head)?.node.attrs.id ?? null);
    },
    onBlur() { setEditorFocused(false); },
  }, [props.conversationId]);
  editorRef.current = editor;

  /** The editor's blocks become the saved block list. Unchanged blocks keep their objects. */
  function commit(editor: Editor, group?: string) {
    const items: EditorBlockState[] = [];
    editor.state.doc.forEach((node) => {
      const id = node.attrs.id as string;
      const cached = cache.current.get(id);
      const same = cached && (cached.node === node || cached.node.type === node.type && (cached.node.content === node.content || cached.node.content.eq(node.content)) && cached.node.attrs.markdown === node.attrs.markdown);
      const markdown = same ? cached.markdown : blockMarkdown(editor, node);
      cache.current.set(id, { markdown, node });
      items.push({ id, splitFrom: node.attrs.splitFrom, markdown, changed: !same });
    });
    const current = latest.current;
    const next = reconcileDocumentBlocks(current.blocks, items, current.sourceMessages);
    if (sameBlockList(current.blocks, next)) return;
    current.onChangeBlocks?.(next, { group, beforeFocus: beforeEditFocus.current, afterFocus: selectionBookmark(editor) ?? undefined });
  }

  function selectionBookmark(editor: Editor): DocumentEditFocus | null {
    const head = blockAt(editor.state.doc, editor.state.selection.from);
    if (!head) return null;
    const id = head.node.attrs.id as string;
    const markdown = markdownOf(id) ?? "";
    const from = offsetInBlock(editor, head.node, head.pos, markdown, editor.state.selection.from, 1);
    const sameBlock = editor.state.selection.to <= head.pos + head.node.nodeSize;
    return { blockId: id, from, to: editor.state.selection.empty || !sameBlock ? from : Math.max(from, offsetInBlock(editor, head.node, head.pos, markdown, editor.state.selection.to, -1)) };
  }

  useLayoutEffect(() => {
    if (!editor) return;
    const capture = ({ editor, transaction }: EditorEvents["beforeTransaction"]) => {
      if (transaction.docChanged && !externalUpdate.current && !transaction.getMeta(EXTERNAL)) beforeEditFocus.current = selectionBookmark(editor) ?? undefined;
    };
    editor.on("beforeTransaction", capture);
    return () => { editor.off("beforeTransaction", capture); };
  }, [editor]);

  /** Parse a saved block into its editor node, reusing the node it already has. */
  function blockNode(editor: Editor, block: DocumentBlock): ProseMirrorNode {
    const raw = isRawBlock(block);
    const cached = cache.current.get(block.id);
    if (cached && cached.markdown === block.content && (cached.node.type.name === RAW) === raw && cached.node.type.schema === editor.schema) return cached.node;
    const schema = editor.schema;
    let node: ProseMirrorNode;
    if (raw) node = schema.nodes[RAW].create({ id: block.id, markdown: block.content });
    else {
      let content: ProseMirrorNode[] = [];
      try { content = (editor.markdown!.parse(block.content).content ?? []).map((json) => schema.nodeFromJSON(json)).filter((child) => child.isBlock); }
      catch { content = block.content ? [schema.nodes.paragraph.create(null, schema.text(block.content))] : []; }
      node = schema.nodes[BLOCK].create({ id: block.id }, content.length ? content : [schema.nodes.paragraph.create()]);
    }
    cache.current.set(block.id, { markdown: block.content, node });
    return node;
  }

  /** Bring saved blocks (AI output, undo, moves, other tabs) into the editor without disturbing the caret. */
  useLayoutEffect(() => {
    // An editor that isn't mounted yet reports itself destroyed, but takes transactions.
    if (!editor) return;
    const nodes = visibleBlocks.map((block) => blockNode(editor, block));
    const target = editor.schema.topNodeType.create(null, nodes);
    const current = editor.state.doc;
    const start = current.content.findDiffStart(target.content);
    if (start !== null) {
      const end = current.content.findDiffEnd(target.content)!;
      const overlap = start - Math.min(end.a, end.b);
      const oldEnd = overlap > 0 ? end.a + overlap : end.a;
      const newEnd = overlap > 0 ? end.b + overlap : end.b;
      externalUpdate.current = true;
      try {
        editor.view.dispatch(editor.state.tr.replace(start, oldEnd, target.slice(start, newEnd))
          .setMeta(EXTERNAL, true).setMeta("addToHistory", false).setMeta("preventUpdate", true));
      } finally { externalUpdate.current = false; }
    }
    const live = new Set(visibleBlocks.map((block) => block.id));
    for (const id of cache.current.keys()) if (!live.has(id)) cache.current.delete(id);
  });

  const decorationKey = JSON.stringify(props.decorations ?? {});
  useEffect(() => {
    if (editor && !editor.isDestroyed) editor.view.dispatch(editor.state.tr.setMeta(annotationKey, true).setMeta(EXTERNAL, true).setMeta("addToHistory", false));
  }, [editor, decorationKey]);
  useEffect(() => { editor?.setEditable(editable, false); }, [editor, editable]);
  useLayoutEffect(() => {
    if (!editor) return;
    const editorProps = editor.options.editorProps;
    // The keyboard button refocuses synchronously in a touch gesture. Apply
    // inputmode before that focus, including ProseMirror's stored attributes.
    editor.setOptions({ editorProps: { ...editorProps, attributes: { ...(typeof editorProps.attributes === "object" ? editorProps.attributes : {}), "aria-label": props.ariaLabel ?? "Editable document", inputmode: mobileKeyboard.inputMode } } });
  }, [editor, props.ariaLabel, mobileKeyboard.inputMode]);

  // Block state the node views show: focus, emptiness, drag and drop, the placeholder.
  useLayoutEffect(() => {
    for (const slot of slots) {
      const id = slot.id();
      const block = blockById.get(id);
      const section = slot.section;
      const authorship = block ? getDocumentBlockAuthorship(block, props.sourceMessages) : "user";
      section.classList.toggle("is-focused", editorFocused && focusedBlockId === id);
      section.classList.toggle("is-dragging", draggingBlock === id);
      section.classList.toggle("is-drop-before", dropPosition?.indicatorBlockId === id && dropPosition.edge === "before");
      section.classList.toggle("is-drop-after", dropPosition?.indicatorBlockId === id && dropPosition.edge === "after");
      section.classList.toggle("is-streaming", readOnlyIds.has(id));
      section.classList.toggle("is-continuation", isDraftBlockId(id));
      section.classList.toggle("is-empty", !block?.content);
      section.classList.toggle("is-source", sourceBlockId === id);
      section.dataset.authorship = authorship;
      section.dataset.messageId = block?.sourceMessageId ?? `document:${id}`;
      section.dataset.conversationId = props.conversationId;
      section.dataset.messageBubble = "true";
      section.dataset.selectionSource = "document";
      if (slot.content) slot.content.dataset.placeholder = id === placeholderBlockId ? placeholder : "";
    }
  });

  function closeToolbar() { setToolbarBlockId(null); setLinkOpen(false); setMediaOpen(false); }
  useOutsideDismiss(Boolean(toolbarBlockId), closeToolbar, toolbarRef, gripRef);
  useOutsideDismiss(Boolean(toolbarBlockId) && linkOpen, () => setLinkOpen(false), linkFormRef, linkButtonRef);

  function emit(next: DocumentBlock[], edit?: DocumentEditOptions) {
    if (!sameBlockList(latest.current.blocks, next)) latest.current.onChangeBlocks?.(next, edit);
  }
  function fresh(content: string): DocumentBlock {
    const now = new Date().toISOString();
    return { id: freshDocumentBlockId(), kind: "markdown", content, createdAt: now, updatedAt: now, authorship: "user" };
  }
  /** Replace one block's Markdown; a draft line becomes a saved block. */
  function setBlockContent(id: string, markdown: string, edit?: DocumentEditOptions) {
    const blocks = latest.current.blocks;
    if (isDraftBlockId(id)) { if (markdown) emit([...blocks, fresh(markdown)], edit); return; }
    const existing = blocks.find((block) => block.id === id);
    if (!existing || existing.content === markdown) return;
    emit(blocks.map((block) => block === existing ? { ...block, content: markdown, updatedAt: new Date().toISOString(),
      authorship: getDocumentBlockAuthorship(block, latest.current.sourceMessages) === "user" ? "user" : "mixed" } : block), edit);
  }
  /** New blocks after `afterId`; an empty line is replaced by the first of them. */
  function insertAfter(afterId: string, markdowns: string[]) {
    const blocks = [...latest.current.blocks];
    const index = blocks.findIndex((block) => block.id === afterId);
    const added = markdowns.map(fresh);
    if (index >= 0 && !blocks[index].content.trim() && !readOnlyRef.current.has(afterId)) blocks.splice(index, 1, ...added);
    else blocks.splice(index < 0 ? blocks.length : index + 1, 0, ...added);
    emit(blocks);
    return added.at(-1)?.id;
  }

  /** Pasted or dropped files are stored in the vault's Attachments folder, as Obsidian does. */
  function insertMediaFiles(files: File[]) {
    const store = vaultMediaRef.current;
    const editor = editorRef.current;
    const at = editor ? blockAt(editor.state.doc, editor.state.selection.from)?.node.attrs.id as string | undefined : undefined;
    if (!store || !files.length || !at || readOnlyRef.current.has(at)) return false;
    setMediaError(null);
    void (async () => {
      const saved: string[] = [];
      try { for (const file of files) saved.push(await store.save(file)); }
      catch (error) { setMediaError({ blockId: at, message: error instanceof Error ? error.message : "This file could not be saved." }); }
      if (saved.length) insertAfter(at, saved);
    })();
    return true;
  }

  /** The selection in Markdown offsets; Select block stands for the block's whole source, syntax included. */
  function currentSelection(editor: Editor, acrossLines?: { locked: Set<string> }) {
    const selection = blockSelection(editor, markdownOf, acrossLines);
    const whole = wholeBlock.current;
    if (whole && (whole.from !== editor.state.selection.from || whole.to !== editor.state.selection.to)) wholeBlock.current = null;
    else if (whole && selection?.id === whole.id) return { ...selection, from: 0, to: selection.markdown.length };
    return selection;
  }

  function notifySelection(editor: Editor) {
    if (!latest.current.onSelectionChange || !editor.isFocused) return;
    if (editor.state.selection.empty) { latest.current.onSelectionChange(null); return; }
    const selection = currentSelection(editor, { locked: readOnlyRef.current });
    if (!selection || selection.to <= selection.from) { latest.current.onSelectionChange(null); return; }
    const block = blockById.get(selection.id);
    const current = latest.current;
    current.onSelectionChange?.({ conversationId: current.conversationId, messageId: block?.sourceMessageId ?? `document:${selection.id}`, sourceBlockId: selection.id,
      startOffset: selection.from, endOffset: selection.to, quote: selection.markdown.slice(selection.from, selection.to), rect: cursorRect(editor),
      ...(selection.joinBlockIds?.length ? { joinBlockIds: selection.joinBlockIds } : {}) });
  }

  function invoke(editor: Editor, spaces = 0, blockId?: string) {
    const current = latest.current;
    if (!current.onInvokeAI) return false;
    let selection = currentSelection(editor);
    if (blockId && selection?.id !== blockId) {
      const found = findBlock(editor.state.doc, blockId);
      if (!found) return false;
      const markdown = markdownOf(blockId) ?? "";
      selection = { id: blockId, node: found.node, pos: found.pos, markdown, from: markdown.length, to: markdown.length };
    }
    if (!selection || readOnlyRef.current.has(selection.id)) return false;
    let id = selection.id;
    const { markdown, from: offset, to: endOffset } = selection;
    if (isDraftBlockId(id)) {
      // AI writes after a saved block, so a blank continuation line is saved first.
      const created = fresh(markdown);
      emit([...current.blocks, created]);
      id = created.id;
    }
    current.onInvokeAI({ blockId: id, markdown, offset, rect: cursorRect(editor), typing: spaces > 0,
      selection: endOffset > offset ? { startOffset: offset, endOffset, quote: markdown.slice(offset, endOffset) } : undefined,
      restoreFocus(options) {
        suppressSpace.current = true;
        if (editor.isDestroyed) return;
        const found = findBlock(editor.state.doc, id);
        if (!found) return;
        const latestMarkdown = markdownOf(id) ?? "";
        const position = positionInBlock(editor, found.node, found.pos, latestMarkdown, Math.min(offset, latestMarkdown.length));
        editor.commands.focus();
        editor.commands.setTextSelection(position);
        if (options?.restoreSpaces && spaces) editor.commands.insertContent(" ".repeat(spaces));
      },
    });
    return true;
  }

  function handleAIInput(editor: Editor, from: number, to: number, text: string) {
    if (editor.view.composing || !editor.isEditable || !latest.current.onInvokeAI) return false;
    if (text !== " " && text !== " " && !/^\.[  ]$/.test(text)) { suppressSpace.current = false; literalSpaceInput.current = false; }
    if (suppressSpace.current || literalSpaceInput.current) return false;
    const trigger = documentAIInput(editor.state, from, to, text, 2);
    if (!trigger) return false;
    if (trigger.to > trigger.from) editor.commands.deleteRange(trigger);
    return invoke(editor, trigger.spaces);
  }

  function handleKeyDown(view: EditorView, event: KeyboardEvent): boolean {
    const currentEditor = editorRef.current;
    literalSpaceInput.current = event.key === " " && (event.repeat || event.shiftKey || event.altKey || event.ctrlKey || event.metaKey);
    if (!currentEditor || event.isComposing || view.composing) return false;
    if (event.target instanceof Element && event.target.closest(".message-anchor") && (event.key === " " || event.key === "Enter")) {
      // The annotation preview/source handler owns activation of a focused saved highlight.
      event.preventDefault();
      return true;
    }
    if (event.key === "Escape") {
      closeToolbar();
      latest.current.onSelectionChange?.(null);
      return false;
    }
    if (event.repeat && event.key !== "Backspace" && event.key !== "Delete") return false;
    const block = blockAt(view.state.doc, view.state.selection.from);
    if (block && readOnlyRef.current.has(block.node.attrs.id)) return false;
    if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "d") {
      event.preventDefault();
      currentEditor.commands.insertContent({ type: "text", text: formatDocumentDateTime() });
      return true;
    }
    if (event.key !== " " && event.key !== "Unidentified" && event.key !== "Process") suppressSpace.current = false;
    const { $from, empty, from } = view.state.selection;
    const plainModifier = !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey;
    const inCode = $from.parent.type.spec.code || $from.marks().some((mark) => mark.type.name === "code");
    if (event.key === " " && plainModifier && empty && !inCode && !suppressSpace.current && latest.current.onInvokeAI) {
      if (handleAIInput(currentEditor, from, from, " ")) {
        event.preventDefault();
        return true;
      }
    }
    if (event.key === "Enter" && !event.metaKey && !event.ctrlKey && !event.altKey) {
      if (currentEditor.isActive("table") || event.shiftKey && !inCode) {
        // Shift+Enter breaks the line inside its block; Enter starts a new block.
        event.preventDefault();
        return currentEditor.commands.setHardBreak();
      }
    }
    if (event.key === "Backspace" && plainModifier) return joinBackward(view.state, readOnlyRef.current, view.dispatch);
    if (event.key === "Delete" && plainModifier) return joinForward(view.state, readOnlyRef.current, view.dispatch);
    return false;
  }

  function focusBlock(id: string | void, end = false) {
    const editor = editorRef.current;
    if (!id) return;
    const found = editor && !editor.isDestroyed ? findBlock(editor.state.doc, id) : null;
    if (!editor || !found) { pendingFocus.current = { id, end }; return; }
    pendingFocus.current = null;
    const selection = found.node.type.name === RAW ? NodeSelection.create(editor.state.doc, found.pos)
      : Selection.near(editor.state.doc.resolve(end ? found.pos + found.node.nodeSize - 1 : found.pos + 1), end ? -1 : 1);
    editor.view.dispatch(editor.state.tr.setSelection(selection));
    editor.commands.focus(undefined, { scrollIntoView: false });
  }

  function restoreHistoryFocus() {
    const historyFocus = pendingHistoryFocus.current;
    const editor = editorRef.current;
    if (!historyFocus || !editor || editor.isDestroyed) return;
    const block = visibleBlocks.find((item) => item.id === historyFocus.blockId) ?? visibleBlocks.at(-1);
    if (!block) return;
    pendingHistoryFocus.current = null;
    if (sourceBlockId === block.id && sourceRef.current) {
      sourceRef.current.focus();
      sourceRef.current.setSelectionRange(Math.min(historyFocus.from, sourceRef.current.value.length), Math.min(historyFocus.to, sourceRef.current.value.length));
      return;
    }
    const found = findBlock(editor.state.doc, block.id);
    if (!found) return;
    if (found.node.type.name === RAW) {
      rootRef.current?.querySelector<HTMLElement>(`[data-document-block-id="${CSS.escape(block.id)}"] :is(.rich-document-source-action, .rich-document-grip)`)?.focus();
      return;
    }
    const from = positionInBlock(editor, found.node, found.pos, block.content, historyFocus.from, 1);
    const to = historyFocus.from === historyFocus.to ? from : positionInBlock(editor, found.node, found.pos, block.content, historyFocus.to, -1);
    editor.commands.setTextSelection({ from, to });
    editor.commands.focus(undefined, { scrollIntoView: false });
  }
  useLayoutEffect(restoreHistoryFocus, [historyRevision, props.blocks]);
  useLayoutEffect(() => { if (pendingFocus.current) focusBlock(pendingFocus.current.id, pendingFocus.current.end); });

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

  function openToolbar(id: string) {
    const editor = editorRef.current;
    // Formatting acts on the selection, so it moves into the block whose grip was clicked.
    if (editor && !editor.isDestroyed && blockAt(editor.state.doc, editor.state.selection.from)?.node.attrs.id !== id) {
      const found = findBlock(editor.state.doc, id);
      if (found) editor.view.dispatch(editor.state.tr.setSelection(found.node.type.name === RAW ? NodeSelection.create(editor.state.doc, found.pos) : Selection.near(editor.state.doc.resolve(found.pos + 1), 1)));
    }
    setLinkOpen(false); setMediaOpen(false);
    setToolbarBlockId(id);
  }

  function openDrawing(block: DocumentBlock) {
    setDrawingError(null);
    const isDrawing = isDrawingMarkdown(block.content);
    if (isDrawing) {
      try { readDrawing(block.content); } catch (error) { setDrawingError({ blockId: block.id, message: error instanceof Error ? error.message : "Invalid drawing." }); return; }
    }
    closeToolbar();
    setDrawing({ blockId: block.id, markdown: isDrawing ? block.content : drawingMarkdown(EMPTY_DRAWING), original: isDrawing ? block.content : undefined });
  }
  function saveDrawing(markdown: string) {
    if (!drawing) return;
    const block = blockById.get(drawing.blockId);
    if (!block || readOnlyIds.has(block.id)) return;
    if (drawing.original !== undefined && block.content !== drawing.original) {
      setDrawingError({ blockId: block.id, message: "This drawing changed while it was open. Close the editor and reopen the latest drawing before saving." });
      return;
    }
    if (drawing.original !== undefined || !block.content.trim()) setBlockContent(block.id, markdown);
    else insertAfter(block.id, [markdown]);
    setDrawing(null);
  }

  function openEquation() {
    if (!editor) return;
    const { from, to } = editor.state.selection;
    if (readOnlyIds.has(blockAt(editor.state.doc, from)?.node.attrs.id)) return;
    const node = editor.state.doc.nodeAt(from);
    const existing = node && ["inlineMath", "blockMath"].includes(node.type.name) && to === from + node.nodeSize;
    closeToolbar();
    setEquationError(null);
    setEquation({ from, to, latex: existing ? node.attrs.latex : editor.state.doc.textBetween(from, to),
      display: existing ? node.type.name === "blockMath" : false, original: existing ? JSON.stringify(node.toJSON()) : undefined, document: editor.state.doc });
  }
  function closeEquation() { setEquation(null); if (editor && !editor.isDestroyed) editor.commands.focus(); }
  function saveEquation(latex: string, display: boolean) {
    if (!editor || !equation || editor.isDestroyed) return;
    const { from, to, original } = equation;
    // Do not insert at stale offsets when incoming content changed this document.
    if (!editor.state.doc.eq(equation.document) || to > editor.state.doc.content.size || original && JSON.stringify(editor.state.doc.nodeAt(from)?.toJSON()) !== original) {
      setEquationError("This document changed while you were editing. Copy your equation, then reopen the equation editor to choose its position.");
      return;
    }
    const math: JSONContent = { type: display ? "blockMath" : "inlineMath", attrs: { latex: latex.trim() } };
    const value = !display && !editor.state.doc.resolve(from).parent.inlineContent ? { type: "paragraph", content: [math] } : math;
    editor.chain().focus().insertContentAt({ from, to }, value).run();
    setEquation(null);
  }

  function openSource(id: string) {
    setSourceBlockId(id);
    setTimeout(() => sourceRef.current?.focus(), 0);
  }
  function finishSource() {
    const id = sourceBlockId;
    setSourceBlockId(null);
    if (id) queueMicrotask(() => focusBlock(id, true));
  }
  useLayoutEffect(() => {
    if (sourceRef.current) { sourceRef.current.style.height = "auto"; sourceRef.current.style.height = `${Math.max(96, sourceRef.current.scrollHeight)}px`; }
  });

  function dropAt(drag: BlockDrag, _x: number, y: number): BlockDropPosition | null {
    const current = latest.current;
    if (!drag.valid() || (drag.sourceConversationId === current.conversationId ? !current.onReorderBlock : !drag.canTransfer() || !current.onMoveBlock)) return null;
    const shells = [...(rootRef.current?.querySelectorAll<HTMLElement>(".rich-document-block[data-document-block-id]") ?? [])];
    const shell = shells.find((item) => y < item.getBoundingClientRect().bottom) ?? shells.at(-1);
    if (!shell) return { beforeBlockId: null, indicatorBlockId: null, edge: "after" };
    const blockId = shell.dataset.documentBlockId!;
    if (readOnlyRef.current.has(blockId)) return null;
    if (isDraftBlockId(blockId) || !current.blocks.find((block) => block.id === blockId)?.content) {
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
    const root = rootRef.current!;
    blockDropSurfaces.set(root, {
      preview: (drag, x, y) => dropSurface.current.preview(drag, x, y),
      drop: (drag, x, y) => dropSurface.current.drop(drag, x, y),
      clear: () => dropSurface.current.clear(),
    });
    return () => {
      blockDropSurfaces.delete(root);
      pointerCleanup.current?.();
      if (activeBlockDrag?.sourceConversationId === latest.current.conversationId) activeBlockDrag.stop();
    };
  }, []);

  function startDrag(blockId: string): BlockDrag | null {
    const current = latest.current;
    if ((!current.onReorderBlock && !current.onMoveBlock) || readOnlyRef.current.has(blockId) || !current.blocks.some((block) => block.id === blockId)) return null;
    activeBlockDrag?.stop();
    const drag: BlockDrag = { sourceConversationId: current.conversationId, blockId,
      valid: () => latest.current.conversationId === drag.sourceConversationId && latest.current.blocks.some((block) => block.id === blockId) && !readOnlyRef.current.has(blockId),
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
      || readOnlyRef.current.has(blockId) || !current.blocks.some((block) => block.id === blockId)) return;
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
      const target = hit?.closest<HTMLElement>("[data-block-editor-conversation-id]");
      return target ? blockDropSurfaces.get(target) ?? null : null;
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
  function reorder(id: string, beforeId: string | null) {
    props.onReorderBlock?.(id, beforeId && isDraftBlockId(beforeId) ? null : beforeId);
    setAnnouncement("Block moved.");
  }

  /** The gutter, toolbar, source editor and AI controls of one block. */
  function renderBlockChrome(slot: BlockSlots) {
    const id = slot.id();
    const block = blockById.get(id);
    const index = block ? visibleBlocks.indexOf(block) : -1;
    const isDraft = isDraftBlockId(id);
    const readOnly = readOnlyIds.has(id) || !editable;
    const toolbarOpen = toolbarBlockId === id && !readOnly && Boolean(block);
    const sourceMode = sourceBlockId === id && Boolean(block);
    const authorship = block ? getDocumentBlockAuthorship(block, props.sourceMessages) : "user";
    const authorshipLabel = authorship === "ai" ? "AI" : authorship === "mixed" ? "AI · edited by you" : "You";
    const content = block?.content ?? "";
    const media = slot.raw && block ? parseMediaBlock(content) : null;
    const isDrawing = isDrawingMarkdown(content);
    const fallback = slot.raw && !media && !isDrawing ? getRichDocumentFallbackReason(content) : null;
    const canAct = editor && !editor.isDestroyed && !slot.raw && !sourceMode;
    const gutter = <button ref={toolbarOpen ? gripRef : undefined} type="button" className="rich-document-grip" aria-label={`Block ${index + 1} actions and formatting`} title="Drag to move · Click for formatting" aria-expanded={toolbarOpen}
      disabled={readOnly || isDraft || !block} draggable={Boolean(props.onReorderBlock || props.onMoveBlock) && !readOnly && !isDraft}
      onPointerDown={(event) => pointerDragStart(event, id)}
      onDragStart={(event) => nativeDragStart(event, id)}
      onDragEnd={() => { if (!pointerCleanup.current && activeBlockDrag?.sourceConversationId === props.conversationId) activeBlockDrag.stop(); }}
      onMouseDown={(event) => event.preventDefault()}
      onClick={(event) => { event.stopPropagation(); if (suppressClick.current) { suppressClick.current = false; event.preventDefault(); return; } if (toolbarOpen) closeToolbar(); else openToolbar(id); }}><GripIcon /></button>;
    const top = <>
      {toolbarOpen && block && <div ref={toolbarRef} className="rich-document-toolbar" role="group" aria-label={`Format block ${index + 1}`} onClick={(event) => event.stopPropagation()}>
        {canAct && <>
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
        <button type="button" onClick={() => openDrawing(block)}>Drawing</button>
        <button type="button" aria-expanded={mediaOpen} onClick={() => { setMediaError(null); setMediaOpen((value) => !value); }}>Image or video</button>
        {props.onInvokeAI && <button type="button" className="rich-document-ask" onMouseDown={(event) => event.preventDefault()} onClick={() => {
          if (canAct) { invoke(editor, 0, id); return; }
          const field = sourceRef.current;
          props.onInvokeAI?.({ blockId: id, markdown: content, offset: field?.selectionStart ?? content.length, rect: slot.section.getBoundingClientRect(), restoreFocus() { field?.focus(); } });
        }}>Ask AI</button>}
        <button type="button" onClick={() => { if (sourceMode) finishSource(); else openSource(id); }}>{sourceMode ? "Done" : "Edit Markdown"}</button>
        {props.onReorderBlock && <><button type="button" disabled={index <= 0} onClick={() => reorder(id, props.blocks[index - 1].id)} aria-label="Move block up">↑</button><button type="button" disabled={index >= props.blocks.length - 1} onClick={() => reorder(id, props.blocks[index + 2]?.id ?? null)} aria-label="Move block down">↓</button></>}
        {props.onMoveBlock && !isDraft && props.moveTargets?.some((target) => target.id !== props.conversationId) ? <select className="rich-document-move-target" aria-label="Move block to document" value="" onChange={(event) => {
          const targetId = event.target.value;
          if (!targetId || targetId === props.conversationId) return;
          closeToolbar();
          props.onMoveBlock?.(props.conversationId, id, targetId, null);
        }}><option value="" disabled>Move to document…</option>{props.moveTargets.filter((target) => target.id !== props.conversationId).map((target) => <option key={target.id} value={target.id}>{target.title || "Untitled document"}</option>)}</select> : null}
        <button type="button" className="rich-document-toolbar-close" aria-label="Close block actions" onClick={closeToolbar}>×</button>
        {linkOpen && canAct && <form ref={linkFormRef} className="rich-document-link-form" onSubmit={(event) => { event.preventDefault(); if (!linkUrl.trim()) editor.chain().focus().extendMarkRange("link").unsetLink().run(); else editor.chain().focus().extendMarkRange("link").setLink({ href: linkUrl.trim() }).run(); setLinkOpen(false); }}>
          <input aria-label="Link address" placeholder="https://…" value={linkUrl} onChange={(event) => setLinkUrl(event.target.value)} autoFocus />
          <button type="submit">Apply link</button><button type="button" onClick={() => { editor.chain().focus().extendMarkRange("link").unsetLink().run(); setLinkOpen(false); }}>Remove link</button>
        </form>}
        {mediaOpen && <MediaInsertForm onInsert={(markdown) => { closeToolbar(); insertAfter(id, [markdown]); }} onClose={() => setMediaOpen(false)} />}
        {content && !isDraft && <span className="rich-document-authorship" role="note" aria-label={`Authorship: ${authorshipLabel}`} data-label={`Authorship: ${authorshipLabel}`}
          title={authorship === "user" ? "Your writing" : authorship === "mixed" ? "AI-origin text with your edits; attribution applies to this whole block" : "AI-origin text; attribution applies to this whole block"} />}
      </div>}
      {mediaError?.blockId === id && <p className="rich-document-media-error" role="alert">{mediaError.message}</p>}
      {drawingError?.blockId === id && <p role="alert">{drawingError.message}</p>}
      {readOnlyIds.has(id) && <div className="rich-document-streaming-label" role="status">Writing…</div>}
      {sourceMode && block && <div className="rich-document-source"><div className="rich-document-source-label"><span>Markdown source</span><button type="button" onClick={finishSource}>Done</button></div><textarea data-mobile-keyboard inputMode={mobileKeyboard.inputMode} ref={sourceRef} value={content} readOnly={readOnly} aria-label={`Markdown for block ${index + 1}`} spellCheck={false}
        onKeyDown={(event) => {
          sourceBeforeFocus.current = { blockId: id, from: event.currentTarget.selectionStart, to: event.currentTarget.selectionEnd };
          if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); finishSource(); return; }
          if (readOnly || event.nativeEvent.isComposing || event.repeat || !(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey || event.key.toLowerCase() !== "d") return;
          event.preventDefault();
          const field = event.currentTarget;
          const from = field.selectionStart, to = field.selectionEnd;
          const stamp = formatDocumentDateTime();
          setBlockContent(id, field.value.slice(0, from) + stamp + field.value.slice(to), { beforeFocus: { blockId: id, from, to }, afterFocus: { blockId: id, from: from + stamp.length, to: from + stamp.length } });
          requestAnimationFrame(() => field.setSelectionRange(from + stamp.length, from + stamp.length));
        }}
        onBeforeInput={(event) => { sourceBeforeFocus.current = { blockId: id, from: event.currentTarget.selectionStart, to: event.currentTarget.selectionEnd }; }}
        onChange={(event) => setBlockContent(id, event.target.value, { group: `${id}:source`, beforeFocus: sourceBeforeFocus.current,
          afterFocus: { blockId: id, from: event.currentTarget.selectionStart, to: event.currentTarget.selectionEnd } })}
        onSelect={(event) => {
          const field = event.currentTarget;
          if (field.selectionStart === field.selectionEnd) return;
          const rect = field.getBoundingClientRect();
          props.onSelectionChange?.({ conversationId: props.conversationId, messageId: block.sourceMessageId ?? `document:${id}`, sourceBlockId: id, quote: field.value.slice(field.selectionStart, field.selectionEnd),
            startOffset: field.selectionStart, endOffset: field.selectionEnd, rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height } });
        }} /></div>}
    </>;
    const body = slot.raw && block && !sourceMode ? (media ? <DocumentMedia markdown={content} media={media} readOnly={readOnly}
        onChange={(markdown) => setBlockContent(id, markdown)} onEditSource={() => openSource(id)} />
      : isDrawing ? <Suspense fallback={<p role="status">Loading drawing…</p>}><DocumentDrawing markdown={content} readOnly={readOnly} onEdit={() => openDrawing(block)} /></Suspense>
      : <div className="rich-document-preserved"><div className="rich-document-preserved-preview">{props.renderBlockPreview?.(block) ?? (typeof window === "undefined" ? <pre>{content}</pre> : <div className="message-content" dangerouslySetInnerHTML={{ __html: renderObsidianMarkdownToHtml(content) }} />)}</div><button type="button" className="rich-document-source-action" disabled={readOnly} onClick={() => openSource(id)}>Edit {(fallback ?? "Markdown").toLowerCase()} source</button></div>) : null;
    const after = <>
      {!readOnly && !slot.raw && !sourceMode && editor && <div className="rich-document-touch-actions">
        {props.onInvokeAI && <button type="button" onMouseDown={(event) => event.preventDefault()} aria-label="Ask AI" data-label="✦ Ask AI" onClick={() => invoke(editor, 0, id)} />}
        {content && <button type="button" onMouseDown={(event) => event.preventDefault()} aria-label="Select block" data-label="Select block" onClick={() => {
          const found = findBlock(editor.state.doc, id);
          if (!found) return;
          const selection = TextSelection.between(editor.state.doc.resolve(found.pos + 1), editor.state.doc.resolve(found.pos + found.node.nodeSize - 1));
          wholeBlock.current = { id, from: selection.from, to: selection.to };
          editor.view.dispatch(editor.state.tr.setSelection(selection));
          editor.commands.focus();
        }} />}
      </div>}
      {block && !isDraft ? props.renderAfterBlock?.(block) : null}
    </>;
    return <span key={slot.key} hidden>
      {createPortal(gutter, slot.gutter)}
      {createPortal(top, slot.top)}
      {slot.body && createPortal(body, slot.body)}
      {createPortal(after, slot.after)}
    </span>;
  }

  return <div ref={rootRef} data-block-editor-conversation-id={props.conversationId} className={`rich-document-editor ${props.className ?? ""}`} role="group" aria-label={props.ariaLabel ?? "Editable document"} onClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}
    onKeyDownCapture={(event) => {
      if (!props.onHistory || !(event.metaKey || event.ctrlKey) || event.altKey || event.key.toLowerCase() !== "z" || event.nativeEvent.isComposing) return;
      const target = event.target instanceof Element ? event.target : null;
      if (!target || target.closest(".document-ai-composer, .document-prompt-history, .rich-document-link-form, .math-equation-dialog, .document-drawing-dialog")) return;
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
    <EditorContent editor={editor} />
    {slots.map(renderBlockChrome)}
    {dropPosition && !dropPosition.indicatorBlockId ? <div className="rich-document-drop-end" aria-hidden="true" /> : null}
    {drawing && <Suspense fallback={<p role="status">Opening drawing editor…</p>}><DrawingDialog markdown={drawing.markdown} error={drawingError?.blockId === drawing.blockId ? drawingError.message : ""} onSave={saveDrawing} onClose={() => setDrawing(null)} /></Suspense>}
    {equation && <MathEquationDialog latex={equation.latex} display={equation.display} editing={equation.original !== undefined} error={equationError} onSave={saveEquation} onClose={closeEquation} />}
    <span className="rich-document-announcement" role="status" aria-live="polite">{announcement}</span>
  </div>;
}

