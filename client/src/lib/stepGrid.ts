/**
 * Stepped grid diagrams: a table of cells that fills in step by step, with arrows showing where each
 * value comes from (dynamic programming tables, matrix steps, an array being sorted, a game board).
 *
 * The AI writes one ```stepgrid fence holding JSON in the shape below. The app checks it here and
 * draws it itself as SVG, so a reply can never run code or break the page: anything outside the
 * shape is dropped or clamped, and a grid that can't be read shows its source instead.
 *
 *   {
 *     "title": "Ways to reach each cell", "subtitle": "Move only right or down.",
 *     "rows": 3, "cols": 3, "rowLabels": ["0", "1", "2"], "colLabels": ["0", "1", "2"],
 *     "steps": [
 *       { "caption": "Edges have one way each.", "set": [[0, 0, 1], [0, 1, 1], [1, 0, 1]] },
 *       { "caption": "Above + left.", "set": [[1, 1, 2]], "focus": [[1, 1]],
 *         "arrows": [{ "from": [0, 1], "to": [1, 1] }, { "from": [1, 0], "to": [1, 1] }] }
 *     ]
 *   }
 *
 * Values a step sets stay in later steps; `grid` (a full rows × cols array) replaces them all.
 * `focus` and `arrows` belong to their own step only.
 */

export type GridCell = [row: number, col: number];

export interface StepGridArrow { from: GridCell; to: GridCell; label?: string }

export interface StepGridStep {
  caption: string;
  /** Every cell's value at this step, after earlier steps' values carry over. */
  values: string[][];
  /** Cells whose value changed in this step. */
  changed: GridCell[];
  focus: GridCell[];
  arrows: StepGridArrow[];
}

export interface StepGrid {
  title: string;
  subtitle: string;
  rows: number;
  cols: number;
  rowLabels: string[];
  colLabels: string[];
  steps: StepGridStep[];
}

export const STEP_GRID_LIMITS = { size: 12, steps: 16, value: 12, label: 10, title: 80, caption: 240, arrows: 12 } as const;

const STEP_GRID_LANGUAGES = new Set(["stepgrid", "step-grid"]);

export function isStepGridLanguage(language: string | undefined) {
  return STEP_GRID_LANGUAGES.has(language?.trim().toLowerCase().split(/\s+/, 1)[0] ?? "");
}

function text(value: unknown, max: number): string {
  if (typeof value === "number" && Number.isFinite(value)) return String(value).slice(0, max);
  if (typeof value !== "string") return "";
  return value.replace(/\s+/g, " ").trim().slice(0, max);
}

function count(value: unknown): number {
  const number = typeof value === "string" ? Number(value) : value;
  return typeof number === "number" && Number.isInteger(number) ? number : 0;
}

function cellOf(value: unknown, rows: number, cols: number): GridCell | null {
  if (!Array.isArray(value) || value.length < 2) return null;
  const row = count(value[0]);
  const col = count(value[1]);
  return row >= 0 && row < rows && col >= 0 && col < cols && Number.isInteger(Number(value[0])) && Number.isInteger(Number(value[1])) ? [row, col] : null;
}

function cellsOf(value: unknown, rows: number, cols: number, max = rows * cols): GridCell[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value.flatMap((item) => {
    const cell = cellOf(item, rows, cols);
    if (!cell || seen.has(cell.join())) return [];
    seen.add(cell.join());
    return [cell];
  }).slice(0, max);
}

function labelsOf(value: unknown, length: number): string[] {
  if (!Array.isArray(value)) return [];
  const labels = value.slice(0, length).map((item) => text(item, STEP_GRID_LIMITS.label));
  return labels.some(Boolean) ? [...labels, ...Array(Math.max(0, length - labels.length)).fill("")] : [];
}

/** The rows × cols size of a grid that gave only its `grid` arrays. */
function inferredSize(steps: unknown[]): { rows: number; cols: number } {
  for (const step of steps) {
    const grid = step && typeof step === "object" ? (step as { grid?: unknown }).grid : null;
    if (Array.isArray(grid) && grid.length) {
      return { rows: grid.length, cols: Math.max(...grid.map((row) => Array.isArray(row) ? row.length : 0)) };
    }
  }
  return { rows: 0, cols: 0 };
}

/** A stepped grid read from JSON text (or an already parsed value), or null when it isn't one. */
export function parseStepGrid(source: unknown): StepGrid | null {
  let raw: unknown = source;
  if (typeof source === "string") {
    try { raw = JSON.parse(source); } catch { return null; }
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const input = raw as Record<string, unknown>;
  const rawSteps = Array.isArray(input.steps) ? input.steps.slice(0, STEP_GRID_LIMITS.steps) : [];
  if (!rawSteps.length) return null;
  const inferred = inferredSize(rawSteps);
  const rows = Math.min(STEP_GRID_LIMITS.size, count(input.rows) || inferred.rows);
  const cols = Math.min(STEP_GRID_LIMITS.size, count(input.cols ?? input.columns) || inferred.cols);
  if (rows < 1 || cols < 1) return null;

  let values: string[][] = Array.from({ length: rows }, () => Array<string>(cols).fill(""));
  const steps: StepGridStep[] = rawSteps.map((item, index) => {
    const step = item && typeof item === "object" && !Array.isArray(item) ? item as Record<string, unknown> : {};
    const next = values.map((row) => [...row]);
    if (Array.isArray(step.grid)) {
      for (let row = 0; row < rows; row += 1) {
        const line = Array.isArray(step.grid[row]) ? step.grid[row] as unknown[] : [];
        for (let col = 0; col < cols; col += 1) next[row][col] = text(line[col], STEP_GRID_LIMITS.value);
      }
    }
    if (Array.isArray(step.set)) {
      for (const entry of step.set) {
        const cell = cellOf(entry, rows, cols);
        if (cell && Array.isArray(entry)) next[cell[0]][cell[1]] = text(entry[2], STEP_GRID_LIMITS.value);
      }
    }
    const changed: GridCell[] = [];
    next.forEach((row, r) => row.forEach((value, c) => { if (value !== values[r][c]) changed.push([r, c]); }));
    values = next;
    const arrows = (Array.isArray(step.arrows) ? step.arrows : []).flatMap((arrow): StepGridArrow[] => {
      if (!arrow || typeof arrow !== "object") return [];
      const { from, to, label } = arrow as Record<string, unknown>;
      const start = cellOf(from, rows, cols);
      const end = cellOf(to, rows, cols);
      if (!start || !end || start.join() === end.join()) return [];
      const words = text(label, STEP_GRID_LIMITS.label);
      return [{ from: start, to: end, ...(words ? { label: words } : {}) }];
    }).slice(0, STEP_GRID_LIMITS.arrows);
    return {
      caption: text(step.caption ?? step.title, STEP_GRID_LIMITS.caption) || `Step ${index + 1}`,
      values, changed, focus: cellsOf(step.focus ?? step.highlight, rows, cols), arrows,
    };
  });

  return {
    title: text(input.title, STEP_GRID_LIMITS.title),
    subtitle: text(input.subtitle, STEP_GRID_LIMITS.caption),
    rows, cols,
    rowLabels: labelsOf(input.rowLabels, rows),
    colLabels: labelsOf(input.colLabels ?? input.columnLabels, cols),
    steps,
  };
}

/** Where a ```stepgrid fence sits in Markdown, and its JSON. */
const STEP_GRID_FENCE = /^[ \t]{0,3}(`{3,}|~{3,})[ \t]*step-?grid[ \t]*\n([\s\S]*?)^[ \t]{0,3}\1[ \t]*$/im;

/**
 * A Visualize reply as one ```stepgrid fence, when it holds a grid this app can draw: from a stepgrid
 * fence, a json fence, or bare JSON. The grid is written back tidied, so the document keeps only what
 * is drawn. Null when the reply has no readable grid (the caller then treats it as a Mermaid diagram).
 */
export function stepGridReply(reply: string): string | null {
  const fenced = STEP_GRID_FENCE.exec(reply)?.[2]
    ?? /^[ \t]{0,3}(`{3,}|~{3,})[ \t]*json[ \t]*\n([\s\S]*?)^[ \t]{0,3}\1[ \t]*$/im.exec(reply)?.[2];
  const candidate = fenced ?? (() => {
    const start = reply.indexOf("{");
    const end = reply.lastIndexOf("}");
    return start >= 0 && end > start ? reply.slice(start, end + 1) : "";
  })();
  const grid = parseStepGrid(candidate);
  return grid ? `\`\`\`stepgrid\n${serializeStepGrid(grid)}\n\`\`\`` : null;
}

/** A grid back as compact JSON in the fence's shape, one step per line so the file stays readable. */
export function serializeStepGrid(grid: StepGrid): string {
  const head: Record<string, unknown> = {};
  if (grid.title) head.title = grid.title;
  if (grid.subtitle) head.subtitle = grid.subtitle;
  head.rows = grid.rows;
  head.cols = grid.cols;
  if (grid.rowLabels.length) head.rowLabels = grid.rowLabels;
  if (grid.colLabels.length) head.colLabels = grid.colLabels;
  const steps = grid.steps.map((step) => {
    const out: Record<string, unknown> = { caption: step.caption };
    if (step.changed.length) out.set = step.changed.map(([row, col]) => [row, col, step.values[row][col]]);
    if (step.focus.length) out.focus = step.focus;
    if (step.arrows.length) out.arrows = step.arrows;
    return `    ${JSON.stringify(out)}`;
  });
  const fields = Object.entries(head).map(([name, value]) => `  ${JSON.stringify(name)}: ${JSON.stringify(value)},`);
  return `{\n${fields.join("\n")}\n  "steps": [\n${steps.join(",\n")}\n  ]\n}`;
}

function escapeHtml(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

const CELL = 56;
const LABEL = 28;

/** One step's picture: the grid, the cells it changed, its focus cells and its arrows. */
function stepSvg(grid: StepGrid, step: StepGridStep, stepIndex: number): string {
  const left = grid.rowLabels.length ? LABEL : 0;
  const top = grid.colLabels.length ? LABEL : 0;
  const width = left + grid.cols * CELL + 2;
  const height = top + grid.rows * CELL + 2;
  const key = (cell: GridCell) => cell.join();
  const changed = new Set(step.changed.map(key));
  const focus = new Set(step.focus.map(key));
  const centre = ([row, col]: GridCell) => ({ x: 1 + left + col * CELL + CELL / 2, y: 1 + top + row * CELL + CELL / 2 });
  const parts: string[] = [
    `<svg class="stepgrid-svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="${escapeHtml(`Step ${stepIndex + 1}: ${step.caption}`)}">`,
  ];
  grid.colLabels.forEach((label, col) => {
    if (label) parts.push(`<text class="stepgrid-label" x="${1 + left + col * CELL + CELL / 2}" y="${top - 9}">${escapeHtml(label)}</text>`);
  });
  grid.rowLabels.forEach((label, row) => {
    if (label) parts.push(`<text class="stepgrid-label" x="${left / 2}" y="${1 + top + row * CELL + CELL / 2}">${escapeHtml(label)}</text>`);
  });
  for (let row = 0; row < grid.rows; row += 1) {
    for (let col = 0; col < grid.cols; col += 1) {
      const id = `${row},${col}`;
      const classes = ["stepgrid-cell", changed.has(id) ? "is-changed" : "", focus.has(id) ? "is-focus" : "", step.values[row][col] ? "" : "is-empty"].filter(Boolean).join(" ");
      const x = 1 + left + col * CELL;
      const y = 1 + top + row * CELL;
      parts.push(`<g class="${classes}"><rect x="${x}" y="${y}" width="${CELL}" height="${CELL}" rx="2"></rect>`);
      if (step.values[row][col]) parts.push(`<text x="${x + CELL / 2}" y="${y + CELL / 2}">${escapeHtml(step.values[row][col])}</text>`);
      parts.push("</g>");
    }
  }
  parts.push(`<rect class="stepgrid-frame" x="${1 + left}" y="${1 + top}" width="${grid.cols * CELL}" height="${grid.rows * CELL}" rx="6"></rect>`);
  step.arrows.forEach((arrow, index) => {
    const a = centre(arrow.from);
    const b = centre(arrow.to);
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const length = Math.hypot(dx, dy);
    const ux = dx / length;
    const uy = dy / length;
    // Start past the source's value and stop short of the target's, so the arrow sits between them.
    const gap = CELL * 0.3;
    const sx = a.x + ux * gap;
    const sy = a.y + uy * gap;
    const ex = b.x - ux * gap;
    const ey = b.y - uy * gap;
    const head = 6;
    const wing = (sign: number) => `${(ex - ux * head * 1.4 - uy * head * sign).toFixed(1)},${(ey - uy * head * 1.4 + ux * head * sign).toFixed(1)}`;
    parts.push(`<g class="stepgrid-arrow" style="animation-delay:${index * 120}ms">`,
      `<line x1="${sx.toFixed(1)}" y1="${sy.toFixed(1)}" x2="${(ex - ux * 2).toFixed(1)}" y2="${(ey - uy * 2).toFixed(1)}"></line>`,
      `<polygon points="${ex.toFixed(1)},${ey.toFixed(1)} ${wing(1)} ${wing(-1)}"></polygon>`);
    if (arrow.label) {
      parts.push(`<text class="stepgrid-arrow-label" x="${((sx + ex) / 2 - uy * 14).toFixed(1)}" y="${((sy + ey) / 2 + ux * 14).toFixed(1)}">${escapeHtml(arrow.label)}</text>`);
    }
    parts.push("</g>");
  });
  parts.push("</svg>");
  return parts.join("");
}

/**
 * A stepped grid as HTML for rendered Markdown: a stepper (‹ Step 1/4 › and replay) over every step's
 * picture, stacked in one place so the panel keeps its tallest step's height. The page-wide stepper
 * listener in mermaidDiagrams.ts moves between them.
 */
export function renderStepGridHtml(grid: StepGrid): string {
  const count = grid.steps.length;
  const many = count > 1;
  return [
    `<div class="stepgrid-block${many ? " is-staged" : ""}" data-language="stepgrid" data-stage="0">`,
    many ? [
      '<div class="diagram-stages" role="group" aria-label="Grid steps">',
      '<div class="diagram-stage-head">',
      '<button type="button" class="diagram-stage-step" data-step="-1" aria-label="Previous step" disabled>‹</button>',
      `<span class="diagram-stage-count">Step <span class="diagram-stage-number">1</span>/${count}</span>`,
      '<button type="button" class="diagram-stage-step" data-step="1" aria-label="Next step">›</button>',
      grid.title ? `<span class="diagram-stage-caption stepgrid-title">${escapeHtml(grid.title)}</span>` : '<span class="diagram-stage-caption"></span>',
      '<button type="button" class="diagram-stage-step diagram-stage-replay" data-replay="true" aria-label="Play the steps from the start" title="Replay">↻</button>',
      "</div>",
      "</div>",
    ].join("") : grid.title ? `<div class="diagram-stages"><div class="diagram-stage-head"><span class="diagram-stage-caption stepgrid-title">${escapeHtml(grid.title)}</span></div></div>` : "",
    grid.subtitle ? `<p class="stepgrid-subtitle">${escapeHtml(grid.subtitle)}</p>` : "",
    '<div class="stepgrid-views">',
    ...grid.steps.map((step, index) => [
      `<figure class="diagram-stage-view${index === 0 ? " is-current" : ""}" data-caption="${escapeHtml(step.caption)}">`,
      stepSvg(grid, step, index),
      `<figcaption class="stepgrid-caption">${escapeHtml(step.caption)}</figcaption>`,
      "</figure>",
    ].join("")),
    "</div>",
    "</div>",
  ].join("");
}

/** What a ```stepgrid fence shows in rendered Markdown: the grid, or its source with a note when it can't be read. */
export function renderStepGridFence(source: string): string {
  const grid = parseStepGrid(source);
  if (grid) return renderStepGridHtml(grid);
  return [
    '<div class="stepgrid-block has-error" data-language="stepgrid">',
    `<pre class="message-code-block" data-language="json"><code>${escapeHtml(source)}</code></pre>`,
    // A grid still streaming in has no closing brace yet.
    source.trim().endsWith("}")
      ? '<p class="message-mermaid-status">This step grid couldn\'t be drawn, so its source is shown instead.</p>'
      : '<p class="message-mermaid-status">Drawing the step grid…</p>',
    "</div>",
  ].join("");
}
