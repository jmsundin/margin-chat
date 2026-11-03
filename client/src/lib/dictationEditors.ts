import { isolateHistory } from "@codemirror/commands";
import { Transaction as CodeMirrorTransaction } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { closeHistory } from "@tiptap/pm/history";
import { TextSelection, type Transaction } from "@tiptap/pm/state";
import { registerDictationSurface, type TextSurface } from "./dictation";

/** Loaded by the editors themselves, so dictation reaches rich and code
 * editors without putting their libraries in the startup code. */

interface TiptapLike {
  isDestroyed?: boolean;
  state: { selection: { to: number }; doc: ProseMirrorNode; tr: Transaction };
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
    read: (from, to) => tiptap.state.doc.textBetween(from, to, "\n", " "),
    replace(from, to, text, history) {
      const plain = text.replace(/\s+/gu, " ");
      const tr = tiptap.state.tr;
      if (plain) tr.insertText(plain, from, to);
      else tr.delete(from, to);
      tr.setSelection(TextSelection.create(tr.doc, from + plain.length));
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
    read: (from, to) => codeMirror.state.sliceDoc(from, to),
    replace(from, to, text, history) {
      codeMirror.dispatch({
        changes: { from, to, insert: text }, selection: { anchor: from + text.length }, scrollIntoView: true,
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
