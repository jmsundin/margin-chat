import {
  Annotation,
  Compartment,
  EditorSelection,
  EditorState,
  type Extension,
  type Range,
} from "@codemirror/state";
import {
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
  drawSelection,
  dropCursor,
  keymap,
  placeholder as editorPlaceholder,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";
import {
  bracketMatching,
  defaultHighlightStyle,
  indentOnInput,
  syntaxHighlighting,
  syntaxTree,
} from "@codemirror/language";
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentLess,
  indentMore,
} from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { GFM } from "@lezer/markdown";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type FocusEvent,
} from "react";
import {
  getMarkdownBackspaceEdit,
  getMarkdownEnterEdit,
  type MarkdownEdit,
} from "../lib/markdownEditing";
import { parseMarkdownBlocks } from "../lib/markdownBlocks";
import { renderObsidianMarkdownToHtml } from "../lib/markdown";
import {
  findObsidianCalloutBlocks,
  findObsidianInlineTokens,
  getObsidianCalloutFamily,
} from "../lib/obsidianMarkdown";

type EditorMode = "live" | "source" | "reading";

const externalSync = Annotation.define<boolean>();

function applyMarkdownEdit(view: EditorView, edit: MarkdownEdit) {
  view.dispatch({
    changes: { from: edit.from, insert: edit.insert, to: edit.to },
    scrollIntoView: true,
    selection: EditorSelection.cursor(edit.selection),
  });
}

function markdownEnter(view: EditorView) {
  const selection = view.state.selection.main;
  if (!selection.empty) return false;
  const edit = getMarkdownEnterEdit(view.state.doc.toString(), selection.head);
  if (!edit) return false;
  applyMarkdownEdit(view, edit);
  return true;
}

function markdownBackspace(view: EditorView) {
  const selection = view.state.selection.main;
  if (!selection.empty) return false;
  const edit = getMarkdownBackspaceEdit(view.state.doc.toString(), selection.head);
  if (!edit) return false;
  applyMarkdownEdit(view, edit);
  return true;
}

function insertHardBreak(view: EditorView) {
  const selection = view.state.selection.main;
  const before = view.state.doc.sliceString(Math.max(0, selection.from - 2), selection.from);
  const insert = before.endsWith("  ") || before.endsWith("\\") ? "\n" : "  \n";
  view.dispatch(view.state.replaceSelection(insert), { scrollIntoView: true });
  return true;
}

function markdownIndent(view: EditorView) {
  return indentMore({ state: view.state, dispatch: view.dispatch });
}

function markdownOutdent(view: EditorView) {
  return indentLess({ state: view.state, dispatch: view.dispatch });
}

class RenderedMarkdownBlockWidget extends WidgetType {
  constructor(
    readonly from: number,
    readonly source: string,
  ) {
    super();
  }

  eq(other: RenderedMarkdownBlockWidget) {
    return this.from === other.from && this.source === other.source;
  }

  toDOM(view: EditorView) {
    const block = document.createElement("div");
    block.className = "cm-live-rendered-block message-content is-markdown obsidian-note-markdown";
    block.innerHTML = renderObsidianMarkdownToHtml(this.source);
    block.addEventListener("click", (event) => {
      event.preventDefault();
      const caretDocument = document as Document & {
        caretPositionFromPoint?: (x: number, y: number) => {
          offset: number;
          offsetNode: Node;
        } | null;
        caretRangeFromPoint?: (x: number, y: number) => {
          startContainer: Node;
          startOffset: number;
        } | null;
      };
      const caretPosition = caretDocument.caretPositionFromPoint?.(
        event.clientX,
        event.clientY,
      );
      const caretRange = caretPosition
        ? null
        : caretDocument.caretRangeFromPoint?.(event.clientX, event.clientY);
      const offsetNode = caretPosition?.offsetNode ?? caretRange?.startContainer;
      const nodeOffset = caretPosition?.offset ?? caretRange?.startOffset ?? 0;
      const clickedText = offsetNode?.nodeType === Node.TEXT_NODE
        ? offsetNode.textContent ?? ""
        : "";
      const sourceTextOffset = clickedText ? this.source.indexOf(clickedText) : -1;
      const sourceOffset = sourceTextOffset === -1
        ? this.source.length
        : sourceTextOffset + Math.min(nodeOffset, clickedText.length);

      view.dispatch({
        selection: EditorSelection.cursor(this.from + sourceOffset),
        scrollIntoView: true,
      });
      view.focus();
    });
    return block;
  }

  ignoreEvent() {
    return true;
  }
}

function isSelectionInside(view: EditorView, from: number, to: number) {
  return view.state.selection.ranges.some((range) =>
    range.empty
      ? range.head >= from && range.head <= to
      : range.from < to && range.to > from,
  );
}

function buildLivePreview(view: EditorView) {
  const decorations: Range<Decoration>[] = [];
  const replacements: Range<Decoration>[] = [];
  const lineKeys = new Set<string>();
  const document = view.state.doc;
  const source = document.toString();
  const blocks = parseMarkdownBlocks(source);
  const activeBlocks = blocks.filter((block) =>
    block.kind === "blank" || isSelectionInside(view, block.start, block.end),
  );
  const inlineTokens = findObsidianInlineTokens(source);
  const calloutBlocks = findObsidianCalloutBlocks(source);

  function addLine(position: number, className: string) {
    const line = document.lineAt(Math.max(0, Math.min(position, document.length)));
    const key = `${line.from}:${className}`;
    if (lineKeys.has(key)) return;
    lineKeys.add(key);
    decorations.push(Decoration.line({ class: className }).range(line.from));
  }

  function overlapsActiveBlock(from: number, to: number) {
    return activeBlocks.some((block) => from <= block.end && to >= block.start);
  }

  function isInsideActiveBlock(from: number, to: number) {
    return activeBlocks.some((block) => from >= block.start && to <= block.end);
  }

  for (const block of blocks) {
    if (
      block.kind === "blank" ||
      block.start === block.end ||
      isSelectionInside(view, block.start, block.end)
    ) {
      continue;
    }

    const replacement = Decoration.replace({
      block: true,
      widget: new RenderedMarkdownBlockWidget(block.start, block.value),
    }).range(block.start, block.end);
    decorations.push(replacement);
    replacements.push(replacement);
  }

  for (const callout of calloutBlocks) {
    if (!isInsideActiveBlock(callout.from, callout.to)) continue;
    const family = getObsidianCalloutFamily(callout.type);
    for (const lineFrom of callout.lineFroms) {
      addLine(lineFrom, `cm-live-callout cm-live-callout-${family}`);
    }
    addLine(callout.headerLineFrom, "cm-live-callout-title");
    if (callout.fold) addLine(callout.headerLineFrom, `cm-live-callout-fold-${callout.fold === "+" ? "open" : "closed"}`);
  }

  for (const token of inlineTokens) {
    if (!isInsideActiveBlock(token.from, token.to)) continue;
    if (token.kind === "comment") {
      decorations.push(
        Decoration.mark({ class: "cm-live-comment" }).range(token.from, token.to),
      );
      continue;
    }

    if (token.kind === "highlight") {
      if (token.contentFrom < token.contentTo) {
        decorations.push(
          Decoration.mark({ class: "cm-live-highlight" }).range(
            token.contentFrom,
            token.contentTo,
          ),
        );
      }
      continue;
    }

    const labelFrom = token.labelFrom ?? token.contentFrom;
    const labelTo = token.labelTo ?? token.contentTo;
    if (labelFrom < labelTo) {
      decorations.push(
        Decoration.mark({
          class: token.kind === "embed" ? "cm-live-embed" : "cm-live-wikilink",
        }).range(labelFrom, labelTo),
      );
    }
  }

  for (const visible of view.visibleRanges) {
    syntaxTree(view.state).iterate({
      enter(nodeRef) {
        const { from, name, to } = nodeRef;
        if (to < visible.from || from > visible.to) return;
        if (!overlapsActiveBlock(from, to)) return false;
        const editable = isInsideActiveBlock(from, to);

        const heading = name.match(/^ATXHeading([1-6])$/);
        if (heading && editable) addLine(from, `cm-live-heading cm-live-heading-${heading[1]}`);
        const setextHeading = name.match(/^SetextHeading([12])$/);
        if (setextHeading && editable) addLine(from, `cm-live-heading cm-live-heading-${setextHeading[1]}`);
        if (name === "HorizontalRule" && editable) addLine(from, "cm-live-horizontal-rule-line");
        if (name === "Blockquote" && editable) {
          for (let line = document.lineAt(from); line.from <= to && line.from <= visible.to;) {
            addLine(line.from, "cm-live-blockquote");
            if (line.to >= document.length || line.to >= to) break;
            line = document.line(line.number + 1);
          }
        }
        if (editable && (name === "BulletList" || name === "OrderedList")) addLine(from, "cm-live-list");
        if (editable && (name === "TableHeader" || name === "TableRow")) addLine(from, "cm-live-table-row");
        if (name === "FencedCode" && editable) {
          const firstLine = document.lineAt(from);
          const lastLine = document.lineAt(Math.max(from, to - 1));
          for (let line = document.lineAt(from); line.from <= to && line.from <= visible.to;) {
            const edgeClass = line.from === firstLine.from
              ? " cm-live-code-start"
              : line.from === lastLine.from
                ? " cm-live-code-end"
                : "";
            addLine(line.from, `cm-live-code-line${edgeClass}`);
            if (line.to >= document.length || line.to >= to) break;
            line = document.line(line.number + 1);
          }
        }

        if (!editable) return;
        if (name === "StrongEmphasis") {
          decorations.push(Decoration.mark({ class: "cm-live-strong" }).range(from, to));
        } else if (name === "Emphasis") {
          decorations.push(Decoration.mark({ class: "cm-live-emphasis" }).range(from, to));
        } else if (name === "Strikethrough") {
          decorations.push(Decoration.mark({ class: "cm-live-strikethrough" }).range(from, to));
        } else if (name === "InlineCode") {
          decorations.push(Decoration.mark({ class: "cm-live-inline-code" }).range(from, to));
        } else if (name === "Link") {
          decorations.push(Decoration.mark({ class: "cm-live-link" }).range(from, to));
        } else if (name === "Image") {
          decorations.push(Decoration.mark({ class: "cm-live-image" }).range(from, to));
        } else if (name === "URL") {
          decorations.push(Decoration.mark({ class: "cm-live-link" }).range(from, to));
        }
      },
      from: visible.from,
      to: visible.to,
    });
  }

  return {
    decorations: Decoration.set(decorations, true),
    replacements: Decoration.set(replacements, true),
  };
}

class LivePreviewView {
  decorations: DecorationSet;
  replacements: DecorationSet;

  constructor(view: EditorView) {
    const preview = buildLivePreview(view);
    this.decorations = preview.decorations;
    this.replacements = preview.replacements;
  }

  update(update: ViewUpdate) {
    if (update.docChanged || update.selectionSet || update.viewportChanged) {
      const preview = buildLivePreview(update.view);
      this.decorations = preview.decorations;
      this.replacements = preview.replacements;
    }
  }
}

const livePreviewPlugin = ViewPlugin.fromClass(LivePreviewView, {
  decorations: (plugin) => plugin.decorations,
});

const livePreviewExtension: Extension = [
  livePreviewPlugin,
  EditorView.atomicRanges.of((view) => view.plugin(livePreviewPlugin)?.replacements ?? Decoration.none),
];

function modeLabel(mode: EditorMode) {
  if (mode === "live") return "Live Preview";
  if (mode === "source") return "Source";
  return "Reading";
}

export default function MarkdownNoteEditor({
  ariaLabel,
  autoFocus = false,
  className = "",
  onBlur,
  onChange,
  placeholder = "Write with Markdown…",
  readingSelectionContext,
  value,
}: {
  ariaLabel: string;
  autoFocus?: boolean;
  className?: string;
  onBlur?: () => void;
  onChange: (value: string) => void;
  placeholder?: string;
  readingSelectionContext?: {
    conversationId: string;
    messageId: string;
    noteId: string;
  };
  value: string;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onBlurRef = useRef(onBlur);
  const onChangeRef = useRef(onChange);
  const previewCompartmentRef = useRef(new Compartment());
  const focusAfterModeChangeRef = useRef(false);
  const [mode, setMode] = useState<EditorMode>("live");

  onBlurRef.current = onBlur;
  onChangeRef.current = onChange;

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;

    const previewCompartment = previewCompartmentRef.current;
    const state = EditorState.create({
      doc: value,
      extensions: [
        history(),
        drawSelection(),
        dropCursor(),
        indentOnInput(),
        bracketMatching(),
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        markdown({ extensions: [GFM] }),
        EditorView.lineWrapping,
        EditorView.contentAttributes.of({
          "aria-label": ariaLabel,
          "aria-multiline": "true",
          spellcheck: "true",
        }),
        editorPlaceholder(placeholder),
        previewCompartment.of(livePreviewExtension),
        keymap.of([
          { key: "Enter", run: markdownEnter },
          { key: "Shift-Enter", run: insertHardBreak },
          { key: "Backspace", run: markdownBackspace },
          { key: "Tab", run: markdownIndent },
          { key: "Shift-Tab", run: markdownOutdent },
          {
            key: "Escape",
            run(view) {
              view.contentDOM.blur();
              return true;
            },
            stopPropagation: true,
          },
          ...defaultKeymap,
          ...historyKeymap,
        ]),
        EditorView.updateListener.of((update) => {
          if (!update.docChanged || update.transactions.some((transaction) => transaction.annotation(externalSync))) {
            return;
          }
          onChangeRef.current(update.state.doc.toString());
        }),
      ],
    });

    const view = new EditorView({ parent: host, state });
    viewRef.current = view;

    return () => {
      viewRef.current = null;
      view.destroy();
    };
    // The editor is intentionally created once; prop changes are synchronized below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const view = viewRef.current;
    if (!view || view.state.doc.toString() === value) return;
    view.dispatch({
      annotations: externalSync.of(true),
      changes: { from: 0, insert: value, to: view.state.doc.length },
    });
  }, [value]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.contentDOM.setAttribute("aria-label", ariaLabel);
  }, [ariaLabel]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: previewCompartmentRef.current.reconfigure(mode === "live" ? livePreviewExtension : []),
    });

    // Reconfiguration also runs during initialization (twice in development
    // Strict Mode). Only an explicit mode-button click is allowed to focus or
    // blur the editor here.
    if (!focusAfterModeChangeRef.current) return;
    focusAfterModeChangeRef.current = false;
    if (mode === "reading") view.contentDOM.blur();
    else requestAnimationFrame(() => view.focus());
  }, [mode]);

  useEffect(() => {
    if (!autoFocus) return;
    const frame = requestAnimationFrame(() => viewRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [autoFocus]);

  function handleBlur(event: FocusEvent<HTMLDivElement>) {
    if (event.relatedTarget instanceof Node && rootRef.current?.contains(event.relatedTarget)) return;
    onBlurRef.current?.();
  }

  return (
    <div
      aria-label={ariaLabel}
      className={`live-markdown-editor ${className}`.trim()}
      data-empty={value ? undefined : "true"}
      data-mode={mode}
      data-placeholder={placeholder}
      onBlur={handleBlur}
      ref={rootRef}
      role="group"
    >
      <div aria-label="Markdown view" className="live-markdown-mode-switcher" role="toolbar">
        {(["live", "source", "reading"] as const).map((candidate) => (
          <button
            aria-label={`Use ${modeLabel(candidate)}`}
            aria-pressed={mode === candidate}
            className={mode === candidate ? "is-active" : ""}
            key={candidate}
            onClick={() => {
              focusAfterModeChangeRef.current = true;
              setMode(candidate);
            }}
            onMouseDown={(event) => event.preventDefault()}
            title={modeLabel(candidate)}
            type="button"
          >
            {candidate === "live" ? "Live" : candidate === "source" ? "Source" : "Read"}
          </button>
        ))}
      </div>
      <div
        className="live-markdown-editor-host"
        hidden={mode === "reading"}
        ref={hostRef}
      />
      {mode === "reading" ? (
        value ? (
          <div
            className="live-markdown-reading message-content is-markdown obsidian-note-markdown"
            data-conversation-id={readingSelectionContext?.conversationId}
            data-message-id={readingSelectionContext?.messageId}
            data-note-id={readingSelectionContext?.noteId}
            data-selection-source={
              readingSelectionContext ? "standalone-note" : undefined
            }
            dangerouslySetInnerHTML={{ __html: renderObsidianMarkdownToHtml(value) }}
          />
        ) : (
          <p className="live-markdown-reading-placeholder">{placeholder}</p>
        )
      ) : null}
    </div>
  );
}
