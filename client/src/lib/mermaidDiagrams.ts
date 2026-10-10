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
