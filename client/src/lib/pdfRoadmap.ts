import type { AgentRoadmapProposal } from "../types";
import { flattenPdfOutline, type PdfOutlineEntry } from "./pdfOutline";

/** More steps than this would bury the roadmap; chapters become the steps instead of their sections. */
export const PDF_ROADMAP_MAX_STEPS = 150;

/** Front and back matter a reader doesn't study: left off the roadmap. */
const SKIPPED = /^(?:cover|front cover|back cover|title(?: page)?|half title|copyright(?: page)?|dedication|(?:table of )?contents|index|list of (?:figures|tables|illustrations)|about the authors?|also by .*)$/iu;

/** What an open PDF hands over to make a roadmap: its contents, or its first pages' text when it has none. */
export interface PdfRoadmapSource {
  outline: PdfOutlineEntry[];
  labels: string[] | null;
  pageCount: number;
  /** Each of the first pages' text, read only for a PDF without contents of its own. */
  firstPages: string[] | null;
}

const NOTES_LIMIT = 2_000;

function cleanTitle(title: string) {
  return title.replace(/\s+/gu, " ").trim().slice(0, 200);
}

/** The roadmap's name for a PDF: its title without the file extension, as "Name roadmap". */
export function pdfRoadmapTitle(pdfTitle: string) {
  return `${pdfTitle.trim().replace(/\.pdf$/iu, "").trim() || "PDF"} roadmap`;
}

/**
 * A link that opens the PDF at a page. Obsidian writes PDF page links the same way,
 * so the roadmap still works when the vault is opened there.
 */
export function pdfPageLink(pdfTitle: string, page: number, label: string) {
  const safe = label.replace(/[[\]|]/gu, " ").replace(/\s+/gu, " ").trim();
  return `[[${pdfTitle}#page=${page}|${safe || `page ${page}`}]]`;
}

/** The page a `#page=N` link asks for, or null when it names none. */
export function pdfPageFromLinkTarget(target: string): number | null {
  const match = /#page=(\d+)\s*$/iu.exec(target);
  const page = match ? Number(match[1]) : NaN;
  return Number.isInteger(page) && page > 0 ? page : null;
}

interface Options {
  roadmapId: string;
  roadmapTitle: string;
  /** The PDF document's title, which page links name. */
  pdfTitle: string;
  pageCount: number;
  /** The page numbers printed in the book, when the PDF has its own. */
  labels?: string[] | null;
}

/**
 * The roadmap a PDF's own contents (its bookmarks) lay out, as a draft: the top
 * entries are the stages and the ones inside them the steps, each step a new
 * document saying which pages it covers, with a link that opens the PDF there,
 * and needing the step before it. Null when the contents hold nothing to study.
 */
export function pdfOutlineRoadmapProposal(outline: PdfOutlineEntry[], options: Options): AgentRoadmapProposal | null {
  const kept = (entries: PdfOutlineEntry[]) => entries.filter((entry) => cleanTitle(entry.title) && !SKIPPED.test(cleanTitle(entry.title)));
  let roots = kept(outline);
  // A book whose contents sit inside one entry (its own title) starts one level down.
  while (roots.length === 1 && kept(roots[0].items).length) roots = kept(roots[0].items);
  if (!roots.length) return null;

  // Where each entry ends: just before the next entry in reading order that starts on a later page.
  const order = flattenPdfOutline(outline).map((item) => item.entry);
  const endOf = (entry: PdfOutlineEntry) => {
    if (entry.page === null) return null;
    const at = order.indexOf(entry);
    const inside = new Set(flattenPdfOutline(entry.items).map((item) => item.entry));
    const next = order.slice(at + 1).find((other) => !inside.has(other) && other.page !== null && other.page > entry.page!);
    return Math.max(entry.page, next ? next.page! - 1 : options.pageCount);
  };
  const label = (page: number) => options.labels?.[page - 1] || String(page);
  const pages = (entry: PdfOutlineEntry) => {
    if (entry.page === null) return "";
    const end = endOf(entry) ?? entry.page;
    return end > entry.page ? `pages ${label(entry.page)}–${label(end)}` : `page ${label(entry.page)}`;
  };

  const notesFor = (entry: PdfOutlineEntry) => {
    const lines: string[] = [];
    const range = pages(entry);
    if (entry.page !== null) lines.push(`Read ${pdfPageLink(options.pdfTitle, entry.page, range)} of ${options.pdfTitle}.`);
    const walk = (items: PdfOutlineEntry[], depth: number) => {
      for (const item of kept(items)) {
        const title = cleanTitle(item.title);
        lines.push(`${"  ".repeat(depth)}- ${item.page !== null ? pdfPageLink(options.pdfTitle, item.page, title) : title}${item.page !== null ? ` (p. ${label(item.page)})` : ""}`);
        walk(item.items, depth + 1);
      }
    };
    walk(entry.items, 0);
    let notes = "";
    for (const line of lines) {
      const next = notes ? `${notes}\n${line}` : line;
      if (next.length > NOTES_LIMIT) break;
      notes = next;
    }
    return notes;
  };

  let count = 0;
  let previous: string | null = null;
  const step = (entry: PdfOutlineEntry) => {
    const key = `s${count += 1}`;
    const made = { key, title: cleanTitle(entry.title), notes: notesFor(entry), needs: previous ? [previous] : [] };
    previous = key;
    return made;
  };

  const sectioned = roots.some((root) => kept(root.items).length);
  const sections = roots.reduce((sum, root) => sum + Math.max(1, kept(root.items).length), 0);
  const stages: AgentRoadmapProposal["stages"] = [];
  if (sectioned && sections <= PDF_ROADMAP_MAX_STEPS) {
    // Each top entry is a stage of its sections; one with no sections is a stage of itself.
    for (const root of roots) {
      const inside = kept(root.items);
      stages.push({ title: cleanTitle(root.title), steps: (inside.length ? inside : [root]).map(step) });
    }
  } else {
    // A flat contents list, or one too long to make each section a step: each top entry is a step.
    stages.push({ title: "Contents", steps: roots.slice(0, PDF_ROADMAP_MAX_STEPS).map(step) });
  }
  return { id: "proposal-1", kind: "roadmap", roadmapId: options.roadmapId, roadmapTitle: options.roadmapTitle,
    goal: options.roadmapTitle, summary: `Made from the contents of ${options.pdfTitle}.`, stages };
}

/**
 * What Draft with AI is asked when a PDF has no contents (bookmarks) of its own:
 * to lay out the roadmap from the table of contents printed on its first pages.
 */
export function pdfContentsDraftGoal(pdfTitle: string, firstPages: string[]) {
  let text = "";
  for (const [index, page] of firstPages.entries()) {
    const body = page.replace(/[ \t]+/gu, " ").replace(/\n{3,}/gu, "\n\n").trim();
    if (!body) continue;
    const next = `${text}${text ? "\n\n" : ""}[Page ${index + 1}]\n${body}`;
    if (next.length > 8_000) { text = next.slice(0, 8_000); break; }
    text = next;
  }
  return `the PDF "${pdfTitle}", one stage per part or chapter of its table of contents and one step per section, in the book's own order and words.${text
    ? ` Its first pages, which hold its table of contents, read:\n\n${text}` : ""}`;
}
