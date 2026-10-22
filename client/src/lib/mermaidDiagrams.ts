import type { MermaidConfig } from "mermaid";

export type MermaidTheme = "light" | "dark";

export const MERMAID_BLOCK_SELECTOR = ".message-mermaid-block";

export function getMermaidConfig(theme: MermaidTheme): MermaidConfig {
  return {
    darkMode: theme === "dark",
    deterministicIds: true,
    deterministicIDSeed: `margin-chat-${theme}`,
    fontFamily:
      'ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    htmlLabels: false,
    securityLevel: "strict",
    startOnLoad: false,
    theme: theme === "dark" ? "dark" : "neutral",
  };
}

export function setMermaidStatus(block: HTMLElement, message: string | null) {
  const existingStatus = block.querySelector<HTMLElement>(".message-mermaid-status");

  if (!message) {
    existingStatus?.remove();
    return;
  }

  const status = existingStatus ?? document.createElement("p");
  status.className = "message-mermaid-status";
  status.textContent = message;

  if (!existingStatus) {
    block.append(status);
  }
}

/** The app theme lives on <html data-theme>; anything else falls back to light. */
export function getDocumentMermaidTheme(): MermaidTheme {
  return typeof document !== "undefined" && document.documentElement.dataset.theme === "dark"
    ? "dark"
    : "light";
}

let nextStaticRenderId = 0;

/**
 * Draws every Mermaid block inside markup produced by renderMarkdownToHtml
 * or renderObsidianMarkdownToHtml. Ids are unique per call because Mermaid
 * removes any element already in the page that has the id it renders with.
 */
export async function renderMermaidBlocksIn(
  root: HTMLElement,
  { theme = getDocumentMermaidTheme(), isCancelled = () => false }: {
    theme?: MermaidTheme;
    isCancelled?: () => boolean;
  } = {},
): Promise<boolean> {
  const blocks = [...root.querySelectorAll<HTMLElement>(MERMAID_BLOCK_SELECTOR)];
  if (!blocks.length) return false;

  const { default: mermaid } = await import("mermaid");
  if (isCancelled()) return false;
  mermaid.initialize(getMermaidConfig(theme));

  let changed = false;
  for (const block of blocks) {
    const source = block.querySelector("code")?.textContent ?? "";
    const diagram = block.querySelector<HTMLElement>(".message-mermaid-diagram");
    if (!source.trim() || !diagram) continue;

    nextStaticRenderId += 1;
    try {
      const { svg, bindFunctions } = await mermaid.render(`mermaid-static-${nextStaticRenderId}`, source);
      if (isCancelled()) return changed;
      diagram.innerHTML = svg;
      bindFunctions?.(diagram);
      block.classList.add("is-rendered");
      block.classList.remove("has-error");
      setMermaidStatus(block, null);
    } catch (error) {
      if (isCancelled()) return changed;
      block.classList.remove("is-rendered");
      block.classList.add("has-error");
      diagram.innerHTML = "";
      setMermaidStatus(
        block,
        error instanceof Error && error.message
          ? `Mermaid render error: ${error.message}`
          : "Mermaid render error: diagram source is shown instead.",
      );
    }
    changed = true;
  }
  return changed;
}

/** Where a ```mermaid fence sits inside a block's Markdown: `start`–`end` is the whole fence, `from`–`to` its diagram source. */
export interface MermaidFence {
  start: number;
  end: number;
  from: number;
  to: number;
  source: string;
}

const MERMAID_FENCE = /^([ \t]{0,3})(`{3,}|~{3,})[ \t]*mermaid[ \t]*\n/gim;

/** The Mermaid fences in `markdown`; an unclosed fence runs to the end, as Markdown reads it. */
export function findMermaidFences(markdown: string): MermaidFence[] {
  const fences: MermaidFence[] = [];
  MERMAID_FENCE.lastIndex = 0;
  for (let match = MERMAID_FENCE.exec(markdown); match; match = MERMAID_FENCE.exec(markdown)) {
    const from = match.index + match[0].length;
    const marker = match[2];
    const closing = new RegExp(`^[ \\t]{0,3}${marker[0] === "`" ? "`" : "~"}{${marker.length},}[ \\t]*$`, "m");
    const rest = markdown.slice(from);
    const close = closing.exec(rest);
    const to = close ? from + close.index : markdown.length;
    const end = close ? to + close[0].length : markdown.length;
    fences.push({ start: match.index, end, from, to, source: markdown.slice(from, to).replace(/\n$/, "") });
    MERMAID_FENCE.lastIndex = close ? to + close[0].length : markdown.length;
  }
  return fences;
}

/** `markdown` with one fence's diagram source swapped for `source`, keeping the fence lines as written. */
export function replaceMermaidFence(markdown: string, fence: MermaidFence, source: string): string {
  const body = source.replace(/\n+$/, "");
  const closed = fence.to < markdown.length || markdown.slice(fence.from, fence.to).endsWith("\n");
  return markdown.slice(0, fence.from) + body + (closed ? "\n" : "") + markdown.slice(fence.to);
}

/** Whether a selected passage is exactly one Mermaid diagram, fence lines included. */
export function isMermaidDiagramPassage(markdown: string | undefined): boolean {
  const trimmed = markdown?.trim() ?? "";
  const fences = findMermaidFences(trimmed);
  return fences.length === 1 && fences[0].start === 0 && fences[0].end === trimmed.length;
}

/**
 * An AI reply meant to replace a diagram, as one ```mermaid fence: the first Mermaid fence in it,
 * else its first fence of any kind, else the whole reply. Any words around the diagram are dropped.
 */
export function mermaidDiagramReply(reply: string): string {
  const fence = findMermaidFences(reply)[0];
  if (fence) return `\`\`\`mermaid\n${fence.source.trim()}\n\`\`\``;
  const other = /^[ \t]{0,3}(`{3,}|~{3,})[^\n]*\n([\s\S]*?)^[ \t]{0,3}\1[ \t]*$/m.exec(reply);
  const source = (other ? other[2] : reply).trim();
  return source ? `\`\`\`mermaid\n${source}\n\`\`\`` : reply;
}

/** Whether focus is on a document preview whose diagram is selected for the selection menu (it has no text selection). */
export function hasSelectedDiagramInFocus(): boolean {
  return typeof document !== "undefined" && Boolean(document.activeElement?.closest(".live-document-preview")?.querySelector(".is-diagram-selected"));
}
