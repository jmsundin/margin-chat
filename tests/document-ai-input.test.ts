import { describe, expect, test } from "bun:test";
import { Schema } from "@tiptap/pm/model";
import { EditorState, TextSelection } from "@tiptap/pm/state";
import { allowsDoubleSpaceAI, documentAIInput } from "../client/src/lib/documentAIInput";

const schema = new Schema({ nodes: { doc: { content: "paragraph+" }, paragraph: { content: "text*", group: "block" }, text: {} } });

function stateWith(text: string) {
  const doc = schema.node("doc", null, [schema.node("paragraph", null, text ? [schema.text(text)] : [])]);
  const state = EditorState.create({ doc });
  return state.apply(state.tr.setSelection(TextSelection.create(doc, 1 + text.length)));
}

describe("documentAIInput", () => {
  test("phones and tablets don't use the double-space shortcut", () => {
    expect(allowsDoubleSpaceAI("ios")).toBe(false);
    expect(allowsDoubleSpaceAI("android")).toBe(false);
    expect(allowsDoubleSpaceAI("mac")).toBe(true);
    expect(allowsDoubleSpaceAI("windows")).toBe(true);
  });

  test("two spaces after a word open Ask AI only where allowed", () => {
    const state = stateWith("Hello ");
    expect(documentAIInput(state, 7, 7, " ", 1, true)).toEqual({ from: 6, to: 7, spaces: 2 });
    expect(documentAIInput(state, 7, 7, " ", 1, false)).toBeNull();
  });

  test("iOS's period replacement is plain typing on phones", () => {
    const state = stateWith("Hello ");
    expect(documentAIInput(state, 6, 7, ". ", 1, true)).toEqual({ from: 6, to: 7, spaces: 2 });
    expect(documentAIInput(state, 6, 7, ". ", 1, false)).toBeNull();
  });

  test("Space on an empty line still opens Ask AI on phones", () => {
    expect(documentAIInput(stateWith(""), 1, 1, " ", 1, false)).toEqual({ from: 1, to: 1, spaces: 1 });
  });
});
