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
    // Without this, a diagram Mermaid can't read leaves its "Syntax error in text" bomb at the
    // bottom of the page (its scratch element in <body> is never removed); we show our own error.
    suppressErrorRendering: true,
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

/** One step of a staged diagram: its title and the Mermaid text that draws everything up to it. */
export interface DiagramStage { title: string; source: string }

const STAGE_MARKER = /^[ \t]*%%[ \t]*stage\b[^:\n]*:?[ \t]*(.*)$/i;

/**
 * A diagram that builds up in stages (Visualize writes these): Mermaid comment lines
 * `%% stage: Title` start each stage, and stage n draws the lines before the first marker
 * plus stages 1 to n. Mermaid and Obsidian ignore the comments, so elsewhere the file shows
 * the finished diagram. Fewer than two markers is an ordinary diagram (null).
 */
export function parseDiagramStages(source: string): DiagramStage[] | null {
  const lines = source.split("\n");
  const markers = lines.flatMap((line, index) => {
    const match = STAGE_MARKER.exec(line);
    return match ? [{ index, title: match[1].trim() }] : [];
  });
  if (markers.length < 2) return null;
  return markers.map((marker, stage) => ({
    title: marker.title || `Stage ${stage + 1}`,
    source: lines.slice(0, markers[stage + 1]?.index ?? lines.length).filter((line) => !STAGE_MARKER.test(line)).join("\n"),
  }));
}

type MermaidApi = typeof import("mermaid").default;

/** Mermaid draws in a scratch element in <body>; when drawing fails, make sure none is left on the page. */
export async function renderMermaid(mermaid: MermaidApi, renderId: string, source: string) {
  try {
    return await mermaid.render(renderId, source);
  } catch (error) {
    for (const id of [`d${renderId}`, `i${renderId}`, renderId]) {
      const element = document.getElementById(id);
      if (element?.parentElement === document.body) element.remove();
    }
    throw error;
  }
}

/**
 * Draws one Mermaid block's diagram. A staged diagram draws every stage, stacked in one place so the
 * panel keeps the height of its tallest stage, and shows the one its stepper points at.
 * Throws Mermaid's error; the caller shows it.
 */
export async function drawMermaidBlock(mermaid: MermaidApi, block: HTMLElement, diagram: HTMLElement, source: string, renderId: string) {
  const stages = block.classList.contains("is-staged") ? parseDiagramStages(source) : null;
  if (!stages) {
    const { svg, bindFunctions } = await renderMermaid(mermaid, renderId, source);
    diagram.innerHTML = svg;
    bindFunctions?.(diagram);
    const drawn = diagram.querySelector<SVGSVGElement>("svg");
    const width = drawn?.viewBox.baseVal?.width ?? 0;
    if (drawn && width > 0) sizeDiagramSvg(drawn, width, width);
    centerWideDiagram(block);
    return;
  }
  const views: HTMLElement[] = [];
  for (const [index, stage] of stages.entries()) {
    const { svg, bindFunctions } = await renderMermaid(mermaid, `${renderId}-stage-${index}`, stage.source);
    const view = document.createElement("div");
    view.className = "diagram-stage-view";
    view.innerHTML = svg;
    bindFunctions?.(view);
    views.push(view);
  }
  diagram.replaceChildren(...views);
  // Every stage at the scale of the widest one, so nodes keep their size as the diagram grows,
  // but never so small that its words can't be read.
  const widths = views.map((view) => view.querySelector("svg")?.viewBox.baseVal?.width ?? 0);
  const widest = Math.max(...widths);
  if (widest > 0) views.forEach((view, index) => {
    const svg = view.querySelector<SVGSVGElement>("svg");
    if (svg && widths[index] > 0) sizeDiagramSvg(svg, widths[index], widest);
  });
  showDiagramStage(block, Number(block.dataset.stage ?? 0));
  installStageControls();
}

/**
 * The smallest a diagram is drawn, as a share of Mermaid's own size (14px text becomes about 11px).
 * A diagram wider than its panel at this size scrolls sideways instead of shrinking further.
 */
export const MIN_DIAGRAM_SCALE = 0.8;

/**
 * Sizes one drawn diagram: its own width at most, shrunk with the panel in step with the widest
 * diagram beside it (`widest`), and never below MIN_DIAGRAM_SCALE. Plain CSS, so it follows the
 * panel as it resizes.
 */
export function sizeDiagramSvg(svg: SVGSVGElement, width: number, widest: number) {
  svg.style.width = `${width}px`;
  svg.style.maxWidth = `${(width / widest) * 100}%`;
  svg.style.minWidth = `${Math.round(width * MIN_DIAGRAM_SCALE)}px`;
}

/** A diagram wider than its panel opens scrolled to its middle, where a top-down diagram's root sits. */
function centerWideDiagram(block: HTMLElement) {
  const diagram = block.querySelector<HTMLElement>(".message-mermaid-diagram");
  if (diagram && diagram.scrollWidth > diagram.clientWidth) diagram.scrollLeft = (diagram.scrollWidth - diagram.clientWidth) / 2;
}

/** Points a staged diagram's stepper and picture at one stage. */
export function showDiagramStage(block: HTMLElement, stage: number) {
  const views = [...block.querySelectorAll<HTMLElement>(".diagram-stage-view")];
  const chips = [...block.querySelectorAll<HTMLElement>(".diagram-stage-chip")];
  const count = Math.max(views.length, chips.length);
  if (!count) return;
  const current = Math.max(0, Math.min(count - 1, Number.isFinite(stage) ? stage : 0));
  block.dataset.stage = String(current);
  views.forEach((view, index) => view.classList.toggle("is-current", index === current));
  chips.forEach((chip, index) => chip.setAttribute("aria-pressed", String(index === current)));
  const number = block.querySelector(".diagram-stage-number");
  if (number) number.textContent = String(current + 1);
  // A staged Mermaid diagram titles each stage in the head; a stepped grid keeps its own title there.
  const caption = block.querySelector(".diagram-stage-caption");
  if (caption && chips.length) caption.textContent = chips[current]?.dataset.title ?? "";
  const previous = block.querySelector<HTMLButtonElement>('.diagram-stage-step[data-step="-1"]');
  const next = block.querySelector<HTMLButtonElement>('.diagram-stage-step[data-step="1"]');
  if (previous) previous.disabled = current === 0;
  if (next) next.disabled = current === count - 1;
  centerWideDiagram(block);
}

/** Fired on a staged diagram when its Enlarge button is pressed; `detail.stage` is the stage shown. */
export const DIAGRAM_ENLARGE_EVENT = "margin-diagram-enlarge";

const STAGED_BLOCK_SELECTOR = ".message-mermaid-block.is-staged, .stepgrid-block.is-staged";
const REPLAY_STEP_MS = 1100;
const replays = new WeakMap<HTMLElement, number>();

function stopReplay(block: HTMLElement) {
  const timer = replays.get(block);
  if (timer != null) window.clearInterval(timer);
  replays.delete(block);
  block.classList.remove("is-replaying");
}

/** Replay: back to the first step, then one step forward every second or so until the last. */
export function replayDiagramStages(block: HTMLElement) {
  stopReplay(block);
  showDiagramStage(block, 0);
  const count = block.querySelectorAll(".diagram-stage-view").length;
  if (count < 2) return;
  block.classList.add("is-replaying");
  replays.set(block, window.setInterval(() => {
    const next = Number(block.dataset.stage ?? 0) + 1;
    if (!block.isConnected || next >= count) { stopReplay(block); return; }
    showDiagramStage(block, next);
    if (next === count - 1) stopReplay(block);
  }, REPLAY_STEP_MS));
}

/**
 * The plain full-screen view for panels with no viewer of their own: the stage on screen, as large
 * as the window allows (scrolling when it is larger still). Esc, the close button or a click on the
 * backdrop closes it.
 */
export function openDiagramOverlay(block: HTMLElement) {
  const svg = block.querySelector<SVGSVGElement>(".diagram-stage-view.is-current svg, .message-mermaid-diagram > svg");
  if (!svg) return;
  const width = svg.viewBox.baseVal?.width || svg.getBoundingClientRect().width;
  const picture = svg.cloneNode(true) as SVGSVGElement;
  picture.removeAttribute("style");
  // Fill the window, but no more than twice Mermaid's own size and never below the readable floor.
  picture.style.cssText = `display:block;height:auto;margin:auto;width:min(${Math.round(width * 2)}px, 100%);min-width:${Math.round(width * MIN_DIAGRAM_SCALE)}px;max-width:none;`;
  const overlay = document.createElement("div");
  overlay.className = "diagram-overlay";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute("aria-label", "Diagram");
  const frame = document.createElement("div");
  frame.className = "diagram-overlay-frame";
  const title = block.querySelector(".diagram-stage-caption")?.textContent?.trim();
  const head = document.createElement("div");
  head.className = "diagram-overlay-head";
  head.textContent = title ?? "";
  const close = document.createElement("button");
  close.type = "button";
  close.className = "diagram-overlay-close";
  close.setAttribute("aria-label", "Close");
  close.textContent = "×";
  head.append(close);
  const body = document.createElement("div");
  body.className = "diagram-overlay-body";
  body.append(picture);
  frame.append(head, body);
  overlay.append(frame);
  const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const dismiss = () => {
    overlay.remove();
    document.removeEventListener("keydown", onKey, true);
    previous?.focus({ preventScroll: true });
  };
  const onKey = (event: KeyboardEvent) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    dismiss();
  };
  overlay.addEventListener("click", (event) => { if (event.target === overlay || (event.target as Element).closest(".diagram-overlay-close")) dismiss(); });
  document.addEventListener("keydown", onKey, true);
  document.body.append(overlay);
  if (body.scrollWidth > body.clientWidth) body.scrollLeft = (body.scrollWidth - body.clientWidth) / 2;
  close.focus({ preventScroll: true });
}

let stageControlsInstalled = false;
/**
 * The stepper lives in rendered Markdown, so one listener on the page works every panel. It runs
 * before the editor's own handlers, so a click on a stage never opens the diagram's source.
 */
export function installStageControls() {
  if (stageControlsInstalled || typeof document === "undefined") return;
  stageControlsInstalled = true;
  const target = (event: Event) => event.target instanceof Element ? event.target.closest<HTMLButtonElement>(".diagram-stages button") : null;
  document.addEventListener("mousedown", (event) => {
    if (!target(event)) return;
    event.preventDefault();
    event.stopPropagation();
  }, true);
  document.addEventListener("click", (event) => {
    const button = target(event);
    const block = button?.closest<HTMLElement>(STAGED_BLOCK_SELECTOR);
    if (!button || !block) return;
    event.preventDefault();
    event.stopPropagation();
    if (button.disabled) return;
    if (button.dataset.replay) { replayDiagramStages(block); return; }
    if (button.dataset.enlarge) {
      // Whoever draws this panel opens its full-screen viewer (MarkdownMessage listens).
      const handled = !block.dispatchEvent(new CustomEvent(DIAGRAM_ENLARGE_EVENT, { bubbles: true, cancelable: true, detail: { stage: Number(block.dataset.stage ?? 0) } }));
      if (!handled) openDiagramOverlay(block);
      return;
    }
    stopReplay(block);
    const current = Number(block.dataset.stage ?? 0);
    showDiagramStage(block, button.dataset.stageIndex != null ? Number(button.dataset.stageIndex) : current + Number(button.dataset.step ?? 0));
  }, true);
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
      await drawMermaidBlock(mermaid, block, diagram, source, `mermaid-static-${nextStaticRenderId}`);
      if (isCancelled()) return changed;
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
