import type { JSONContent } from "@tiptap/core";
import { Fragment, Slice, type Node as ProseMirrorNode } from "@tiptap/pm/model";
import diff from "fast-diff";
import { marked } from "marked";
import { findObsidianCalloutBlocks, findObsidianInlineTokens } from "./obsidianMarkdown";

/** Keep raw slices, including separators, so splitting never rewrites source text. */
export function splitRichDocumentMarkdown(markdown: string): string[] {
  if (!markdown) return [""];
  const chunks: string[] = [];
  for (const token of marked.lexer(markdown, { gfm: true })) {
    if (token.type === "space" && chunks.length) chunks[chunks.length - 1] += token.raw;
    else if (token.raw) chunks.push(token.raw);
  }
  return chunks.join("") === markdown ? chunks : [markdown];
}

/** These constructs require the existing Markdown renderer and lossless source editing. */
export function getRichDocumentFallbackReason(markdown: string): string | null {
  const inline = findObsidianInlineTokens(markdown);
  if (inline.some((token) => token.kind === "wikilink" || token.kind === "embed")) return "Wiki link";
  if (inline.some((token) => token.kind === "comment")) return "Hidden comment";
  if (findObsidianCalloutBlocks(markdown).length) return "Callout";
  const tokens = marked.lexer(markdown, { gfm: true });
  if (Object.keys(tokens.links).length) return "Reference";
  let reason: string | null = null;
  marked.walkTokens(tokens, (token) => {
    if (reason) return;
    if (token.type === "code" && token.lang?.trim().toLowerCase() === "mermaid") reason = "Diagram";
    else if (token.type === "image") reason = "Image";
    else if (token.type === "html") reason = token.raw.startsWith("<!--") ? "Hidden comment" : "Embedded markup";
  });
  return reason;
}

/** Map equivalent Markdown spellings without treating rendered offsets as source offsets. */
export function mapEquivalentMarkdownOffset(from: string, to: string, offset: number, affinity: -1 | 1 = 1): number {
  const boundary = Math.max(0, Math.min(from.length, offset));
  if (from === to) return boundary;
  let source = 0;
  let target = 0;
  for (const [kind, text] of diff(from, to)) {
    if (kind === 1) {
      if (source === boundary && affinity < 0) return target;
      target += text.length;
    } else if (kind === -1) {
      if (boundary < source + text.length) return target;
      source += text.length;
    } else {
      if (boundary < source + text.length || (boundary === source + text.length && affinity < 0)) return target + boundary - source;
      source += text.length;
      target += text.length;
    }
  }
  return Math.min(target, to.length);
}

export type MarkdownSerializer = (content: JSONContent) => string;
const positionCache = new WeakMap<ProseMirrorNode, Map<number, { markdown: string; offset: number }>>();

/** Serialize a harmless temporary marker; it never enters the live editor or its history. */
export function markdownOffsetAtDocumentPosition(doc: ProseMirrorNode, serialize: MarkdownSerializer, markdown: string, position: number, affinity: -1 | 1 = 1): number {
  const safe = Math.max(0, Math.min(doc.content.size, position));
  let cache = positionCache.get(doc);
  if (!cache) { cache = new Map(); positionCache.set(doc, cache); }
  const key = safe * 2 + (affinity > 0 ? 1 : 0);
  let result = cache.get(key);
  if (!result) {
    let marker = "MARGINCURSOR9F34B7";
    while (doc.textContent.includes(marker)) marker += "X";
    const point = doc.resolve(safe);
    const neighbor = affinity > 0 ? point.nodeAfter : point.nodeBefore;
    const marks = neighbor?.isText ? neighbor.marks : point.marks();
    const markerDoc = doc.replace(safe, safe, new Slice(Fragment.from(doc.type.schema.text(marker, marks)), 0, 0));
    const marked = serialize(markerDoc.toJSON());
    const offset = marked.indexOf(marker);
    if (offset < 0) return affinity < 0 ? 0 : markdown.length;
    result = { markdown: marked.slice(0, offset) + marked.slice(offset + marker.length), offset };
    cache.set(key, result);
  }
  return mapEquivalentMarkdownOffset(result.markdown, markdown, result.offset, affinity);
}

/** Only text positions are returned; structural Markdown punctuation maps to its nearest text. */
export function documentPositionAtMarkdownOffset(doc: ProseMirrorNode, serialize: MarkdownSerializer, markdown: string, offset: number, affinity: -1 | 1 = 1): number {
  const positions: number[] = [];
  doc.descendants((node, position) => {
    if (node.isTextblock) {
      for (let index = 0; index <= node.content.size; index += 1) positions.push(position + 1 + index);
      return false;
    }
    return true;
  });
  if (!positions.length) return 0;
  let left = 0;
  let right = positions.length - 1;
  while (left < right) {
    const middle = Math.floor((left + right) / 2);
    const point = markdownOffsetAtDocumentPosition(doc, serialize, markdown, positions[middle], affinity);
    if (point < offset) left = middle + 1;
    else right = middle;
  }
  if (affinity < 0 && left > 0 && markdownOffsetAtDocumentPosition(doc, serialize, markdown, positions[left], affinity) > offset) left -= 1;
  return positions[left];
}
