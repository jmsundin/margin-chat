import type { EditorState } from "@tiptap/pm/state";

/**
 * Recognize typing, including the iOS double-space replacement, before it changes the document.
 * `lineDepth` is the depth of a top-level line: 1 in a plain document, 2 inside a block wrapper.
 */
export function documentAIInput(state: EditorState, from: number, to: number, text: string, lineDepth = 1) {
  const { $from, empty, from: caret } = state.selection;
  if (!empty || $from.parent.type.spec.code || $from.marks().some((mark) => mark.type.name === "code")) return null;
  const preceding = $from.parent.textBetween(0, $from.parentOffset, "", "");
  const space = /^[ \u00a0]$/.test(text);
  if (space && from === caret && to === caret) {
    if ($from.depth === lineDepth && $from.parent.isTextblock && !$from.parent.textContent) return { from: caret, to: caret, spaces: 1 };
    if (/\S[ \u00a0]$/.test(preceding)) return { from: caret - 1, to: caret, spaces: 2 };
  }
  // Only treat punctuation as the shortcut when it replaces the single space
  // immediately before the caret. Pasted text and ordinary periods aren't AI.
  if (/^\.[ \u00a0]$/.test(text) && from === caret - 1 && to === caret && /\S[ \u00a0]$/.test(preceding)) {
    return { from, to, spaces: 2 };
  }
  return null;
}
