import type { MermaidConfig } from "mermaid";

export type MermaidTheme = "light" | "dark";

export const MERMAID_BLOCK_SELECTOR = ".message-mermaid-block";

const MERMAID_FONT = 'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';

/**
 * The "Clean" diagram look, matched to the editor's own colors: white (or #212121) boxes with a
 * hairline border and soft corners, thin gray lines, quiet edge labels and the app's green on
 * decisions. `background` is the page color diagrams sit on (styles.css draws their frame in it).
 */
const MERMAID_COLORS = {
  light: {
    background: "#ffffff", node: "#ffffff", border: "#d7d7d7", frame: "#e7e7e7", ink: "#0d0d0d", muted: "#676767", line: "#a3a3a3",
    soft: "#fafafa", softer: "#f4f4f4", accent: "#0b8f70", accentInk: "#08795f", accentFill: "#e8f5f1", accentBorder: "#bfe3d7",
    // Pie slices, mind map branches, timeline sections, git branches and chart series, in order.
    series: ["#bfe6d8", "#c7dcf7", "#ddd3f8", "#f8cfc4", "#f6e2a6", "#bfe3e6", "#f3c9de", "#dedede"],
  },
  dark: {
    background: "#171717", node: "#212121", border: "#424242", frame: "#2f2f2f", ink: "#ececec", muted: "#9b9b9b", line: "#6f6f6f",
    soft: "#1c1c1c", softer: "#212121", accent: "#10a37f", accentInk: "#5fd6b4", accentFill: "#16302a", accentBorder: "#1f5546",
    series: ["#1f5c4b", "#294d73", "#4a3f7d", "#7a3f31", "#6e5a1f", "#22585d", "#6e3657", "#3f3f3f"],
  },
} as const;

function mermaidThemeVariables(theme: MermaidTheme): Record<string, unknown> {
  const c = MERMAID_COLORS[theme];
  const series: Record<string, string> = {};
  c.series.forEach((fill, index) => {
    for (const offset of [0, c.series.length]) {
      series[`cScale${index + offset}`] = fill;
      series[`cScalePeer${index + offset}`] = fill;
      series[`cScaleLabel${index + offset}`] = c.ink;
      series[`pie${index + offset + 1}`] = fill;
    }
    series[`git${index}`] = fill;
    series[`gitInv${index}`] = fill;
    series[`gitBranchLabel${index}`] = c.ink;
    series[`fillType${index}`] = fill;
  });
  return {
    darkMode: theme === "dark", fontFamily: MERMAID_FONT, fontSize: "14px", background: c.background,
    primaryColor: c.node, primaryBorderColor: c.border, primaryTextColor: c.ink, textColor: c.ink, lineColor: c.line,
    edgeLabelBackground: c.background, clusterBkg: c.soft, clusterBorder: c.frame, titleColor: c.muted,
    actorBkg: c.node, actorBorder: c.border, actorTextColor: c.ink, actorLineColor: c.border,
    signalColor: c.line, signalTextColor: c.ink, labelBoxBkgColor: c.node, labelBoxBorderColor: c.border, labelTextColor: c.ink,
    noteBkgColor: c.accentFill, noteBorderColor: c.accentBorder, noteTextColor: c.ink,
    activationBkgColor: c.accentFill, activationBorderColor: c.accent, sequenceNumberColor: c.background,
    ...series,
    pieStrokeColor: c.background, pieStrokeWidth: "2px", pieOuterStrokeWidth: "0px", pieOpacity: "1",
    pieSectionTextColor: c.ink, pieTitleTextColor: c.ink, pieLegendTextColor: c.ink,
    commitLabelColor: c.muted, commitLabelBackground: c.background, tagLabelColor: c.ink, tagLabelBackground: c.softer, tagLabelBorder: c.softer,
    quadrant1Fill: c.soft, quadrant2Fill: c.softer, quadrant3Fill: c.soft, quadrant4Fill: c.softer,
    quadrant1TextFill: c.muted, quadrant2TextFill: c.muted, quadrant3TextFill: c.muted, quadrant4TextFill: c.muted,
    quadrantPointFill: c.accent, quadrantPointTextFill: c.ink, quadrantXAxisTextFill: c.ink, quadrantYAxisTextFill: c.ink,
    quadrantInternalBorderStrokeFill: c.background, quadrantExternalBorderStrokeFill: c.background, quadrantTitleFill: c.ink,
    xyChart: {
      backgroundColor: c.background, titleColor: c.ink, plotColorPalette: [c.accent, ...c.series.slice(1)].join(","),
      xAxisLabelColor: c.muted, xAxisTitleColor: c.muted, xAxisTickColor: c.muted, xAxisLineColor: c.muted,
      yAxisLabelColor: c.muted, yAxisTitleColor: c.muted, yAxisTickColor: c.muted, yAxisLineColor: c.muted,
    },
  };
}

/** Shapes and lines the theme variables can't reach. Mermaid scopes these rules to each diagram. */
function mermaidThemeCSS(theme: MermaidTheme): string {
  const c = MERMAID_COLORS[theme];
  return `
    .node rect, .node polygon, .node circle, .node path { stroke-width: 1px; }
    .node rect { rx: 10px; ry: 10px; }
    .node polygon { fill: ${c.accentFill}; stroke: ${c.accent}; }
    .node:has(polygon) text { fill: ${c.accentInk}; font-weight: 500; }
    .flowchart-link { stroke-width: 1.25px; }
    .edgeLabel rect, .labelBkg { fill: ${c.background}; opacity: 1; }
    .edgeLabel text, .edgeLabel tspan { fill: ${c.muted}; font-size: 12px; }
    rect.actor { rx: 10px; ry: 10px; stroke-width: 1px; }
    .actor-line { stroke-dasharray: 3 4; }
    .messageText { font-size: 13px; }
    .note { rx: 8px; ry: 8px; }
    .marker.er circle { fill: ${c.background}; }
    .eventWrapper { filter: none; }
  `;
}

export function getMermaidConfig(theme: MermaidTheme): MermaidConfig {
  return {
    darkMode: theme === "dark",
    deterministicIds: true,
    deterministicIDSeed: `margin-chat-${theme}`,
    fontFamily: MERMAID_FONT,
    htmlLabels: false,
    securityLevel: "strict",
    startOnLoad: false,
    theme: "base",
    themeVariables: mermaidThemeVariables(theme),
    themeCSS: mermaidThemeCSS(theme),
    flowchart: { curve: "basis", padding: 14, nodeSpacing: 36, rankSpacing: 44 },
    sequence: { mirrorActors: false, actorMargin: 60 },
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
