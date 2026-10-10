import { useLayoutEffect, useMemo, useRef } from "react";
import { renderObsidianMarkdownToHtml } from "../lib/markdown";
import { parseMarkdownBlocks } from "../lib/markdownBlocks";
import { renderMermaidBlocksIn } from "../lib/mermaidDiagrams";
import "./MarkdownLivePreview.css";

const BLOCK_CLASS = "cm-live-rendered-block message-content is-markdown obsidian-note-markdown";

/** The rendered blocks the Live Preview editor shows, cut after about `maxLength` characters. */
export function liveMarkdownPreviewHtml(source: string, maxLength = 6000) {
  const blocks: string[] = [];
  let length = 0;
  for (const block of parseMarkdownBlocks(source)) {
    if (block.kind === "blank" || !block.value.trim()) continue;
    if (blocks.length && length + block.value.length > maxLength) return { html: blocks.join(""), truncated: true };
    blocks.push(`<div class="${BLOCK_CLASS}">${renderObsidianMarkdownToHtml(block.value)}</div>`);
    length += block.value.length;
  }
  return { html: blocks.join(""), truncated: false };
}

/** Wraps each search term found in the rendered text in a <mark>, skipping code and diagrams. */
export function highlightTermsIn(root: HTMLElement, terms: string[]) {
  const wanted = [...new Set(terms.map((term) => term.toLocaleLowerCase()))].filter((term) => term.length > 1).sort((a, b) => b.length - a.length);
  if (!wanted.length) return;
  const pattern = new RegExp(`(${wanted.map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`, "giu");
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => node.parentElement?.closest("pre, code, svg, script, style, mark, .katex")
      ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
  });
  const textNodes: Text[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) textNodes.push(node as Text);
  for (const node of textNodes) {
    const parts = (node.nodeValue ?? "").split(pattern);
    if (parts.length < 2) continue;
    const fragment = document.createDocumentFragment();
    parts.forEach((part, index) => {
      if (!part) return;
      if (index % 2) {
        const mark = document.createElement("mark");
        mark.className = "markdown-live-preview-match";
        mark.textContent = part;
        fragment.append(mark);
      } else fragment.append(part);
    });
    node.replaceWith(fragment);
  }
}

/** A read-only Live Preview of Markdown, rendered the same way the Markdown editor renders lines you are not editing. */
export default function MarkdownLivePreview({ className = "", highlightTerms = [], maxLength, source }: {
  className?: string;
  highlightTerms?: string[];
  maxLength?: number;
  source: string;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const { html, truncated } = useMemo(() => liveMarkdownPreviewHtml(source, maxLength), [maxLength, source]);
  const termsKey = highlightTerms.join("\u0000");

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return undefined;
    root.innerHTML = html;
    highlightTermsIn(root, termsKey ? termsKey.split("\u0000") : []);
    let cancelled = false;
    void renderMermaidBlocksIn(root, { isCancelled: () => cancelled });
    return () => { cancelled = true; };
  }, [html, termsKey]);

  return <div className={`markdown-live-preview ${className}`.trim()}>
    <div className="markdown-live-preview-body" ref={rootRef}/>
    {truncated ? <p className="markdown-live-preview-more">Open the document to read the rest.</p> : null}
  </div>;
}
