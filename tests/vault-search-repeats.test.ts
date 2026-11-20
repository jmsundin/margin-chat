import { expect, test } from "bun:test";
import { withoutRepeats } from "../client/src/components/VaultSearchPalette";

const doc = (id: string, title: string) => ({ key: `doc:${id}`, title, kindLabel: "Note", target: { kind: "loaded" as const, conversationId: id } });
const passage = (id: string, title: string, text: string) => ({
  key: `p:${id}:${text}`, conversationId: id, title, kindLabel: "Note", matchLabel: "Document passage", preview: text, passage: text,
  updatedAt: "", evidence: { conversationId: id, sourceKind: "document" as const }, localOnly: false,
});

test("search lists a document found above once", () => {
  const found = [{ kind: "document" as const, hit: { ...doc("sleep", "Sleep and aging"), key: "found:sleep" } }];
  const { documents, passages } = withoutRepeats(found, [doc("sleep", "Sleep and aging"), doc("nap", "Naps and sleep")], [
    passage("sleep", "Sleep and aging", "# Sleep and aging"),
    passage("sleep", "Sleep and aging", "Sleep under six hours raises cortisol."),
  ]);
  expect(documents.map((hit) => hit.title)).toEqual(["Naps and sleep"]);
  expect(passages.map((hit) => hit.passage)).toEqual(["Sleep under six hours raises cortisol."]);
});

test("titles stay when nothing was found above", () => {
  const { documents } = withoutRepeats([], [doc("sleep", "Sleep and aging")], []);
  expect(documents).toHaveLength(1);
});
