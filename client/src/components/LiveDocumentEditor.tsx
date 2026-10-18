import { Annotation, Compartment, EditorSelection, EditorState, MapMode, StateEffect, StateField, Transaction, type Extension, type Range, type Text } from "@codemirror/state";
import { Decoration, EditorView, WidgetType, drawSelection, keymap, layer, type DecorationSet, type LayerMarker, type ViewUpdate } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentLess, indentMore } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { syntaxTree } from "@codemirror/language";
import { GFM } from "@lezer/markdown";
import { lazy, Suspense, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { getDocumentBlockAuthorship, type DocumentBlock } from "@margin-chat/workspace-contracts";
import type { RichDocumentEditorProps, RichDocumentRect } from "./RichDocumentEditor";
import { renderObsidianMarkdownToHtml } from "../lib/markdown";
import { getMarkdownBackspaceEdit, getMarkdownEnterEdit } from "../lib/markdownEditing";
import { formatDocumentDateTime } from "../lib/documentDateTime";
import { drawingMarkdown, EMPTY_DRAWING, isDrawingMarkdown, readDrawing } from "../lib/documentDrawing";
import { freshDocumentBlockId, isDraftBlockId, reconcileDocumentBlocks, sameBlockList } from "../lib/continuousDocument";
import { isMediaFile, parseMediaBlock } from "../lib/documentMedia";
import { useVaultMedia } from "../lib/vaultMedia";
import { useAppUpdateGuard } from "../lib/appUpdateSafety";
import type { DocumentEditFocus, DocumentEditOptions } from "../lib/documentEditHistory";
import { useMobileKeyboard } from "./MobileKeyboard";
import DocumentMedia, { MediaInsertForm } from "./DocumentMedia";
import MathEquationDialog from "./MathEquationDialog";
import { BLOCK_SEPARATOR, blockIndexAt, blockSelection, isTableBlock, layoutBlocks, liveBlockInfo, reflowBlocks, renderedTableSelection, snapOutOfGaps, visibleEnd, type LiveBlock, type TextSource } from "../lib/liveDocument";
import { livePreviewInline, type LivePreviewMode } from "../lib/livePreviewMarkdown";
import { readDocumentViewMode, saveDocumentViewMode, subscribeDocumentEditorPreference } from "../lib/documentEditorPreference";
import "./LiveDocumentEditor.css";
const DocumentDrawing = lazy(() => import("./DocumentDrawing"));
const DrawingDialog = lazy(() => import("./DocumentDrawing").then((module) => ({ default: module.DrawingDialog })));

/**
 * The document editor as Obsidian's Live Preview: one CodeMirror editor over
 * the document's Markdown. A line is rendered until the cursor reaches it,
 * then shows its Markdown. Source mode shows the file as saved; Reading mode
 * renders everything. Blocks keep their IDs, so notes, branches and AI
 * provenance stay attached as the text changes.
 */

const externalSync = Annotation.define<boolean>();
/** How long after the last keystroke the Ask AI button comes back under the caret. */
const ASK_BUTTON_TYPING_PAUSE_MS = 900;
const askButtonMeasure = {};

interface AnchorRange { from: number; to: number; branchIds: string[]; noteIds: string[] }
interface BlockMeta { authorship: string; messageId: string; streaming: boolean }
interface LiveState {
  layout: LiveBlock[];
  anchors: AnchorRange[];
  locked: ReadonlySet<string>;
  mode: LivePreviewMode;
  focused: boolean;
  after: ReadonlySet<string>;
  meta: ReadonlyMap<string, BlockMeta>;
  placeholder: { id: string; text: string } | null;
  conversationId: string;
}

const setLayout = StateEffect.define<{ layout: LiveBlock[]; anchors: AnchorRange[] }>();
const setAnchors = StateEffect.define<AnchorRange[]>();
const setView = StateEffect.define<Partial<Omit<LiveState, "layout" | "anchors">>>();

function textOf(doc: Text): TextSource {
  return { length: doc.length, slice: (from, to = doc.length) => doc.sliceString(from, to) };
}

function mapAnchors(anchors: AnchorRange[], tr: Transaction) {
  return anchors.map((anchor) => ({ ...anchor, from: tr.changes.mapPos(anchor.from, 1), to: tr.changes.mapPos(anchor.to, -1) })).filter((anchor) => anchor.to > anchor.from);
}

const liveField = StateField.define<LiveState>({
  create: () => ({ layout: [], anchors: [], locked: new Set(), mode: "live", focused: false, after: new Set(), meta: new Map(), placeholder: null, conversationId: "" }),
  update(value, tr) {
    let next = value;
    let laidOut = false;
    for (const effect of tr.effects) {
      if (effect.is(setLayout)) { next = { ...next, layout: effect.value.layout, anchors: effect.value.anchors }; laidOut = true; }
      else if (effect.is(setAnchors)) next = { ...next, anchors: effect.value };
      else if (effect.is(setView)) next = { ...next, ...effect.value };
    }
    if (tr.docChanged && !laidOut) {
      const anchors = mapAnchors(next.anchors, tr);
      const changes: Array<{ fromA: number; toA: number }> = [];
      tr.changes.iterChangedRanges((fromA, toA) => changes.push({ fromA, toA }));
      const layout = reflowBlocks({
        oldText: textOf(tr.startState.doc), newText: textOf(tr.newDoc), layout: value.layout, changes, keepTogether: anchors,
        mapping: { mapPos: (position, assoc = -1) => tr.changes.mapPos(position, assoc), mapStart: (position) => tr.changes.mapPos(position, 1, MapMode.TrackDel) },
      });
      next = { ...next, layout, anchors };
    }
    return next;
  },
});

/** Persistent DOM homes for the React parts of the editor: media, drawings, previews, and what follows a block. */
class WidgetHost {
  private containers = new Map<string, HTMLElement>();
  private listeners = new Set<() => void>();
  private resize: ResizeObserver | null = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => this.view?.requestMeasure());
  private snapshot: string[] = [];
  private scheduled = false;
  view: EditorView | null = null;
  container(key: string, className: string) {
    let element = this.containers.get(key);
    if (!element) {
      element = document.createElement("div");
      element.className = className;
      this.containers.set(key, element);
      this.resize?.observe(element);
      this.changed();
    }
    return element;
  }
  existing(key: string) { return this.containers.get(key); }
  prune(live: Set<string>) {
    for (const [key, element] of this.containers) if (!live.has(key)) { this.resize?.unobserve(element); this.containers.delete(key); this.changed(); }
  }
  private changed() {
    if (this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => { this.scheduled = false; this.snapshot = [...this.containers.keys()]; this.listeners.forEach((listener) => listener()); });
  }
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  getSnapshot = () => this.snapshot;
  destroy() { this.resize?.disconnect(); }
}

/** A block shown by React (media, a drawing, a rendered preview) while the cursor is elsewhere. */
class BlockWidget extends WidgetType {
  constructor(readonly host: WidgetHost, readonly key: string, readonly content: string, readonly attributes: Record<string, string>) { super(); }
  eq(other: BlockWidget) { return other.key === this.key && other.content === this.content && JSON.stringify(other.attributes) === JSON.stringify(this.attributes); }
  toDOM() {
    const wrapper = document.createElement("div");
    this.updateDOM(wrapper);
    return wrapper;
  }
  updateDOM(wrapper: HTMLElement) {
    wrapper.className = "live-document-widget";
    for (const name of [...wrapper.getAttributeNames()]) if (name.startsWith("data-")) wrapper.removeAttribute(name);
    for (const [name, value] of Object.entries(this.attributes)) wrapper.setAttribute(name, value);
    const container = this.host.container(this.key, "live-document-widget-body");
    if (wrapper.firstChild !== container) wrapper.replaceChildren(container);
    return true;
  }
  ignoreEvent() { return true; }
}

/** What the document shows after a block: prompt markers, the AI composer, touch actions. */
class AfterWidget extends WidgetType {
  constructor(readonly host: WidgetHost, readonly id: string) { super(); }
  eq(other: AfterWidget) { return other.id === this.id; }
  toDOM() {
    const wrapper = document.createElement("div");
    this.updateDOM(wrapper);
    return wrapper;
  }
  updateDOM(wrapper: HTMLElement) {
    wrapper.className = "live-document-after";
    wrapper.dataset.afterBlockId = this.id;
    const container = this.host.container(`after:${this.id}`, "rich-document-block-after");
    if (wrapper.firstChild !== container) wrapper.replaceChildren(container);
    return true;
  }
  ignoreEvent() { return true; }
}

const hide = Decoration.replace({});
const atomicMark = Decoration.mark({});

function blockAttributes(state: LiveState, block: LiveBlock): Record<string, string> {
  const meta = state.meta.get(block.id);
  return {
    "data-document-block-id": block.id,
    "data-chat-outline-id": `message-document:${block.id}`,
    "data-message-id": meta?.messageId ?? `document:${block.id}`,
    "data-authorship": meta?.authorship ?? "user",
    "data-conversation-id": state.conversationId,
    "data-message-bubble": "true",
    "data-selection-source": "document",
  };
}

/** Highlight, note and branch passages, split where they overlap so each piece names all of them. */
function anchorDecorations(anchors: AnchorRange[], ranges: Range<Decoration>[]) {
  const boundaries = [...new Set(anchors.flatMap((anchor) => [anchor.from, anchor.to]))].sort((a, b) => a - b);
  for (let index = 0; index < boundaries.length - 1; index += 1) {
    const from = boundaries[index], to = boundaries[index + 1];
    const active = anchors.filter((anchor) => anchor.from <= from && anchor.to >= to);
    if (!active.length) continue;
    const branches = [...new Set(active.flatMap((anchor) => anchor.branchIds))];
    const notes = [...new Set(active.flatMap((anchor) => anchor.noteIds))];
    ranges.push(Decoration.mark({
      class: `message-anchor${notes.length ? " message-note-anchor" : ""}`,
      attributes: {
        "data-annotation-branches": JSON.stringify(branches), "data-annotation-notes": JSON.stringify(notes),
        tabindex: "0", role: branches.length ? "link" : "button",
        "aria-label": branches.length && notes.length ? "Preview linked chats and notes" : branches.length ? "Preview linked chat" : "Preview linked note",
      },
    }).range(from, to));
  }
}

function buildBlockDecorations(state: EditorState, host: WidgetHost) {
  const live = state.field(liveField);
  const { doc } = state;
  const text = textOf(doc);
  const ranges: Range<Decoration>[] = [];
  const atomic: Range<Decoration>[] = [];
  const rendered = live.mode !== "source";
  const editing = (block: LiveBlock) => live.mode === "live" && live.focused && state.selection.ranges.some((range) => range.from <= block.to && range.to >= block.from);
  live.layout.forEach((block, index) => {
    const content = doc.sliceString(block.from, block.to);
    const info = liveBlockInfo(content);
    const next = live.layout[index + 1];
    const gapEnd = next ? next.from - 1 : doc.length;
    const end = visibleEnd(text, block);
    const attributes = blockAttributes(live, block);
    const meta = live.meta.get(block.id);
    if (rendered && info.kind !== "text" && !editing(block)) {
      const widget = Decoration.replace({ block: true, widget: new BlockWidget(host, `${info.kind}:${block.id}`, content, attributes) }).range(block.from, Math.max(end, gapEnd));
      ranges.push(widget);
      atomic.push(widget);
    } else {
      const classes = ["live-document-block"];
      if (meta?.streaming) classes.push("is-streaming");
      if (live.placeholder?.id === block.id) classes.push("cm-lp-placeholder");
      ranges.push(Decoration.line({ class: classes.join(" "), attributes: { ...attributes, ...(live.placeholder?.id === block.id ? { "data-placeholder": live.placeholder.text } : {}) } }).range(block.from));
      if (meta?.streaming) for (let line = doc.lineAt(block.from); line.to < end && line.number < doc.lines;) {
        line = doc.line(line.number + 1);
        ranges.push(Decoration.line({ class: "is-streaming" }).range(line.from));
      }
      if (rendered) {
        // Blank lines between blocks, and inside a block a note joined, read as one line break.
        for (const run of info.collapsed) {
          ranges.push(hide.range(block.from + run.from, block.from + run.to));
          atomic.push(atomicMark.range(block.from + run.from, block.from + run.to + 1));
        }
        if (gapEnd > end) ranges.push(hide.range(end, gapEnd));
        const zoneEnd = next ? next.from : doc.length;
        if (zoneEnd > end) atomic.push(atomicMark.range(end, zoneEnd));
      }
    }
    if (live.after.has(block.id)) ranges.push(Decoration.widget({ block: true, side: 1, widget: new AfterWidget(host, block.id) }).range(gapEnd));
  });
  anchorDecorations(live.anchors, ranges);
  return { decorations: Decoration.set(ranges, true), atomic: Decoration.set(atomic, true) };
}

function blockDecorationField(host: WidgetHost) {
  return StateField.define<{ decorations: DecorationSet; atomic: DecorationSet }>({
    create: (state) => buildBlockDecorations(state, host),
    update(value, tr) {
      if (!tr.docChanged && !tr.selection && !tr.effects.length) return value;
      return buildBlockDecorations(tr.state, host);
    },
    provide: (field) => [
      EditorView.decorations.from(field, (value) => value.decorations),
      EditorView.atomicRanges.of((view) => view.state.field(field).atomic),
    ],
  });
}

/** Zero-size stand-ins at the right height for blocks, headings and passages CodeMirror hasn't drawn, so the app can find and scroll to them. */
class BeaconMarker implements LayerMarker {
  constructor(readonly attributes: Record<string, string>, readonly top: number) {}
  eq(other: BeaconMarker) { return other.top === this.top && JSON.stringify(other.attributes) === JSON.stringify(this.attributes); }
  draw() {
    const element = document.createElement("div");
    element.className = "live-document-beacon";
    element.tabIndex = -1;
    element.style.top = `${this.top}px`;
    for (const [name, value] of Object.entries(this.attributes)) element.setAttribute(name, value);
    return element;
  }
}
const HEADING_LINE = /^(#{1,3})[ \t]+\S/;
const beacons = layer({
  above: false,
  class: "live-document-beacons",
  update: (update) => update.docChanged || update.viewportChanged || update.geometryChanged || update.transactions.some((tr) => tr.effects.length > 0),
  markers(view) {
    const live = view.state.field(liveField);
    const { doc } = view.state;
    const rect = view.scrollDOM.getBoundingClientRect();
    const baseTop = rect.top - view.scrollDOM.scrollTop;
    const topOf = (position: number) => Math.round(view.documentTop + view.lineBlockAt(position).top - baseTop);
    const { from, to } = view.viewport;
    const markers: BeaconMarker[] = [];
    for (const block of live.layout) {
      if (block.from < from || block.from > to) markers.push(new BeaconMarker(blockAttributes(live, block), topOf(block.from)));
      // Outline targets for headings (a line holds only one target, its block's).
      let heading = 0;
      for (let line = doc.lineAt(block.from); ; line = doc.line(line.number + 1)) {
        if (HEADING_LINE.test(line.text)) markers.push(new BeaconMarker({ "data-chat-outline-id": `heading-document:${block.id}-${heading++}` }, topOf(line.from)));
        if (line.to >= block.to || line.number >= doc.lines) break;
      }
    }
    for (const anchor of live.anchors) {
      if (anchor.to >= from && anchor.from <= to) continue;
      markers.push(new BeaconMarker({ "data-annotation-branches": JSON.stringify(anchor.branchIds), "data-annotation-notes": JSON.stringify(anchor.noteIds) }, topOf(anchor.from)));
    }
    return markers;
  },
});

function selectionRect(view: EditorView): RichDocumentRect {
  try {
    const range = window.getSelection()?.rangeCount ? window.getSelection()!.getRangeAt(0).getBoundingClientRect() : null;
    if (range?.width || range?.height) return { left: range.left, top: range.top, width: range.width, height: range.height };
    const point = view.coordsAtPos(view.state.selection.main.head);
    if (point) return { left: point.left, top: point.top, width: point.right - point.left, height: point.bottom - point.top };
  } catch { /* Fall back to the editor's box. */ }
  const rect = view.dom.getBoundingClientRect();
  return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
}

const CODE_NODES = new Set(["InlineCode", "FencedCode", "CodeBlock", "CodeText"]);
function inCode(state: EditorState, position: number) {
  for (let node: ReturnType<ReturnType<typeof syntaxTree>["resolveInner"]> | null = syntaxTree(state).resolveInner(position, -1); node; node = node.parent) {
    if (CODE_NODES.has(node.name)) return true;
  }
  return false;
}

function toggleWrap(view: EditorView, marker: string) {
  const { state } = view;
  view.dispatch(state.changeByRange((range) => {
    const before = state.sliceDoc(range.from - marker.length, range.from);
    const after = state.sliceDoc(range.to, range.to + marker.length);
    if (before === marker && after === marker) {
      return { changes: [{ from: range.from - marker.length, to: range.from }, { from: range.to, to: range.to + marker.length }], range: EditorSelection.range(range.from - marker.length, range.to - marker.length) };
    }
    return { changes: [{ from: range.from, insert: marker }, { from: range.to, insert: marker }], range: EditorSelection.range(range.from + marker.length, range.to + marker.length) };
  }), { userEvent: "input.format", scrollIntoView: true });
  return true;
}

export default function LiveDocumentEditor(props: RichDocumentEditorProps) {
  const latest = useRef(props);
  latest.current = props;
  const mobileKeyboard = useMobileKeyboard();
  const rootRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const widgets = useMemo(() => new WidgetHost(), []);
  useEffect(() => () => widgets.destroy(), [widgets]);
  const containerKeys = useSyncExternalStore(widgets.subscribe, widgets.getSnapshot, widgets.getSnapshot);
  const mode = useSyncExternalStore(subscribeDocumentEditorPreference, readDocumentViewMode, () => "live" as const);
  const [focusedBlockId, setFocusedBlockId] = useState<string | null>(null);
  const [editorFocused, setEditorFocused] = useState(false);
  const [insertMenu, setInsertMenu] = useState<{ top: number; blockId: string; open: boolean } | null>(null);
  const [mediaFormFor, setMediaFormFor] = useState<string | null>(null);
  const [mediaError, setMediaError] = useState<string | null>(null);
  const [drawing, setDrawing] = useState<{ blockId: string; markdown: string; original?: string } | null>(null);
  const [drawingError, setDrawingError] = useState<string | null>(null);
  const [equation, setEquation] = useState<{ blockId: string; at: number; docLength: number } | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const pendingFocus = useRef<{ id: string; offset: number; to?: number } | null>(null);
  const suppressSpace = useRef(false);
  const literalSpace = useRef(false);
  const previewSelection = useRef(false);
  // The Ask AI button under the caret; it steps aside while you type.
  const [askButton, setAskButton] = useState<{ top: number; left: number } | null>(null);
  const typing = useRef(false);
  const typingTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const mobileRef = useRef(false);
  const vaultMedia = useVaultMedia();
  const vaultMediaRef = useRef(vaultMedia);
  vaultMediaRef.current = vaultMedia;
  const draftIdentity = useId();
  const editable = Boolean(props.onChangeBlocks);
  useAppUpdateGuard("document-dialog", {
    check: () => equation || drawing ? "Finish or close the equation or drawing editor in each tab before restarting." : null,
  });

  const readOnlyIds = useMemo(() => new Set(props.readOnlyBlockIds ?? []), [props.readOnlyBlockIds]);
  // A blank line after the last block is always ready for typing. It is saved only once it holds text.
  const draft: DocumentBlock = useMemo(() => ({ id: `draft:${props.conversationId}:${draftIdentity}`, kind: "markdown", content: "", createdAt: "", updatedAt: "" }), [props.conversationId, draftIdentity]);
  const lastBlock = props.blocks.at(-1);
  const needsContinuation = editable && (!lastBlock || Boolean(lastBlock.content) || readOnlyIds.has(lastBlock.id));
  const visibleBlocks = useMemo(() => needsContinuation ? [...props.blocks, draft] : props.blocks, [needsContinuation, props.blocks, draft]);
  const blockById = useMemo(() => new Map(visibleBlocks.map((block) => [block.id, block])), [visibleBlocks]);
  const placeholderText = props.onInvokeAI ? "Write here, or press Space for AI…" : "Write here…";

  function emit(next: DocumentBlock[], edit?: DocumentEditOptions) {
    if (!sameBlockList(latest.current.blocks, next)) latest.current.onChangeBlocks?.(next, edit);
  }
  function fresh(content: string): DocumentBlock {
    const now = new Date().toISOString();
    return { id: freshDocumentBlockId(), kind: "markdown", content, createdAt: now, updatedAt: now, authorship: "user" };
  }
  function setBlockContent(id: string, markdown: string) {
    const blocks = latest.current.blocks;
    if (isDraftBlockId(id)) { if (markdown) emit([...blocks, fresh(markdown)]); return; }
    const existing = blocks.find((block) => block.id === id);
    if (!existing || existing.content === markdown) return;
    emit(blocks.map((block) => block === existing ? { ...block, content: markdown, updatedAt: new Date().toISOString(),
      authorship: getDocumentBlockAuthorship(block, latest.current.sourceMessages) === "user" ? "user" : "mixed" } : block));
  }
  /** New blocks after `afterId`; an empty line is replaced by the first of them. */
  function insertAfter(afterId: string, markdowns: string[]) {
    const blocks = [...latest.current.blocks];
    const index = blocks.findIndex((block) => block.id === afterId);
    const added = markdowns.map(fresh);
    if (index >= 0 && !blocks[index].content.trim() && !readOnlyIds.has(afterId)) blocks.splice(index, 1, ...added);
    else blocks.splice(index < 0 ? blocks.length : index + 1, 0, ...added);
    emit(blocks);
    const last = added.at(-1);
    if (last) pendingFocus.current = { id: last.id, offset: last.content.length };
    return last?.id;
  }

  function stateOf(view: EditorView) { return view.state.field(liveField); }
  function blockAtHead(view: EditorView) {
    const live = stateOf(view);
    if (!live.layout.length) return null;
    const index = blockIndexAt(live.layout, view.state.selection.main.head);
    return { index, block: live.layout[index], live };
  }

  /** The selection as one block's Markdown offsets (or several blocks' joined ones). */
  function bookmark(state: EditorState): DocumentEditFocus | undefined {
    const live = state.field(liveField);
    const { from, to } = state.selection.main;
    const selection = blockSelection(textOf(state.doc), live.layout, from, to);
    if (!selection) return undefined;
    const joined = selection.joinBlockIds.length > 0;
    return { blockId: selection.id, from: selection.from, to: joined ? selection.from : selection.to };
  }

  /** The editor's blocks become the saved block list. Unchanged blocks keep their objects. */
  function commit(update: ViewUpdate) {
    const current = latest.current;
    if (!current.onChangeBlocks) return;
    const live = update.state.field(liveField);
    const byId = new Map(current.blocks.map((block) => [block.id, block]));
    const items = live.layout.map((block) => {
      const markdown = update.state.doc.sliceString(block.from, block.to);
      return { id: block.id, splitFrom: block.splitFrom, markdown, changed: byId.get(block.id)?.content !== markdown };
    });
    const next = reconcileDocumentBlocks(current.blocks, items, current.sourceMessages);
    if (sameBlockList(current.blocks, next)) return;
    const typed = update.transactions.find((tr) => tr.docChanged);
    const head = live.layout.length ? live.layout[blockIndexAt(live.layout, update.state.selection.main.head)]?.id : undefined;
    const group = typed && head ? typed.isUserEvent("input.type") ? `${head}:typing` : typed.isUserEvent("delete") ? `${head}:deleting` : undefined : undefined;
    current.onChangeBlocks(next, { group, beforeFocus: bookmark(update.startState), afterFocus: bookmark(update.state) });
  }

  function notifySelection(view: EditorView) {
    const current = latest.current;
    if (!current.onSelectionChange) return;
    const live = stateOf(view);
    if (!view.hasFocus && live.mode !== "reading") return;
    const main = view.state.selection.main;
    if (main.empty) { current.onSelectionChange(null); return; }
    const selection = blockSelection(textOf(view.state.doc), live.layout, main.from, main.to);
    if (!selection || selection.to <= selection.from) { current.onSelectionChange(null); return; }
    const ids = [selection.id, ...selection.joinBlockIds];
    // Media, streaming text and the unsaved typing line can't hold a passage.
    if (ids.some((id) => isDraftBlockId(id) || live.locked.has(id)) || selection.joinBlockIds.length && ids.some((id) => {
      const block = live.layout.find((item) => item.id === id);
      return !block || liveBlockInfo(view.state.doc.sliceString(block.from, block.to)).kind !== "text";
    })) { current.onSelectionChange(null); return; }
    const block = blockById.get(selection.id);
    current.onSelectionChange({ conversationId: current.conversationId, messageId: block?.sourceMessageId ?? `document:${selection.id}`, sourceBlockId: selection.id,
      startOffset: selection.from, endOffset: selection.to, quote: selection.markdown.slice(selection.from, selection.to), rect: selectionRect(view),
      ...(selection.joinBlockIds.length ? { joinBlockIds: selection.joinBlockIds } : {}) });
  }

  /** Text selected in a rendered table, which CodeMirror doesn't see, as a passage of the table's Markdown. */
  function notifyPreviewSelection() {
    const current = latest.current;
    const view = viewRef.current;
    const root = rootRef.current;
    if (!current.onSelectionChange || !view || !root) return;
    const selection = window.getSelection();
    const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
    const widgetOf = (node: Node) => (node instanceof Element ? node : node.parentElement)?.closest<HTMLElement>(".live-document-widget") ?? null;
    const widget = range && !range.collapsed ? widgetOf(range.startContainer) : null;
    const id = widget?.dataset.documentBlockId;
    const live = stateOf(view);
    const block = id ? live.layout.find((item) => item.id === id) : undefined;
    const markdown = block ? view.state.doc.sliceString(block.from, block.to) : "";
    const body = widget?.querySelector(".live-document-widget-body");
    if (!range || !widget || !id || !block || !body || widgetOf(range.endContainer) !== widget || !root.contains(widget)
      || isDraftBlockId(id) || live.locked.has(id) || !isTableBlock(markdown)) {
      if (previewSelection.current) {
        previewSelection.current = false;
        if (view.state.selection.main.empty) current.onSelectionChange(null);
      }
      return;
    }
    const offset = (node: Node, at: number) => {
      const before = document.createRange();
      before.selectNodeContents(body);
      before.setEnd(node, at);
      return before.toString().length;
    };
    const span = renderedTableSelection(markdown, body.textContent ?? "", offset(range.startContainer, range.startOffset), offset(range.endContainer, range.endOffset));
    if (!span) return;
    previewSelection.current = true;
    const rect = range.getBoundingClientRect();
    current.onSelectionChange({ conversationId: current.conversationId, messageId: blockById.get(id)?.sourceMessageId ?? `document:${id}`, sourceBlockId: id,
      startOffset: span.from, endOffset: span.to, quote: markdown.slice(span.from, span.to), rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height } });
  }

  function invoke(view: EditorView, spaces = 0, blockId?: string) {
    const current = latest.current;
    if (!current.onInvokeAI) return false;
    const live = stateOf(view);
    const main = view.state.selection.main;
    let selection = blockSelection(textOf(view.state.doc), live.layout, main.from, main.to);
    if (selection?.joinBlockIds.length) selection = null;
    if (blockId && selection?.id !== blockId) {
      const block = live.layout.find((item) => item.id === blockId);
      if (!block) return false;
      const markdown = view.state.doc.sliceString(block.from, block.to);
      selection = { index: 0, id: blockId, markdown, from: markdown.length, to: markdown.length, joinBlockIds: [] };
    }
    if (!selection || live.locked.has(selection.id)) return false;
    let id = selection.id;
    const { markdown, from: offset, to: endOffset } = selection;
    if (isDraftBlockId(id)) {
      // AI writes after a saved block, so a blank continuation line is saved first.
      const created = fresh(markdown);
      emit([...current.blocks, created]);
      id = created.id;
    }
    current.onInvokeAI({ blockId: id, markdown, offset, rect: selectionRect(view), typing: spaces > 0,
      selection: endOffset > offset ? { startOffset: offset, endOffset, quote: markdown.slice(offset, endOffset) } : undefined,
      restoreFocus(options) {
        suppressSpace.current = true;
        const target = viewRef.current;
        if (!target) return;
        const block = stateOf(target).layout.find((item) => item.id === id);
        if (!block) return;
        const position = block.from + Math.min(offset, block.to - block.from);
        target.focus();
        target.dispatch({ selection: EditorSelection.cursor(position) });
        if (options?.restoreSpaces && spaces) target.dispatch(target.state.replaceSelection(" ".repeat(spaces)));
      },
    });
    return true;
  }

  /** Space on an empty line, two spaces after a word, or a phone's ". " opens Ask AI. */
  function aiInput(view: EditorView, from: number, to: number, text: string) {
    if (!latest.current.onInvokeAI || view.composing || view.state.readOnly) return false;
    if (text !== " " && text !== " " && !/^\.[  ]$/.test(text)) { suppressSpace.current = false; literalSpace.current = false; return false; }
    if (literalSpace.current) return false;
    // Only the first Space after closing Ask AI types a plain space; it doesn't keep Space from opening it later.
    if (suppressSpace.current) { suppressSpace.current = false; return false; }
    const main = view.state.selection.main;
    if (!main.empty || inCode(view.state, main.head)) return false;
    const live = stateOf(view);
    if (!live.layout.length) return false;
    const block = live.layout[blockIndexAt(live.layout, main.head)];
    if (live.locked.has(block.id)) return false;
    const line = view.state.doc.lineAt(main.head);
    const preceding = view.state.doc.sliceString(line.from, main.head);
    if (/^[  ]$/.test(text) && from === main.head && to === main.head) {
      // An empty line, whether it is its own block or a blank line inside one, such as a list just ended.
      if (block.from === block.to || line.from === line.to) return invoke(view, 1);
      if (/\S[  ]$/.test(preceding)) {
        view.dispatch({ changes: { from: main.head - 1, to: main.head } });
        return invoke(view, 2);
      }
    }
    if (/^\.[  ]$/.test(text) && from === main.head - 1 && to === main.head && /\S[  ]$/.test(preceding)) {
      view.dispatch({ changes: { from, to } });
      return invoke(view, 2);
    }
    return false;
  }

  function placeAskButton(view: EditorView) {
    const clear = () => setAskButton((current) => current ? null : current);
    if (!latest.current.onInvokeAI || !view.hasFocus || mobileRef.current || typing.current || view.state.readOnly) { clear(); return; }
    const live = stateOf(view);
    const main = view.state.selection.main;
    if (live.mode === "reading" || !main.empty || !live.layout.length || inCode(view.state, main.head)
      || live.locked.has(live.layout[blockIndexAt(live.layout, main.head)].id)) { clear(); return; }
    view.requestMeasure({
      key: askButtonMeasure,
      read(target) {
        const caret = target.coordsAtPos(target.state.selection.main.head);
        const root = rootRef.current?.getBoundingClientRect();
        if (!caret || !root) return null;
        return { top: Math.round(caret.bottom - root.top + 4), left: Math.round(Math.max(0, Math.min(caret.left - root.left - 4, root.width - 96))) };
      },
      write(position) { setAskButton((current) => position && current && current.top === position.top && current.left === position.left ? current : position); },
    });
  }

  function enter(view: EditorView) {
    const live = stateOf(view);
    if (view.state.readOnly) return false;
    const main = view.state.selection.main;
    if (!main.empty) view.dispatch(view.state.replaceSelection(""), { userEvent: "delete" });
    const head = view.state.selection.main.head;
    const doc = view.state.doc;
    const edit = getMarkdownEnterEdit(doc.toString(), head);
    if (live.mode === "source") {
      if (edit) view.dispatch({ changes: { from: edit.from, to: edit.to, insert: edit.insert }, selection: EditorSelection.cursor(edit.selection), userEvent: "input", scrollIntoView: true });
      else view.dispatch(view.state.replaceSelection("\n"), { userEvent: "input", scrollIntoView: true });
      return true;
    }
    const block = live.layout[blockIndexAt(live.layout, head)];
    if (edit) {
      const line = doc.lineAt(head);
      // Enter on an empty list item or quote line ends it with a new line below, not more of the same block.
      if (!edit.insert && edit.from === line.from && line.from > block.from) {
        view.dispatch({ changes: { from: line.from - 1, to: line.to, insert: BLOCK_SEPARATOR }, selection: EditorSelection.cursor(line.from + 1), userEvent: "input", scrollIntoView: true });
        return true;
      }
      view.dispatch({ changes: { from: edit.from, to: edit.to, insert: edit.insert }, selection: EditorSelection.cursor(edit.selection), userEvent: "input", scrollIntoView: true });
      return true;
    }
    if (inCode(view.state, head)) { view.dispatch(view.state.replaceSelection("\n"), { userEvent: "input", scrollIntoView: true }); return true; }
    // Enter starts a new line, which is a new block. At the end of a line that saved blank lines after it, the new line goes after them.
    const end = visibleEnd(textOf(doc), block);
    const at = head === end ? block.to : head;
    view.dispatch({ changes: { from: at, insert: BLOCK_SEPARATOR }, selection: EditorSelection.cursor(at + BLOCK_SEPARATOR.length), userEvent: "input", scrollIntoView: true });
    return true;
  }

  function backspace(view: EditorView) {
    const live = stateOf(view);
    const main = view.state.selection.main;
    if (!main.empty || view.state.readOnly) return false;
    const doc = view.state.doc;
    const edit = getMarkdownBackspaceEdit(doc.toString(), main.head);
    if (edit) {
      view.dispatch({ changes: { from: edit.from, to: edit.to, insert: edit.insert }, selection: EditorSelection.cursor(edit.selection), userEvent: "delete" });
      return true;
    }
    if (live.mode === "source" || !live.layout.length) return false;
    const index = blockIndexAt(live.layout, main.head);
    const block = live.layout[index];
    if (main.head === block.from && index > 0) {
      const previous = live.layout[index - 1];
      if (live.locked.has(block.id) || live.locked.has(previous.id)) return true;
      const previousKind = liveBlockInfo(doc.sliceString(previous.from, previous.to)).kind;
      // A line never joins onto media or a drawing; an empty line before it just goes away.
      if (previousKind !== "text" && block.to > block.from) { view.dispatch({ selection: EditorSelection.cursor(previous.from) }); return true; }
      const end = visibleEnd(textOf(doc), previous);
      view.dispatch({ changes: { from: end, to: block.from }, selection: EditorSelection.cursor(end), userEvent: "delete", scrollIntoView: true });
      return true;
    }
    // Inside a block, a line break after hidden blank lines removes them too.
    const content = doc.sliceString(block.from, block.to);
    for (const run of liveBlockInfo(content).collapsed) {
      if (main.head === block.from + run.to + 1) {
        view.dispatch({ changes: { from: block.from + run.from, to: main.head }, userEvent: "delete" });
        return true;
      }
    }
    return false;
  }

  function deleteForward(view: EditorView) {
    const live = stateOf(view);
    const main = view.state.selection.main;
    if (!main.empty || view.state.readOnly || live.mode === "source" || !live.layout.length) return false;
    const doc = view.state.doc;
    const index = blockIndexAt(live.layout, main.head);
    const block = live.layout[index];
    const next = live.layout[index + 1];
    if (!next || main.head !== visibleEnd(textOf(doc), block)) return false;
    if (live.locked.has(block.id) || live.locked.has(next.id)) return true;
    if (liveBlockInfo(doc.sliceString(next.from, next.to)).kind !== "text") {
      if (block.from === block.to) view.dispatch({ changes: { from: block.from, to: next.from }, userEvent: "delete" });
      return true;
    }
    view.dispatch({ changes: { from: main.head, to: next.from }, userEvent: "delete" });
    return true;
  }

  function moveBlock(view: EditorView, direction: -1 | 1) {
    const current = latest.current;
    const at = blockAtHead(view);
    if (!at || !current.onReorderBlock) return false;
    const { index, block, live } = at;
    if (isDraftBlockId(block.id) || live.locked.has(block.id)) return true;
    const target = direction < 0 ? live.layout[index - 1] : live.layout[index + 2];
    if (direction < 0 && !target) return true;
    if (direction > 0 && (!live.layout[index + 1] || isDraftBlockId(live.layout[index + 1].id))) return true;
    const main = view.state.selection.main;
    pendingFocus.current = { id: block.id, offset: main.from - block.from, to: main.to - block.from };
    current.onReorderBlock(block.id, target && !isDraftBlockId(target.id) ? target.id : null);
    setAnnouncement(direction < 0 ? "Line moved up." : "Line moved down.");
    return true;
  }

  function insertMediaFiles(view: EditorView, files: File[]) {
    const store = vaultMediaRef.current;
    const at = blockAtHead(view);
    if (!store || !files.length || !at || at.live.locked.has(at.block.id)) return false;
    setMediaError(null);
    const id = at.block.id;
    void (async () => {
      const saved: string[] = [];
      try { for (const file of files) saved.push(await store.save(file)); }
      catch (error) { setMediaError(error instanceof Error ? error.message : "This file could not be saved."); }
      if (saved.length) insertAfter(id, saved);
    })();
    return true;
  }

  function setMode(next: LivePreviewMode) {
    saveDocumentViewMode(next);
    const view = viewRef.current;
    if (view && next !== "reading") requestAnimationFrame(() => view.focus());
  }

  // The editor is created once per document; its handlers reach this render through these proxies.
  const handlers = useRef({ commit, notifySelection, notifyPreviewSelection, aiInput, enter, backspace, deleteForward, moveBlock, insertMediaFiles, setMode, invoke, placeAskButton });
  handlers.current = { commit, notifySelection, notifyPreviewSelection, aiInput, enter, backspace, deleteForward, moveBlock, insertMediaFiles, setMode, invoke, placeAskButton };
  useEffect(() => {
    let frame = 0;
    const changed = () => { window.cancelAnimationFrame(frame); frame = window.requestAnimationFrame(() => handlers.current.notifyPreviewSelection()); };
    document.addEventListener("selectionchange", changed);
    return () => { document.removeEventListener("selectionchange", changed); window.cancelAnimationFrame(frame); };
  }, []);
  mobileRef.current = mobileKeyboard.mobile;
  const compartments = useMemo(() => ({ editable: new Compartment(), attributes: new Compartment(), history: new Compartment() }), []);

  function editableExtensions(currentMode: LivePreviewMode): Extension {
    const writable = editable && currentMode !== "reading";
    return [EditorView.editable.of(writable), EditorState.readOnly.of(!writable)];
  }
  function attributeExtensions(): Extension {
    return EditorView.contentAttributes.of({
      "aria-label": latest.current.ariaLabel ?? "Editable document", "aria-multiline": "true", role: "textbox",
      spellcheck: "true", "data-mobile-keyboard": "", inputmode: mobileKeyboard.inputMode,
    });
  }

  useLayoutEffect(() => {
    const host = hostRef.current!;
    const { text, layout } = layoutBlocks(visibleBlocks);
    const proxy = handlers;
    const state = EditorState.create({
      doc: text,
      extensions: [
        liveField.init(() => ({ layout, anchors: [], locked: new Set(), mode, focused: false, after: new Set(), meta: new Map(), placeholder: null, conversationId: props.conversationId })),
        blockDecorationField(widgets),
        compartments.history.of(props.onHistory ? [] : history()),
        compartments.editable.of(editableExtensions(mode)),
        compartments.attributes.of(attributeExtensions()),
        drawSelection(),
        markdown({ extensions: [GFM], addKeymap: false }),
        EditorView.lineWrapping,
        livePreviewInline((current) => current.field(liveField).mode),
        beacons,
        EditorView.focusChangeEffect.of((_state, focusing) => setView.of({ focused: focusing })),
        EditorState.transactionFilter.of((tr) => {
          if (tr.annotation(externalSync)) return tr;
          const live = tr.startState.field(liveField);
          if (tr.docChanged && live.locked.size) {
            let blocked = false;
            tr.changes.iterChangedRanges((fromA, toA) => {
              for (const block of live.layout) if (live.locked.has(block.id) && fromA <= block.to && toA >= block.from) blocked = true;
            });
            if (blocked) return [];
          }
          // A click past the end of a line can land in the hidden blank line after it; the cursor belongs at the line's end.
          if (tr.selection && live.mode !== "source") {
            const next = tr.state.field(liveField);
            const doc = textOf(tr.newDoc);
            const ranges = tr.newSelection.ranges.map((range) => {
              const anchor = snapOutOfGaps(doc, next.layout, range.anchor, -1);
              const head = snapOutOfGaps(doc, next.layout, range.head, -1);
              return anchor === range.anchor && head === range.head ? range : EditorSelection.range(anchor, head);
            });
            if (ranges.some((range, index) => range !== tr.newSelection.ranges[index])) {
              return [tr, { selection: EditorSelection.create(ranges, tr.newSelection.mainIndex), sequential: true }];
            }
          }
          return tr;
        }),
        EditorView.inputHandler.of((view, from, to, text) => proxy.current.aiInput(view, from, to, text)),
        keymap.of([
          { key: "Enter", run: (view) => proxy.current.enter(view) },
          { key: "Shift-Enter", run: (view) => { if (view.state.readOnly) return false; view.dispatch(view.state.replaceSelection("\n"), { userEvent: "input", scrollIntoView: true }); return true; } },
          { key: "Backspace", run: (view) => proxy.current.backspace(view) },
          { key: "Delete", run: (view) => proxy.current.deleteForward(view) },
          { key: "Tab", run: (view) => indentMore(view) },
          { key: "Shift-Tab", run: (view) => indentLess(view) },
          { key: "Alt-ArrowUp", run: (view) => proxy.current.moveBlock(view, -1) },
          { key: "Alt-ArrowDown", run: (view) => proxy.current.moveBlock(view, 1) },
          { key: "Mod-b", run: (view) => !view.state.readOnly && toggleWrap(view, "**") },
          { key: "Mod-i", run: (view) => !view.state.readOnly && toggleWrap(view, "*") },
          { key: "Mod-d", run: (view) => { if (view.state.readOnly) return false; view.dispatch(view.state.replaceSelection(formatDocumentDateTime()), { userEvent: "input" }); return true; } },
          { key: "Mod-e", run: (view) => { const live = view.state.field(liveField); proxy.current.setMode(live.mode === "reading" ? "live" : "reading"); return true; } },
          { key: "Escape", run: () => { latest.current.onSelectionChange?.(null); return false; } },
          ...defaultKeymap,
          ...(props.onHistory ? [] : historyKeymap),
        ]),
        EditorView.domEventHandlers({
          keydown(event) {
            literalSpace.current = event.key === " " && (event.repeat || event.shiftKey || event.altKey || event.ctrlKey || event.metaKey);
            if (event.key !== " " && event.key !== "Unidentified" && event.key !== "Process") suppressSpace.current = false;
            return false;
          },
          mousedown() { suppressSpace.current = false; return false; },
          mouseup(_event, view) { queueMicrotask(() => { if (viewRef.current === view) proxy.current.notifySelection(view); }); return false; },
          paste(event, view) {
            const files = [...event.clipboardData?.files ?? []].filter(isMediaFile);
            if (!files.length || !proxy.current.insertMediaFiles(view, files)) return false;
            event.preventDefault();
            return true;
          },
          drop(event, view) {
            const files = [...event.dataTransfer?.files ?? []].filter(isMediaFile);
            if (!files.length || !proxy.current.insertMediaFiles(view, files)) return false;
            event.preventDefault();
            return true;
          },
        }),
        EditorView.updateListener.of((update) => {
          const external = update.transactions.some((tr) => tr.annotation(externalSync));
          if (update.docChanged && !external) proxy.current.commit(update);
          if (update.docChanged && update.transactions.some((tr) => tr.isUserEvent("input") || tr.isUserEvent("delete"))) {
            typing.current = true;
            clearTimeout(typingTimer.current);
            typingTimer.current = setTimeout(() => {
              typing.current = false;
              if (viewRef.current === update.view) proxy.current.placeAskButton(update.view);
            }, ASK_BUTTON_TYPING_PAUSE_MS);
          }
          if (update.selectionSet || update.focusChanged || update.docChanged || update.geometryChanged) proxy.current.placeAskButton(update.view);
          if (update.selectionSet || update.focusChanged) {
            if (update.selectionSet) proxy.current.notifySelection(update.view);
            const live = update.state.field(liveField);
            const id = live.layout.length ? live.layout[blockIndexAt(live.layout, update.state.selection.main.head)].id : null;
            setFocusedBlockId(id);
            setEditorFocused(update.view.hasFocus);
          }
        }),
      ],
    });
    const view = new EditorView({ state, parent: host });
    viewRef.current = view;
    widgets.view = view;
    return () => {
      widgets.view = null;
      viewRef.current = null;
      clearTimeout(typingTimer.current);
      typing.current = false;
      view.destroy();
    };
    // The editor is created once per document; later prop changes are synchronized below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.conversationId]);

  // Saved blocks (AI output, undo, moves, other tabs) come into the editor without disturbing the caret.
  const decorationKey = JSON.stringify(props.decorations ?? {});
  const metaKey = visibleBlocks.map((block) => `${block.id}:${getDocumentBlockAuthorship(block, props.sourceMessages)}:${block.sourceMessageId ?? ""}:${readOnlyIds.has(block.id) ? 1 : 0}`).join("|");
  const placeholderId = props.hidePlaceholder ? undefined
    : (visibleBlocks.find((block) => !block.content && !readOnlyIds.has(block.id) && block.id === focusedBlockId) ?? visibleBlocks.filter((block) => !block.content && !readOnlyIds.has(block.id)).at(-1))?.id;
  const [syncRetry, setSyncRetry] = useState(0);
  useLayoutEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const live = view.state.field(liveField);
    const doc = view.state.doc;
    const blocks = visibleBlocks;
    const layout = live.layout;
    const same = (index: number, at: number) => blocks[index].id === layout[at].id && blocks[index].content.length === layout[at].to - layout[at].from
      && blocks[index].content === doc.sliceString(layout[at].from, layout[at].to);
    let prefix = 0;
    while (prefix < blocks.length && prefix < layout.length && same(prefix, prefix)) prefix += 1;
    let suffix = 0;
    while (suffix < blocks.length - prefix && suffix < layout.length - prefix && same(blocks.length - 1 - suffix, layout.length - 1 - suffix)) suffix += 1;
    const effects: StateEffect<unknown>[] = [];
    let changes: { from: number; to: number; insert: string } | undefined;
    const blocksChanged = prefix !== blocks.length || prefix !== layout.length;
    const nextLayout = blocksChanged ? layoutBlocks(blocks).layout : layout;
    if (blocksChanged) {
      const middle = blocks.slice(prefix, blocks.length - suffix).map((block) => block.content);
      const removed = layout.length - suffix - prefix;
      let from: number, to: number, insert: string;
      if (removed > 0 && middle.length) { from = layout[prefix].from; to = layout[prefix + removed - 1].to; insert = middle.join(BLOCK_SEPARATOR); }
      else if (middle.length) {
        if (prefix > 0) { from = to = layout[prefix - 1].to; insert = BLOCK_SEPARATOR + middle.join(BLOCK_SEPARATOR); }
        else { from = to = 0; insert = middle.join(BLOCK_SEPARATOR) + (layout.length ? BLOCK_SEPARATOR : ""); }
      } else if (prefix > 0) { from = layout[prefix - 1].to; to = layout[prefix + removed - 1].to; insert = ""; }
      else if (suffix > 0) { from = 0; to = layout[removed].from; insert = ""; }
      else { from = 0; to = doc.length; insert = ""; }
      if (doc.sliceString(from, to) !== insert) changes = { from, to, insert };
    }
    const anchors = anchorRanges(nextLayout, blocks, props.decorations);
    if (blocksChanged || JSON.stringify(anchors) !== JSON.stringify(live.anchors)) effects.push(setLayout.of({ layout: nextLayout, anchors }));
    const meta = new Map(blocks.map((block) => [block.id, { authorship: getDocumentBlockAuthorship(block, props.sourceMessages), messageId: block.sourceMessageId ?? `document:${block.id}`, streaming: readOnlyIds.has(block.id) }]));
    const viewChanges: Partial<LiveState> = {};
    if (live.conversationId !== props.conversationId) viewChanges.conversationId = props.conversationId;
    if (live.mode !== mode) viewChanges.mode = mode;
    if ([...live.locked].join("|") !== [...readOnlyIds].join("|")) viewChanges.locked = readOnlyIds;
    if ([...live.meta].map(([id, item]) => `${id}:${item.authorship}:${item.messageId}:${item.streaming ? 1 : 0}`).join("|") !== [...meta].map(([id, item]) => `${id}:${item.authorship}:${item.messageId}:${item.streaming ? 1 : 0}`).join("|")) viewChanges.meta = meta;
    const placeholder = placeholderId ? { id: placeholderId, text: placeholderText } : null;
    if (JSON.stringify(placeholder) !== JSON.stringify(live.placeholder)) viewChanges.placeholder = placeholder;
    if (Object.keys(viewChanges).length) effects.push(setView.of(viewChanges));
    if (viewChanges.mode !== undefined) effects.push(compartments.editable.reconfigure(editableExtensions(mode)));
    if (!changes && !effects.length) return;
    try {
      view.dispatch({ changes, effects, annotations: [externalSync.of(true), Transaction.addToHistory.of(false)] });
    } catch {
      // An update arrived while the editor was mid-update (a handler emitted synchronously); try again next frame.
      requestAnimationFrame(() => setSyncRetry((value) => value + 1));
    }
  });
  // decorationKey and metaKey are read through the render above.
  void decorationKey; void metaKey; void syncRetry;

  useLayoutEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({ effects: compartments.attributes.reconfigure(attributeExtensions()) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.ariaLabel, mobileKeyboard.inputMode]);

  // Undo and redo, and lines moved with Alt+arrows, put the caret back where the change happened.
  const pendingHistoryFocus = useRef<DocumentEditFocus | null>(null);
  const [historyRevision, setHistoryRevision] = useState(0);
  useLayoutEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const live = stateOf(view);
    const history = pendingHistoryFocus.current;
    const request = history ? { id: history.blockId, offset: history.from, to: history.to } : pendingFocus.current;
    if (!request) return;
    const block = live.layout.find((item) => item.id === request.id) ?? (history ? live.layout.at(-1) : undefined);
    if (!block) return;
    if (history) pendingHistoryFocus.current = null; else pendingFocus.current = null;
    const length = block.to - block.from;
    const anchor = block.from + Math.min(request.offset, length);
    const head = block.from + Math.min(request.to ?? request.offset, length);
    view.dispatch({ selection: EditorSelection.range(anchor, head), scrollIntoView: true });
    view.focus();
  }, [historyRevision, props.blocks]);

  // What follows each block, and the media, drawings and previews shown in place of their Markdown.
  const afterContent = useRef(new Set<string>());
  useLayoutEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    // Every block gets a home for what follows it; only those React fills take up a line.
    const ids = new Set<string>();
    for (const block of visibleBlocks) if (widgets.container(`after:${block.id}`, "rich-document-block-after").childNodes.length) ids.add(block.id);
    const live = view.state.field(liveField);
    if ([...ids].join("|") !== [...live.after].join("|")) {
      afterContent.current = ids;
      try { view.dispatch({ effects: setView.of({ after: ids }), annotations: externalSync.of(true) }); }
      catch { requestAnimationFrame(() => setSyncRetry((value) => value + 1)); }
    }
    const keys = new Set<string>();
    for (const block of visibleBlocks) {
      keys.add(`after:${block.id}`);
      const kind = liveBlockInfo(block.content).kind;
      if (kind !== "text") keys.add(`${kind}:${block.id}`);
    }
    widgets.prune(keys);
  });

  // The "+" beside an empty line inserts media, a drawing, a table or an equation.
  useLayoutEffect(() => {
    const view = viewRef.current;
    const root = rootRef.current;
    if (!view || !root || !editable || mode === "reading" || !editorFocused || !focusedBlockId) { if (insertMenu && !insertMenu.open) setInsertMenu(null); return; }
    const block = view.state.field(liveField).layout.find((item) => item.id === focusedBlockId);
    if (!block || block.from !== block.to || readOnlyIds.has(block.id)) { if (insertMenu && !insertMenu.open) setInsertMenu(null); return; }
    const coords = view.coordsAtPos(block.from);
    if (!coords) return;
    const top = Math.round(coords.top - root.getBoundingClientRect().top + (coords.bottom - coords.top) / 2);
    if (insertMenu?.blockId !== block.id || insertMenu.top !== top) setInsertMenu({ top, blockId: block.id, open: false });
  });

  function insertMarkdown(blockId: string, markdown: string) {
    setInsertMenu(null);
    insertAfter(blockId, [markdown]);
  }

  function openDrawing(block: DocumentBlock) {
    setDrawingError(null);
    const isDrawing = isDrawingMarkdown(block.content);
    if (isDrawing) {
      try { readDrawing(block.content); } catch (error) { setDrawingError(error instanceof Error ? error.message : "Invalid drawing."); return; }
    }
    setInsertMenu(null);
    setDrawing({ blockId: block.id, markdown: isDrawing ? block.content : drawingMarkdown(EMPTY_DRAWING), original: isDrawing ? block.content : undefined });
  }
  function saveDrawing(markdown: string) {
    if (!drawing) return;
    const block = blockById.get(drawing.blockId);
    if (!block || readOnlyIds.has(block.id)) return;
    if (drawing.original !== undefined && block.content !== drawing.original) {
      setDrawingError("This drawing changed while it was open. Close the editor and reopen the latest drawing before saving.");
      return;
    }
    if (drawing.original !== undefined || !block.content.trim()) setBlockContent(block.id, markdown);
    else insertAfter(block.id, [markdown]);
    setDrawing(null);
  }
  function saveEquation(latex: string, display: boolean) {
    if (!equation) return;
    setEquation(null);
    const clean = latex.trim();
    if (!clean) return;
    insertMarkdown(equation.blockId, display ? `$$\n${clean}\n$$` : `$${clean}$`);
  }
  /** Put the caret in a block, which shows its Markdown. */
  function editBlock(id: string) {
    const view = viewRef.current;
    const block = view?.state.field(liveField).layout.find((item) => item.id === id);
    if (!view || !block || !editable || mode === "reading") return;
    view.focus();
    view.dispatch({ selection: EditorSelection.cursor(block.from), scrollIntoView: true });
  }

  function renderWidget(key: string) {
    const element = widgets.existing(key);
    if (!element) return null;
    const separator = key.indexOf(":");
    const kind = key.slice(0, separator);
    const id = key.slice(separator + 1);
    const block = blockById.get(id);
    if (!block) return null;
    const readOnly = !editable || readOnlyIds.has(id) || mode === "reading";
    if (kind === "after") {
      const touch = mobileKeyboard.mobile && editable && mode !== "reading" && focusedBlockId === id && !readOnlyIds.has(id);
      return createPortal(<>
        {touch && <div className="rich-document-touch-actions live-document-touch-actions">
          {props.onInvokeAI && <button type="button" onMouseDown={(event) => event.preventDefault()} aria-label="Ask AI" data-label="✦ Ask AI" onClick={() => { const view = viewRef.current; if (view) invoke(view, 0, id); }} />}
          {block.content && <button type="button" onMouseDown={(event) => event.preventDefault()} aria-label="Select block" data-label="Select block" onClick={() => {
            const view = viewRef.current;
            const target = view?.state.field(liveField).layout.find((item) => item.id === id);
            if (!view || !target) return;
            view.dispatch({ selection: EditorSelection.range(target.from, visibleEnd(textOf(view.state.doc), target)) });
            view.focus();
          }} />}
        </div>}
        {!isDraftBlockId(id) ? props.renderAfterBlock?.(block) : null}
      </>, element, key);
    }
    if (kind === "media") {
      const media = parseMediaBlock(block.content);
      return media ? createPortal(<DocumentMedia markdown={block.content} media={media} readOnly={readOnly} onChange={(markdown) => setBlockContent(id, markdown)} onEditSource={() => editBlock(id)} />, element, key) : null;
    }
    if (kind === "drawing") {
      return createPortal(<Suspense fallback={<p role="status">Loading drawing…</p>}><DocumentDrawing markdown={block.content} readOnly={readOnly} onEdit={() => openDrawing(block)} /></Suspense>, element, key);
    }
    // The preview takes focus itself, so the editor doesn't put its own selection back over text selected here.
    return createPortal(<div className="live-document-preview" tabIndex={-1} onClick={(event) => {
      if (!window.getSelection()?.isCollapsed || (event.target instanceof Element && event.target.closest("a, button, input, summary, [data-annotation-branches]"))) return;
      editBlock(id);
    }}>{props.renderBlockPreview?.(block) ?? <div className="message-content" dangerouslySetInnerHTML={{ __html: renderObsidianMarkdownToHtml(block.content) }} />}</div>, element, key);
  }

  return <div ref={rootRef} data-block-editor-conversation-id={props.conversationId} data-mode={mode}
    className={`rich-document-editor live-document-editor ${props.className ?? ""}`} role="group" aria-label={props.ariaLabel ?? "Editable document"}
    onClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}
    onKeyDownCapture={(event) => {
      if (!props.onHistory || !(event.metaKey || event.ctrlKey) || event.altKey || event.key.toLowerCase() !== "z" || event.nativeEvent.isComposing) return;
      const target = event.target instanceof Element ? event.target : null;
      if (!target || target.closest(".document-ai-composer, .document-prompt-history, .math-equation-dialog, .document-drawing-dialog, .live-document-after, .live-document-widget")) return;
      if (target.closest("input, textarea")) return;
      event.preventDefault();
      event.stopPropagation();
      pendingFocus.current = null;
      const focus = props.onHistory(event.shiftKey ? "redo" : "undo");
      if (focus) { pendingHistoryFocus.current = focus; setHistoryRevision((revision) => revision + 1); setAnnouncement(event.shiftKey ? "Edit redone." : "Edit undone."); }
    }}>
    <div className="live-document-modes" role="toolbar" aria-label="Document view">
      {(["live", "source", "reading"] as const).map((candidate) => <button key={candidate} type="button" aria-pressed={mode === candidate}
        title={candidate === "live" ? "Live Preview: Markdown shows on the line you're editing" : candidate === "source" ? "Source: the Markdown file as saved" : "Reading: rendered, not editable (⌘E)"}
        onMouseDown={(event) => event.preventDefault()} onClick={() => setMode(candidate)}>
        {candidate === "live" ? "Live Preview" : candidate === "source" ? "Source" : "Reading"}
      </button>)}
    </div>
    <div ref={hostRef} className="live-document-host" />
    {askButton && props.onInvokeAI && editable && editorFocused && mode !== "reading" && !mobileKeyboard.mobile
      && <button type="button" className="live-document-ask" style={{ top: askButton.top, left: askButton.left }}
        aria-label="Ask AI here" title="Ask AI here (or press Space on an empty line)"
        onMouseDown={(event) => event.preventDefault()} onClick={() => { const view = viewRef.current; if (view) invoke(view); }}>✦ Ask AI</button>}
    {insertMenu && <div className="live-document-insert" style={{ top: insertMenu.top }}>
      <button type="button" className="live-document-insert-toggle" aria-label="Insert media, a drawing, a table or an equation" aria-expanded={insertMenu.open} title="Insert"
        onMouseDown={(event) => event.preventDefault()} onClick={() => setInsertMenu({ ...insertMenu, open: !insertMenu.open })}>+</button>
      {insertMenu.open && <div className="live-document-insert-menu" role="menu">
        <button type="button" role="menuitem" onMouseDown={(event) => event.preventDefault()} onClick={() => { setMediaFormFor(insertMenu.blockId); setInsertMenu(null); }}>Image or video</button>
        <button type="button" role="menuitem" onMouseDown={(event) => event.preventDefault()} onClick={() => { const block = blockById.get(insertMenu.blockId); if (block) openDrawing(block); }}>Drawing</button>
        <button type="button" role="menuitem" onMouseDown={(event) => event.preventDefault()} onClick={() => insertMarkdown(insertMenu.blockId, "| Column 1 | Column 2 |\n| --- | --- |\n|  |  |")}>Table</button>
        <button type="button" role="menuitem" onMouseDown={(event) => event.preventDefault()} onClick={() => { setEquation({ blockId: insertMenu.blockId, at: 0, docLength: 0 }); setInsertMenu(null); }}>Equation</button>
      </div>}
    </div>}
    {mediaFormFor && <div className="live-document-media-form"><MediaInsertForm onInsert={(markdown) => { const id = mediaFormFor; setMediaFormFor(null); insertMarkdown(id, markdown); }} onClose={() => setMediaFormFor(null)} /></div>}
    {mediaError && <p className="rich-document-media-error" role="alert">{mediaError}</p>}
    {drawingError && !drawing && <p role="alert">{drawingError}</p>}
    {containerKeys.map(renderWidget)}
    {drawing && <Suspense fallback={<p role="status">Opening drawing editor…</p>}><DrawingDialog markdown={drawing.markdown} error={drawingError ?? ""} onSave={saveDrawing} onClose={() => setDrawing(null)} /></Suspense>}
    {equation && <MathEquationDialog latex="" display={false} editing={false} error={null} onSave={saveEquation} onClose={() => setEquation(null)} />}
    <span className="rich-document-announcement" role="status" aria-live="polite">{announcement}</span>
  </div>;
}

/** Saved passages as text positions, from each block's Markdown offsets. */
function anchorRanges(layout: LiveBlock[], blocks: DocumentBlock[], decorations: RichDocumentEditorProps["decorations"]): AnchorRange[] {
  if (!decorations) return [];
  const ranges: AnchorRange[] = [];
  layout.forEach((block, index) => {
    const length = blocks[index]?.content.length ?? block.to - block.from;
    for (const range of decorations[block.id] ?? []) {
      if (!(range.to > range.from && range.from >= 0 && range.to <= length)) continue;
      ranges.push({ from: block.from + range.from, to: block.from + range.to, branchIds: range.branchIds ?? [], noteIds: range.noteIds ?? [] });
    }
  });
  return ranges;
}
