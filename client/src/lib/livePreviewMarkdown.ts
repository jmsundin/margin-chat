import { type EditorState, type Range } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, WidgetType, logException, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";
import type { SyntaxNode } from "@lezer/common";
import { findObsidianInlineTokens } from "./obsidianMarkdown";
import { findLatexStart, readInlineLatexAtStart, renderLatexToHtml } from "./latex";

/**
 * Obsidian's Live Preview for CodeMirror: Markdown is styled in place, and its
 * syntax marks (`**`, `#`, `[[`, `==`, list markers) show only on the lines the
 * cursor is on. Every other line reads as rendered text.
 */

export type LivePreviewMode = "live" | "source" | "reading";

class BulletWidget extends WidgetType {
  eq() { return true; }
  toDOM() {
    const bullet = document.createElement("span");
    bullet.className = "cm-lp-bullet";
    bullet.textContent = "•";
    bullet.setAttribute("aria-hidden", "true");
    return bullet;
  }
  ignoreEvent() { return false; }
}

class CheckboxWidget extends WidgetType {
  constructor(readonly checked: boolean, readonly at: number) { super(); }
  eq(other: CheckboxWidget) { return other.checked === this.checked && other.at === this.at; }
  toDOM(view: EditorView) {
    const box = document.createElement("input");
    box.type = "checkbox";
    box.className = "cm-lp-task";
    box.checked = this.checked;
    box.setAttribute("aria-label", this.checked ? "Mark task not done" : "Mark task done");
    box.addEventListener("mousedown", (event) => event.preventDefault());
    box.addEventListener("click", (event) => {
      event.preventDefault();
      if (view.state.readOnly) return;
      // The marker is "[ ]" or "[x]"; its middle character holds the state.
      const current = view.state.sliceDoc(this.at + 1, this.at + 2);
      view.dispatch({ changes: { from: this.at + 1, to: this.at + 2, insert: current === " " ? "x" : " " }, userEvent: "input.toggle" });
    });
    return box;
  }
  ignoreEvent() { return true; }
}

class RuleWidget extends WidgetType {
  eq() { return true; }
  toDOM() {
    const rule = document.createElement("span");
    rule.className = "cm-lp-hr";
    rule.setAttribute("aria-hidden", "true");
    return rule;
  }
  ignoreEvent() { return false; }
}

class MathWidget extends WidgetType {
  constructor(readonly latex: string, readonly display: boolean, readonly source: string) { super(); }
  eq(other: MathWidget) { return other.latex === this.latex && other.display === this.display; }
  toDOM() {
    const math = document.createElement("span");
    math.className = `cm-lp-math${this.display ? " is-display" : ""}`;
    math.innerHTML = renderLatexToHtml(this.latex, this.display, this.source);
    return math;
  }
  ignoreEvent() { return false; }
}

const hide = Decoration.replace({});
const mark = (className: string, attributes?: Record<string, string>) => Decoration.mark({ class: className, attributes });
const syntaxMark = mark("cm-lp-mark");
const bullet = Decoration.replace({ widget: new BulletWidget() });
const rule = Decoration.replace({ widget: new RuleWidget() });

/** The lines (by start) a selection touches; their syntax shows. */
function activeLineStarts(state: EditorState) {
  const starts = new Set<number>();
  for (const range of state.selection.ranges) {
    for (let line = state.doc.lineAt(range.from); ; line = state.doc.line(line.number + 1)) {
      starts.add(line.from);
      if (line.to >= range.to || line.number >= state.doc.lines) break;
    }
  }
  return starts;
}

const CODE_NODES = new Set(["InlineCode", "FencedCode", "CodeBlock", "CodeText", "HTMLBlock", "CommentBlock"]);

function buildDecorations(view: EditorView, mode: LivePreviewMode): DecorationSet {
  const { state } = view;
  const { doc } = state;
  const active = mode === "live" && view.hasFocus ? activeLineStarts(state) : new Set<number>();
  const reveal = (position: number) => mode === "source" || active.has(doc.lineAt(position).from);
  const ranges: Range<Decoration>[] = [];
  const lineClasses = new Map<number, Set<string>>();
  const addLine = (position: number, className: string) => {
    const from = doc.lineAt(position).from;
    const classes = lineClasses.get(from) ?? new Set<string>();
    classes.add(className);
    lineClasses.set(from, classes);
  };
  const eachLine = (from: number, to: number, run: (line: { from: number; to: number; number: number }) => void) => {
    for (let line = doc.lineAt(from); ; line = doc.line(line.number + 1)) {
      run(line);
      if (line.to >= to || line.number >= doc.lines) break;
    }
  };
  /** Hide a syntax mark on an inactive line, or dim it on the line being edited. */
  const syntax = (from: number, to: number) => {
    if (to <= from) return;
    if (mode === "source" || reveal(from)) ranges.push(syntaxMark.range(from, to));
    else ranges.push(hide.range(from, to));
  };
  const tree = syntaxTree(state);
  const inCode = (position: number) => {
    for (let node: SyntaxNode | null = tree.resolveInner(position, 1); node; node = node.parent) {
      if (CODE_NODES.has(node.name)) return true;
    }
    return false;
  };

  for (const { from, to } of view.visibleRanges) {
    tree.iterate({
      from, to,
      enter(node) {
        const name = node.name;
        const heading = /^ATXHeading([1-6])$/.exec(name) ?? /^SetextHeading([12])$/.exec(name);
        if (heading) {
          eachLine(node.from, node.to, (line) => addLine(line.from, `cm-lp-heading cm-lp-h${heading[1]}`));
          return;
        }
        switch (name) {
          case "HeaderMark": {
            const parent = node.node.parent?.name ?? "";
            if (parent.startsWith("SetextHeading")) { syntax(node.from, node.to); return; }
            // "# " hides with its space; a closing "##" hides with the space before it.
            const after = doc.sliceString(node.to, node.to + 1) === " " ? 1 : 0;
            const before = node.from > 0 && doc.sliceString(node.from - 1, node.from) === " " && doc.lineAt(node.from).from !== node.from ? 1 : 0;
            if (doc.lineAt(node.from).from === node.from) syntax(node.from, node.to + after);
            else syntax(node.from - before, node.to);
            return;
          }
          case "Emphasis": ranges.push(mark("cm-lp-em").range(node.from, node.to)); return;
          case "StrongEmphasis": ranges.push(mark("cm-lp-strong").range(node.from, node.to)); return;
          case "Strikethrough": ranges.push(mark("cm-lp-strike").range(node.from, node.to)); return;
          case "EmphasisMark": case "StrikethroughMark": syntax(node.from, node.to); return;
          case "InlineCode": {
            ranges.push(mark("cm-lp-code").range(node.from, node.to));
            const cursor = node.node.cursor();
            if (cursor.firstChild()) do if (cursor.name === "CodeMark") syntax(cursor.from, cursor.to); while (cursor.nextSibling());
            return false;
          }
          case "Escape": syntax(node.from, node.from + 1); return false;
          case "Link": {
            const marks: Array<{ from: number; to: number }> = [];
            let url = "";
            const cursor = node.node.cursor();
            if (cursor.firstChild()) do {
              if (cursor.name === "LinkMark") marks.push({ from: cursor.from, to: cursor.to });
              else if (cursor.name === "URL") url = doc.sliceString(cursor.from, cursor.to);
            } while (cursor.nextSibling());
            // [label](url): the label reads as a link; the brackets and address hide.
            if (marks.length >= 3 && url) {
              const labelFrom = marks[0].to, labelTo = marks[1].from;
              if (labelTo > labelFrom) ranges.push(mark("cm-lp-link", { "data-href": url, title: url }).range(labelFrom, labelTo));
              syntax(marks[0].from, marks[0].to);
              syntax(marks[1].from, node.to);
            } else ranges.push(mark("cm-lp-link").range(node.from, node.to));
            return;
          }
          case "URL": {
            if (node.node.parent?.name === "Link" || node.node.parent?.name === "Image") return;
            const url = doc.sliceString(node.from, node.to);
            ranges.push(mark("cm-lp-link", { "data-href": url }).range(node.from, node.to));
            return;
          }
          case "Autolink": ranges.push(mark("cm-lp-link").range(node.from, node.to)); return false;
          case "Image": ranges.push(mark("cm-lp-image").range(node.from, node.to)); return false;
          case "ListItem": addLine(node.from, "cm-lp-list"); return;
          case "ListMark": {
            const item = node.node.parent;
            const task = item?.getChild("Task");
            const space = doc.sliceString(node.to, node.to + 1) === " " ? 1 : 0;
            if (task) {
              const marker = task.getChild("TaskMarker");
              if (marker && !reveal(node.from)) {
                ranges.push(hide.range(node.from, node.to + space));
                const checked = /\[[xX]\]/.test(doc.sliceString(marker.from, marker.to));
                ranges.push(Decoration.replace({ widget: new CheckboxWidget(checked, marker.from) }).range(marker.from, marker.to));
                if (checked) addLine(node.from, "cm-lp-task-done");
              } else ranges.push(syntaxMark.range(node.from, node.to));
              return;
            }
            const ordered = item?.parent?.name === "OrderedList";
            if (ordered || reveal(node.from)) ranges.push(mark(ordered ? "cm-lp-ordered" : "cm-lp-mark").range(node.from, node.to));
            else ranges.push(bullet.range(node.from, node.to));
            return;
          }
          case "Blockquote":
            eachLine(node.from, node.to, (line) => addLine(line.from, "cm-lp-quote"));
            return;
          case "QuoteMark": {
            const space = doc.sliceString(node.to, node.to + 1) === " " ? 1 : 0;
            syntax(node.from, node.to + space);
            return;
          }
          case "FencedCode": {
            let editing = mode === "source";
            eachLine(node.from, node.to, (line) => { if (reveal(line.from)) editing = true; });
            const first = doc.lineAt(node.from), last = doc.lineAt(node.to);
            eachLine(node.from, node.to, (line) => {
              const fence = line.from === first.from || line.from === last.from && last.number !== first.number;
              addLine(line.from, fence ? "cm-lp-code-fence" : "cm-lp-code-line");
              if (fence && !editing && line.to > line.from) ranges.push(hide.range(line.from, line.to));
              else if (fence && line.to > line.from) ranges.push(syntaxMark.range(line.from, line.to));
            });
            return false;
          }
          case "CodeBlock": eachLine(node.from, node.to, (line) => addLine(line.from, "cm-lp-code-line")); return false;
          case "HorizontalRule":
            addLine(node.from, "cm-lp-hr-line");
            if (reveal(node.from)) ranges.push(syntaxMark.range(node.from, node.to));
            else ranges.push(rule.range(node.from, node.to));
            return;
          case "Table":
            eachLine(node.from, node.to, (line) => addLine(line.from, "cm-lp-table"));
            return false;
          case "HTMLBlock": case "CommentBlock":
            eachLine(node.from, node.to, (line) => addLine(line.from, "cm-lp-html"));
            return false;
          case "HTMLTag": case "Comment": ranges.push(mark("cm-lp-html").range(node.from, node.to)); return;
        }
      },
    });

    // Obsidian syntax CommonMark doesn't know: [[links]], ![[embeds]], ==highlights==, %%comments%%.
    const text = doc.sliceString(from, to);
    for (const token of findObsidianInlineTokens(text)) {
      const start = from + token.from, end = from + token.to;
      if (inCode(start)) continue;
      if (token.kind === "comment") { ranges.push(mark("cm-lp-comment").range(start, end)); continue; }
      const contentFrom = from + token.contentFrom, contentTo = from + token.contentTo;
      if (token.kind === "highlight") {
        if (contentTo > contentFrom) ranges.push(mark("cm-lp-highlight").range(contentFrom, contentTo));
        syntax(start, contentFrom);
        syntax(contentTo, end);
        continue;
      }
      const labelFrom = from + (token.labelFrom ?? token.contentFrom), labelTo = from + (token.labelTo ?? token.contentTo);
      if (labelTo > labelFrom) ranges.push(mark(token.kind === "embed" ? "obsidian-embed cm-lp-embed" : "obsidian-wikilink cm-lp-wikilink", token.target ? { "data-note-target": token.target } : undefined).range(labelFrom, labelTo));
      syntax(start, labelFrom);
      syntax(labelTo, end);
    }

    // Inline $math$ renders as an equation until the cursor reaches its line.
    for (let offset = 0; offset < text.length;) {
      const index = findLatexStart(text.slice(offset));
      if (index < 0) break;
      const start = offset + index;
      const math = readInlineLatexAtStart(text.slice(start));
      if (!math) { offset = start + 1; continue; }
      const position = from + start;
      if (!inCode(position)) {
        // A plugin can't replace across lines, so $$ math written over several lines shows as source.
        if (reveal(position) || math.raw.includes("\n")) ranges.push(mark("cm-lp-math-source").range(position, position + math.raw.length));
        else ranges.push(Decoration.replace({ widget: new MathWidget(math.latex, math.displayMode, math.raw) }).range(position, position + math.raw.length));
      }
      offset = start + math.raw.length;
    }
  }
  for (const [from, classes] of lineClasses) ranges.push(Decoration.line({ class: [...classes].join(" ") }).range(from));
  return Decoration.set(ranges.filter((range) => drawable(doc, range)), true);
}

/** CodeMirror refuses a plugin's replacement that crosses a line break, and would stop drawing the editor. */
function drawable(doc: EditorState["doc"], range: Range<Decoration>) {
  return !range.value.point || range.to <= doc.lineAt(range.from).to;
}

/**
 * A plugin that throws is switched off for good, which left a whole document
 * as raw Markdown after one bad range (an empty mark from a code fence an AI
 * answer hadn't closed yet). Plain text now, styling again on the next update.
 */
function safeDecorations(view: EditorView, mode: LivePreviewMode): DecorationSet {
  try {
    return buildDecorations(view, mode);
  } catch (error) {
    logException(view.state, error, "Live Preview styling");
    return Decoration.none;
  }
}

/** Live Preview styling for the visible lines. `mode` reads the current mode from the editor state. */
export function livePreviewInline(mode: (state: EditorState) => LivePreviewMode) {
  return ViewPlugin.fromClass(class {
    decorations: DecorationSet;
    constructor(view: EditorView) { this.decorations = safeDecorations(view, mode(view.state)); }
    update(update: ViewUpdate) {
      if (update.docChanged || update.selectionSet || update.viewportChanged || update.focusChanged
        || syntaxTree(update.state) !== syntaxTree(update.startState) || mode(update.state) !== mode(update.startState)) {
        this.decorations = safeDecorations(update.view, mode(update.state));
      }
    }
  }, {
    decorations: (plugin) => plugin.decorations,
    eventHandlers: {
      mousedown(event) {
        // Cmd or Ctrl and click opens a link, as in Obsidian; a plain click edits it.
        if (!(event.metaKey || event.ctrlKey) || !(event.target instanceof Element)) return false;
        const href = event.target.closest<HTMLElement>("[data-href]")?.dataset.href;
        if (!href || !/^(https?:|mailto:)/i.test(href)) return false;
        event.preventDefault();
        window.open(href, "_blank", "noopener,noreferrer");
        return true;
      },
    },
  });
}
