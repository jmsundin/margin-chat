import type { Editor } from "@tiptap/core";

/** Replace only the changed range; unchanged rendered nodes and selection survive. */
export function updateRichDocumentContent(editor: Editor, markdown: string) {
  const next = editor.schema.nodeFromJSON(editor.markdown!.parse(markdown));
  const current = editor.state.doc;
  const start = current.content.findDiffStart(next.content);
  if (start === null) return;
  const end = current.content.findDiffEnd(next.content)!;
  // Diff boundaries can overlap for insertions/deletions in repeated text.
  const overlap = start - Math.min(end.a, end.b);
  const oldEnd = overlap > 0 ? end.a + overlap : end.a;
  const newEnd = overlap > 0 ? end.b + overlap : end.b;
  editor.view.dispatch(editor.state.tr.replace(start, oldEnd, next.slice(start, newEnd)).setMeta("addToHistory", false).setMeta("preventUpdate", true));
}
