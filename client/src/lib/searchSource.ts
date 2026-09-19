import type { Conversation } from "../types";
import type { SearchEvidenceRef } from "./conversationSearch";
import { resolveGraphEvidence } from "./graphExploration";
import { summarizeAnnotationText } from "./annotationPreview";
import { getStandaloneNote } from "./standaloneNotes";

export function resolveSearchSource(conversations: Record<string, Conversation>, source: SearchEvidenceRef) {
  if (source.sourceKind !== "annotation") return resolveGraphEvidence(conversations, { ...source, sourceKind: source.sourceKind });
  const conversation = Object.hasOwn(conversations, source.conversationId) ? conversations[source.conversationId] : undefined;
  const note = conversation?.notes?.find((item) => item.id === source.noteId);
  if (!note || (conversation && note === getStandaloneNote(conversation))) return { status: "missing" as const, content: null, highlight: null };
  const { quote, startOffset, endOffset } = source;
  if (!quote) return { status: startOffset === undefined && endOffset === undefined ? "exact" as const : "stale" as const, content: note.content, highlight: null };
  if (Number.isInteger(startOffset) && Number.isInteger(endOffset) && startOffset! >= 0 && endOffset! > startOffset! && endOffset! <= note.content.length && note.content.slice(startOffset, endOffset) === quote) {
    return { status: "exact" as const, content: note.content, highlight: { startOffset: startOffset!, endOffset: endOffset! } };
  }
  const offset = note.content.indexOf(quote);
  if (offset >= 0 && note.content.indexOf(quote, offset + 1) === -1) return { status: "recovered" as const, content: note.content, highlight: { startOffset: offset, endOffset: offset + quote.length } };
  return { status: "stale" as const, content: note.content, highlight: null };
}

/** Map a unique visible quote across Markdown DOM nodes, without changing the message DOM. */
export function createSearchPassageRange(element: HTMLElement, quote: string): Range | null {
  const needle = summarizeAnnotationText(quote, 5000).replace(/\s+/g, " ").trim();
  if (!needle) return null;
  const points: Array<{ node: Text; offset: number }> = [];
  let text = "";
  const ownerDocument = element.ownerDocument;
  const walker = ownerDocument.createTreeWalker(element, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.nodeType === Node.ELEMENT_NODE) {
      const boundary = node as HTMLElement;
      if (boundary.matches("br,hr,p,li,h1,h2,h3,h4,h5,h6,pre,td,th,blockquote,div") &&
        !boundary.closest('button, script, style, [hidden], [aria-hidden="true"]') && text && !text.endsWith(" ")) {
        text += " ";
        points.push(points.at(-1)!);
      }
      continue;
    }
    const textNode = node as Text;
    if (textNode.parentElement?.closest('button, script, style, [hidden], [aria-hidden="true"]')) continue;
    // Block boundaries are visible whitespace even when HTML contains no text-node separator.
    const previous = points.at(-1)?.node;
    const block = textNode.parentElement?.closest("p,li,h1,h2,h3,h4,h5,h6,pre,td,th,blockquote");
    const previousBlock = previous?.parentElement?.closest("p,li,h1,h2,h3,h4,h5,h6,pre,td,th,blockquote");
    if (text && !text.endsWith(" ") && block !== previousBlock) {
      text += " ";
      points.push({ node: textNode, offset: 0 });
    }
    for (let offset = 0; offset < textNode.length; offset++) {
      const character = /\s/.test(textNode.data[offset]) ? " " : textNode.data[offset];
      if (character === " " && text.endsWith(" ")) continue;
      text += character;
      points.push({ node: textNode, offset });
    }
  }
  const start = text.indexOf(needle);
  if (start < 0 || text.indexOf(needle, start + 1) !== -1) return null;
  const first = points[start];
  const last = points[start + needle.length - 1];
  if (!first || !last) return null;
  const range = ownerDocument.createRange();
  range.setStart(first.node, first.offset);
  range.setEnd(last.node, Math.min(last.offset + 1, last.node.length));
  return range;
}
