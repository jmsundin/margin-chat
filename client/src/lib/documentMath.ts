import { InputRule, type NodeViewRenderer } from "@tiptap/core";
import { BlockMath, InlineMath } from "@tiptap/extension-mathematics";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { findLatexStart, readLatexAtStart, renderLatexToHtml } from "./latex";

export type EditEquation = (node: ProseMirrorNode, position: number) => void;

function mathNodeView(display: boolean, onEdit?: EditEquation): NodeViewRenderer {
  return ({ node: initial, editor, getPos }) => {
    let node = initial;
    const dom = document.createElement(display ? "div" : "span");
    dom.className = "tiptap-mathematics-render";
    dom.dataset.type = display ? "block-math" : "inline-math";
    dom.contentEditable = "false";
    function render() {
      dom.dataset.latex = node.attrs.latex;
      dom.innerHTML = renderLatexToHtml(node.attrs.latex, display);
      dom.tabIndex = editor.isEditable ? 0 : -1;
      dom.setAttribute("role", editor.isEditable ? "button" : "math");
      dom.setAttribute("aria-label", `${display ? "Display" : "Inline"} equation: ${node.attrs.latex}${editor.isEditable ? ". Edit equation" : ""}`);
      dom.title = editor.isEditable ? "Edit equation" : node.attrs.latex;
    }
    function activate(event: Event) {
      if (!editor.isEditable || !onEdit) return;
      const position = getPos();
      if (position === undefined) return;
      event.preventDefault();
      event.stopPropagation();
      editor.commands.setNodeSelection(position);
      onEdit(node, position);
    }
    const keydown = (event: Event) => { const key = (event as KeyboardEvent).key; if (key === "Enter" || key === " ") activate(event); };
    dom.addEventListener("click", activate);
    dom.addEventListener("keydown", keydown);
    render();
    return {
      dom,
      update(next) {
        if (next.type !== node.type) return false;
        const changed = next.attrs.latex !== node.attrs.latex;
        node = next;
        if (changed) render();
        return true;
      },
      selectNode() { dom.classList.add("ProseMirror-selectednode"); },
      deselectNode() { dom.classList.remove("ProseMirror-selectednode"); },
      stopEvent(event) { return event.type === "click" || event.type === "keydown"; },
      ignoreMutation() { return true; },
      destroy() { dom.removeEventListener("click", activate); dom.removeEventListener("keydown", keydown); },
    };
  };
}

function tokenizer(display: boolean) {
  return {
    name: display ? "blockMath" : "inlineMath",
    level: display ? "block" as const : "inline" as const,
    start: (source: string) => findLatexStart(source, display),
    tokenize(source: string) {
      const match = readLatexAtStart(source, display);
      return match ? { type: display ? "blockMath" : "inlineMath", raw: match.raw, latex: match.latex.trim() } : undefined;
    },
  };
}

function mathInputRule(type: ProseMirrorNode["type"], display: boolean) {
  return new InputRule({
    find(text) {
      for (let offset = 0; offset < text.length;) {
        const start = findLatexStart(text.slice(offset), display);
        if (start < 0) return null;
        const index = offset + start;
        // While typing $$...$$, the first closing dollar must not make an
        // inline equation starting at the second opening dollar.
        if (!display && text[index] === "$" && text[index - 1] === "$") { offset = index + 1; continue; }
        const match = readLatexAtStart(text.slice(index), display);
        if (match && index + match.raw.length === text.length && (!display || index === 0)) {
          return { index, text: match.raw, data: match };
        }
        offset = index + 1;
      }
      return null;
    },
    handler({ state, range, match }) {
      const token = readLatexAtStart(match[0], display);
      if (!token) return;
      const $from = state.doc.resolve(range.from);
      const wholeParagraph = display && $from.parent.isTextblock && range.from === $from.start() && range.to === $from.end()
        && $from.node(-1).canReplaceWith($from.index(-1), $from.indexAfter(-1), type);
      state.tr.replaceWith(wholeParagraph ? $from.before() : range.from, wholeParagraph ? $from.after() : range.to, type.create({ latex: token.latex.trim() }));
    },
  });
}

export function createDocumentMathExtensions(onEdit?: EditEquation) {
  return [
    BlockMath.extend({
      markdownTokenizer: tokenizer(true),
      addInputRules() { return [mathInputRule(this.type, true)]; },
      addNodeView() { return mathNodeView(true, onEdit); },
    }),
    InlineMath.extend({
      markdownTokenizer: tokenizer(false),
      addInputRules() { return [mathInputRule(this.type, false)]; },
      addNodeView() { return mathNodeView(false, onEdit); },
    }),
  ];
}
