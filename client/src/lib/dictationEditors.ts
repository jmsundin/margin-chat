import { isolateHistory } from "@codemirror/commands";
import { Transaction as CodeMirrorTransaction } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { closeHistory } from "@tiptap/pm/history";
import { TextSelection, type Transaction } from "@tiptap/pm/state";
import { mapThroughEdit, registerDictationSurface, type TextSurface } from "./dictation";

/** Loaded by the editors themselves, so dictation reaches rich and code
 * editors without putting their libraries in the startup code. */

interface TiptapLike {
  isDestroyed?: boolean;
  state: { selection: { anchor: number; head: number; to: number }; doc: ProseMirrorNode; tr: Transaction };
  view: { dispatch(transaction: Transaction): void; focus(): void };
}

function findTiptap(target: HTMLElement): TiptapLike | null {
  for (let node: HTMLElement | null = target; node; node = node.parentElement) {
    const editor = (node as HTMLElement & { editor?: TiptapLike }).editor;
    if (editor?.view && editor.state) return editor.isDestroyed ? null : editor;
  }
  return null;
}

function tiptapSurface(target: HTMLElement): TextSurface | null {
  const tiptap = findTiptap(target);
  if (!tiptap) return null;
  return {
    caret: () => tiptap.state.selection.to,
    length: () => tiptap.state.doc.content.size,
    read: (from, to) => tiptap.state.doc.textBetween(from, to, "\n", " "),
    replace(from, to, text, history, keepSelection = false) {
      const plain = text.replace(/\s+/gu, " ");
      const { anchor, head } = tiptap.state.selection;
      const tr = tiptap.state.tr;
      if (plain) tr.insertText(plain, from, to);
      else tr.delete(from, to);
      tr.setSelection(keepSelection
        ? TextSelection.create(tr.doc, mapThroughEdit(anchor, from, to, plain.length), mapThroughEdit(head, from, to, plain.length))
        : TextSelection.create(tr.doc, from + plain.length));
      tr.setMeta("addToHistory", history);
      // Its own undo step, even right after typing or another dictation edit.
      if (history) closeHistory(tr);
      tiptap.view.dispatch(tr.scrollIntoView());
      return plain;
    },
    focus: () => tiptap.view.focus(),
  };
}

function codeMirrorSurface(target: HTMLElement): TextSurface | null {
  const codeMirrorRoot = target.closest<HTMLElement>(".cm-editor");
  const codeMirror = codeMirrorRoot ? EditorView.findFromDOM(codeMirrorRoot) : null;
  if (!codeMirror) return null;
  return {
    caret: () => codeMirror.state.selection.main.to,
    length: () => codeMirror.state.doc.length,
    read: (from, to) => codeMirror.state.sliceDoc(from, to),
    replace(from, to, text, history, keepSelection = false) {
      const { anchor, head } = codeMirror.state.selection.main;
      codeMirror.dispatch({
        changes: { from, to, insert: text },
        selection: keepSelection
          ? { anchor: mapThroughEdit(anchor, from, to, text.length), head: mapThroughEdit(head, from, to, text.length) }
          : { anchor: from + text.length },
        scrollIntoView: true,
        annotations: history ? isolateHistory.of("full") : CodeMirrorTransaction.addToHistory.of(false),
      });
      return text;
    },
    focus: () => codeMirror.focus(),
  };
}

// Checked in the same order as before: a rich editor first, then a code editor.
registerDictationSurface(tiptapSurface);
registerDictationSurface(codeMirrorSurface);
