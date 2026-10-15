import type { PDFDocumentProxy } from "pdfjs-dist";

/** One entry of a PDF's own table of contents (its bookmarks). */
export interface PdfOutlineEntry {
  id: string;
  title: string;
  /** The page it opens, counted from 1; null when the entry points nowhere in this file. */
  page: number | null;
  /** How far down the page it starts, in PDF units from the page's bottom edge, when the PDF says. */
  top: number | null;
  bold: boolean;
  italic: boolean;
  items: PdfOutlineEntry[];
}

type OutlineSource = Pick<PDFDocumentProxy, "numPages" | "getOutline" | "getDestination" | "getPageIndex">;
type OutlineNode = Awaited<ReturnType<PDFDocumentProxy["getOutline"]>>[number];

/** Where a bookmark's destination lands: a page and, for most destination kinds, a height on it. */
export async function pdfDestinationTarget(pdf: OutlineSource, dest: unknown): Promise<{ page: number; top: number | null } | null> {
  const explicit = typeof dest === "string" ? await pdf.getDestination(dest).catch(() => null) : dest;
  if (!Array.isArray(explicit) || !explicit.length) return null;
  const ref = explicit[0];
  let index: number | null = null;
  if (typeof ref === "number") index = ref;
  else if (ref && typeof ref === "object") index = await pdf.getPageIndex(ref).catch(() => null);
  if (index === null || !Number.isInteger(index) || index < 0 || index >= pdf.numPages) return null;
  const kind = (explicit[1] as { name?: string } | undefined)?.name;
  const top = kind === "XYZ" ? explicit[3] : kind === "FitH" || kind === "FitBH" ? explicit[2] : null;
  return { page: index + 1, top: typeof top === "number" && Number.isFinite(top) ? top : null };
}

/** The PDF's table of contents with each entry's page worked out; empty when the PDF has none. */
export async function readPdfOutline(pdf: OutlineSource): Promise<PdfOutlineEntry[]> {
  const outline = await pdf.getOutline().catch(() => null);
  if (!outline?.length) return [];
  const walk = (nodes: OutlineNode[], prefix: string): Promise<PdfOutlineEntry[]> => Promise.all(nodes.map(async (node, index) => {
    const id = prefix ? `${prefix}.${index}` : String(index);
    const target = node.dest ? await pdfDestinationTarget(pdf, node.dest) : null;
    return {
      id, title: node.title?.trim() || "Untitled", page: target?.page ?? null, top: target?.top ?? null,
      bold: Boolean(node.bold), italic: Boolean(node.italic), items: node.items?.length ? await walk(node.items, id) : [],
    };
  }));
  return walk(outline, "");
}

/** Every entry in reading order, each with the ids of the entries it sits inside. */
export function flattenPdfOutline(entries: PdfOutlineEntry[], parents: string[] = []): Array<{ entry: PdfOutlineEntry; parents: string[] }> {
  return entries.flatMap((entry) => [{ entry, parents }, ...flattenPdfOutline(entry.items, [...parents, entry.id])]);
}

/** The entry the reader is in: the last one that starts on or before the page they are on. */
export function currentPdfOutlineEntry(entries: PdfOutlineEntry[], page: number) {
  let current: { entry: PdfOutlineEntry; parents: string[] } | null = null;
  for (const item of flattenPdfOutline(entries)) {
    if (item.entry.page === null || item.entry.page > page) continue;
    if (!current || item.entry.page >= current.entry.page!) current = item;
  }
  return current;
}
