import type { PDFDocumentProxy } from "pdfjs-dist";
import { pdfPageText } from "./vaultFileDocuments";

type Pdfjs = typeof import("pdfjs-dist");

let pdfjs: Promise<Pdfjs> | null = null;

/**
 * pdf.js loads the first time a PDF opens, with its worker beside it. The
 * legacy build carries polyfills for browser features newer than Safari and
 * the desktop app's Chromium (such as Map.getOrInsertComputed).
 */
export function loadPdfjs(): Promise<Pdfjs> {
  pdfjs ??= Promise.all([import("pdfjs-dist/legacy/build/pdf.mjs") as Promise<Pdfjs>, import("pdfjs-dist/legacy/build/pdf.worker.min.mjs?url")]).then(([module, worker]) => {
    module.GlobalWorkerOptions.workerSrc = worker.default;
    return module;
  }).catch((error) => {
    pdfjs = null;
    throw error;
  });
  return pdfjs;
}

export interface OpenedPdf {
  pdf: PDFDocumentProxy;
  /** Frees the document and its worker. */
  close(): void;
}

export async function openPdf(blob: Blob): Promise<OpenedPdf> {
  const module = await loadPdfjs();
  const task = module.getDocument({ data: new Uint8Array(await blob.arrayBuffer()) });
  try {
    return { pdf: await task.promise, close: () => void task.destroy() };
  } catch (error) {
    void task.destroy();
    throw error;
  }
}

const textCache = new Map<string, Promise<string[]>>();
const TEXT_CACHE_LIMIT = 8;

/** Each page's text, as the viewer's text layer shows it. Kept for the last few files read. */
export function readPdfPages(key: string, blob: Blob): Promise<string[]> {
  const cacheKey = `${key}\0${blob.size}`;
  let pages = textCache.get(cacheKey);
  if (!pages) {
    pages = (async () => {
      const { pdf, close } = await openPdf(blob);
      try {
        const texts: string[] = [];
        for (let number = 1; number <= pdf.numPages; number += 1) {
          const page = await pdf.getPage(number);
          texts.push(pdfPageText((await page.getTextContent()).items as Array<{ str?: string; hasEOL?: boolean }>));
          page.cleanup();
        }
        return texts;
      } finally {
        close();
      }
    })();
    pages.catch(() => textCache.delete(cacheKey));
    textCache.set(cacheKey, pages);
    while (textCache.size > TEXT_CACHE_LIMIT) textCache.delete(textCache.keys().next().value!);
  }
  return pages;
}
