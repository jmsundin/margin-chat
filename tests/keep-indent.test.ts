import { describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { EditorState } from "@codemirror/state";
import { indentUnit } from "@codemirror/language";
import { python } from "@codemirror/lang-python";
import { javascript } from "@codemirror/lang-javascript";
import { sql } from "@codemirror/lang-sql";
import { codeLineBreak, getMarkdownEnterEdit } from "../client/src/lib/markdownEditing";
import { newlineKeepingIndent } from "../client/src/lib/codeRunner/keepIndent";
import { htmlFrameDocument, keepIndentOnEnter } from "../client/src/lib/htmlDocuments";

function enterInCell(doc: string, extensions = [] as never[], at = doc.length) {
  let state = EditorState.create({ doc, extensions, selection: { anchor: at } });
  newlineKeepingIndent({ state, dispatch: (transaction) => { state = transaction.state; } });
  return { text: state.doc.toString(), caret: state.selection.main.head };
}

describe("Enter in code keeps the line's indentation", () => {
  test("in a Markdown code fence", () => {
    const doc = "```js\nfunction f() {\n    let x = 1;";
    const edit = getMarkdownEnterEdit(doc, doc.length);
    expect(edit).toEqual({ from: doc.length, to: doc.length, insert: "\n    ", selection: doc.length + 5 });
    // Tabs are kept as tabs, and only the indentation before the caret counts.
    expect(codeLineBreak("\t\tx", 3).insert).toBe("\n\t\t");
    expect(codeLineBreak("    x", 2).insert).toBe("\n  ");
    // Outside a fence, Enter is unchanged.
    expect(getMarkdownEnterEdit("    plain", 9)).toBeNull();
  });

  test("in a code cell, at least as deep as the current line", () => {
    expect(enterInCell("SELECT a\n    FROM b", [sql()]).text).toBe("SELECT a\n    FROM b\n    ");
    expect(enterInCell("function f() {\n    let x = 1;", [javascript()]).text.endsWith("\n    ")).toBe(true);
    expect(enterInCell("def f():\n    return 1", [python(), indentUnit.of("    ")]).text.endsWith("\n    ")).toBe(true);
    // Where the language goes deeper, so does the new line.
    expect(enterInCell("def f():", [python(), indentUnit.of("    ")]).text).toBe("def f():\n    ");
    // Between braces the closing one moves to its own line.
    expect(enterInCell("if (x) {}", [javascript()], 8).text).toBe("if (x) {\n  \n}");
  });

  test("in a text box inside an HTML page or game", () => {
    const window = new Window();
    const document = window.document;
    document.body.innerHTML = `<textarea id="ed"></textarea><textarea id="own"></textarea>`;
    keepIndentOnEnter(window as never);
    const box = document.getElementById("ed") as unknown as HTMLTextAreaElement;
    box.value = "for x in y:\n    print(x)";
    box.setSelectionRange(box.value.length, box.value.length);
    let inputs = 0;
    box.addEventListener("input", () => { inputs += 1; });
    const press = (target: HTMLTextAreaElement, init: KeyboardEventInit = {}) => {
      const event = new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true, ...init });
      target.dispatchEvent(event as never);
      return event.defaultPrevented;
    };
    expect(press(box)).toBe(true);
    expect(box.value).toBe("for x in y:\n    print(x)\n    ");
    expect(box.selectionStart).toBe(box.value.length);
    expect(inputs).toBe(1);
    // No indentation, modifier keys, or a page that handles Enter itself: left alone.
    box.value = "x";
    box.setSelectionRange(1, 1);
    expect(press(box)).toBe(false);
    box.value = "  x";
    box.setSelectionRange(3, 3);
    expect(press(box, { ctrlKey: true })).toBe(false);
    const own = document.getElementById("own") as unknown as HTMLTextAreaElement;
    own.value = "  y";
    own.setSelectionRange(3, 3);
    own.addEventListener("keydown", (event) => event.preventDefault());
    press(own);
    expect(own.value).toBe("  y");
    // Every page frame gets it.
    expect(htmlFrameDocument("<p>x</p>")).toContain("(window);</script>");
  });
});
