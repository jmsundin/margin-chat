import { EditorSelection, countColumn, type StateCommand } from "@codemirror/state";
import { IndentContext, getIndentation, indentString } from "@codemirror/language";
import { insertNewlineAndIndent } from "@codemirror/commands";

const PAIRS: Record<string, string> = { "(": ")", "[": "]", "{": "}" };

/**
 * Enter in a code cell: the new line starts with the current line's indentation, so code
 * written at any depth stays there. It goes one step deeper where the language says so
 * (after `{` or `:`), but never shallower than the line you were on.
 */
export const newlineKeepingIndent: StateCommand = (target) => {
  const { state, dispatch } = target;
  if (state.readOnly) return false;
  const main = state.selection.main;
  // Between a pair like `{}`, the closing one goes on a line of its own, as editors usually do.
  if (main.empty && PAIRS[state.sliceDoc(main.from - 1, main.from)] === state.sliceDoc(main.from, main.from + 1)) {
    return insertNewlineAndIndent(target);
  }
  const transaction = state.changeByRange((range) => {
    const line = state.doc.lineAt(range.from);
    const own = /^[ \t]*/.exec(line.text.slice(0, range.from - line.from))?.[0] ?? "";
    const language = getIndentation(new IndentContext(state, { simulateBreak: range.from }), range.from);
    const indent = language != null && language > countColumn(own, state.tabSize) ? indentString(state, language) : own;
    // Spaces just after the caret would sit between the indentation and the code, so they go.
    let to = range.to;
    const end = state.doc.lineAt(to);
    while (to < end.to && /[ \t]/.test(end.text[to - end.from])) to += 1;
    const insert = `\n${indent}`;
    return { changes: { from: range.from, to, insert }, range: EditorSelection.cursor(range.from + insert.length) };
  });
  dispatch(state.update(transaction, { scrollIntoView: true, userEvent: "input" }));
  return true;
};
