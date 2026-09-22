import { useEffect, useRef } from "react";
import { EditorView } from "@codemirror/view";
import type { Conversation } from "../types";
import type { SearchEvidenceRef } from "../lib/conversationSearch";
import { createSearchPassageRange, resolveSearchSource } from "../lib/searchSource";
import "./SearchSourceFocus.css";

export default function SearchSourceFocus({ request, conversations, getPanelElement }: {
  request: { source: SearchEvidenceRef; sequence: number } | null;
  conversations: Record<string, Conversation>;
  getPanelElement: (conversationId: string) => HTMLElement | null;
}) {
  const latest = useRef({ conversations, getPanelElement });
  latest.current = { conversations, getPanelElement };
  useEffect(() => {
    if (!request) return;
    const { source } = request;
    let frame = 0;
    let attempts = 0;
    let target: HTMLElement | null = null;
    let passageTarget: HTMLElement | null = null;
    let timeout = 0;
    const highlightKey = "margin-search-source";
    const removeHighlight = () => {
      target?.classList.remove("is-search-source");
      passageTarget?.classList.remove("is-search-passage");
      if (typeof CSS !== "undefined" && "highlights" in CSS) CSS.highlights.delete(highlightKey);
    };
    const reveal = () => {
      const { conversations: current, getPanelElement: getPanel } = latest.current;
      const resolution = resolveSearchSource(current, source);
      if (resolution.status === "missing") return;
      const resolvedSource = "evidence" in resolution ? resolution.evidence : source;
      const panel = getPanel(source.conversationId);
      let acrossBlocks = false;
      if (source.sourceKind === "annotation") {
        target = Array.from(document.querySelectorAll<HTMLElement>("[data-margin-note-tree-node]")).find((element) => element.dataset.marginNoteTreeNode === source.noteId) ??
          (panel ? Array.from(panel.querySelectorAll<HTMLElement>(".side-note-panel[data-side-note-id]")).find((element) => element.dataset.sideNoteId === source.noteId) : null) ?? null;
      } else if (resolvedSource.sourceKind === "document") {
        target = panel ? Array.from(panel.querySelectorAll<HTMLElement>("[data-document-block-id]")).find((element) => element.dataset.documentBlockId === resolvedSource.sourceBlockId) ?? null : null;
        // The legacy renderer remains available to isolated readers and tests.
        if (!target && source.sourceKind === "message") target = panel ? Array.from(panel.querySelectorAll<HTMLElement>("[data-message-row-id]")).find((element) => element.dataset.messageRowId === source.messageId) ?? null : null;
        if (!target && source.sourceKind === "standalone-note") target = panel?.querySelector<HTMLElement>(".panel-body") ?? null;
      } else if (source.sourceKind === "message") {
        const matches = panel ? Array.from(panel.querySelectorAll<HTMLElement>("[data-message-row-id], [data-document-block-id][data-message-id]")).filter((element) => (element.dataset.messageRowId ?? element.dataset.messageId) === source.messageId) : [];
        // Older search references may span several paragraph blocks. A quote
        // that fits one block is already remapped above; otherwise search the
        // reader's rendered text so later paragraphs remain reachable.
        acrossBlocks = matches.length > 1;
        target = acrossBlocks ? panel?.querySelector<HTMLElement>(".panel-body") ?? null : matches[0] ?? null;
      } else target = panel?.querySelector<HTMLElement>(".panel-body") ?? null;
      if (!target) {
        if (++attempts < 12) frame = window.requestAnimationFrame(reveal);
        return;
      }
      target.classList.add("is-search-source");
      const editorElement = target.querySelector<HTMLElement>(".cm-editor");
      const editor = editorElement ? EditorView.findFromDOM(editorElement) : null;
      if (editor && editor.state.doc.toString() === resolution.content) {
        if (resolution.highlight) editor.dispatch({
          selection: { anchor: resolution.highlight.startOffset, head: resolution.highlight.endOffset },
          effects: EditorView.scrollIntoView(resolution.highlight.startOffset, { y: "center" }),
        });
        target.scrollIntoView({ block: "nearest", inline: "nearest" });
        editor.focus();
      } else {
        const content = acrossBlocks ? target : target.querySelector<HTMLElement>(".tiptap, .message-content, .markdown-note-reading") ?? target;
        const range = resolution.highlight && source.quote ? createSearchPassageRange(content, source.quote) : null;
        if (range && typeof Highlight !== "undefined" && typeof CSS !== "undefined" && "highlights" in CSS) CSS.highlights.set(highlightKey, new Highlight(range));
        if (range) {
          const first = range.startContainer.parentElement;
          passageTarget = first?.closest<HTMLElement>("p,li,pre,h1,h2,h3,h4,h5,h6,blockquote") ?? first ?? null;
          if (passageTarget && target.contains(passageTarget)) passageTarget.classList.add("is-search-passage");
        }
        const anchor = range?.startContainer.parentElement ?? target;
        anchor.scrollIntoView({ block: "center", inline: "nearest" });
        target.focus({ preventScroll: true });
      }
      timeout = window.setTimeout(removeHighlight, 6500);
    };
    frame = window.requestAnimationFrame(reveal);
    return () => {
      window.cancelAnimationFrame(frame);
      window.clearTimeout(timeout);
      removeHighlight();
    };
  }, [request]);
  return null;
}
