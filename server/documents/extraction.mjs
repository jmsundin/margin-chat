import { extname } from "node:path";
import { HttpError } from "../lib/errors.mjs";

export const MAX_DOCUMENT_BYTES = 4 * 1024 * 1024;
export const MAX_EXTRACTED_CHARACTERS = 2_000_000;

const TEXT_EXTENSIONS = new Set([
  ".c",
  ".cpp",
  ".css",
  ".csv",
  ".go",
  ".html",
  ".htm",
  ".java",
  ".js",
  ".json",
  ".jsx",
  ".log",
  ".md",
  ".markdown",
  ".mjs",
  ".py",
  ".rb",
  ".rs",
  ".sql",
  ".svg",
  ".ts",
  ".tsx",
  ".txt",
  ".xml",
  ".yaml",
  ".yml",
]);

const HTML_EXTENSIONS = new Set([".html", ".htm"]);

function normalizeExtractedText(value) {
  return value
    .replace(/\r\n?/gu, "\n")
    .replace(/[\t\f\v]+/gu, " ")
    .replace(/ {3,}/gu, "  ")
    .replace(/\n{4,}/gu, "\n\n\n")
    .trim();
}

function decodeBasicHtmlEntities(value) {
  return value
    .replace(/&nbsp;/giu, " ")
    .replace(/&amp;/giu, "&")
    .replace(/&lt;/giu, "<")
    .replace(/&gt;/giu, ">")
    .replace(/&quot;/giu, '"')
    .replace(/&#39;/giu, "'")
    .replace(/&#(\d+);/gu, (_match, value) =>
      String.fromCodePoint(Number(value)),
    );
}

function htmlToText(value) {
  return decodeBasicHtmlEntities(
    value
      .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/giu, " ")
      .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr)>/giu, "\n")
      .replace(/<[^>]+>/gu, " "),
  );
}

async function extractPdf(buffer) {
  // Import the parser implementation directly. The package's CommonJS entry
  // treats ESM imports as a debug invocation and tries to read its own fixture.
  const module = await import("pdf-parse/lib/pdf-parse.js");
  const parsePdf = module.default ?? module;
  const pages = [];

  await parsePdf(buffer, {
    pagerender: async (page) => {
      const textContent = await page.getTextContent({
        disableCombineTextItems: false,
        normalizeWhitespace: false,
      });
      let previousY = null;
      let text = "";

      for (const item of textContent.items ?? []) {
        const currentY = item.transform?.[5] ?? null;

        if (previousY !== null && currentY !== null && currentY !== previousY) {
          text += "\n";
        } else if (text && !text.endsWith("\n")) {
          text += " ";
        }

        text += item.str ?? "";
        previousY = currentY;
      }

      pages.push(normalizeExtractedText(text));
      return text;
    },
  });

  return pages
    .map((content, index) => ({ content, pageNumber: index + 1 }))
    .filter((page) => page.content);
}

async function extractDocx(buffer) {
  const module = await import("mammoth");
  const mammoth = module.default ?? module;
  const result = await mammoth.extractRawText({ buffer });

  return [{ content: normalizeExtractedText(result.value), pageNumber: null }];
}

function assertExtractedSections(sections) {
  const characters = sections.reduce(
    (total, section) => total + section.content.length,
    0,
  );

  if (!characters) {
    throw new HttpError(422, "The uploaded file did not contain extractable text.");
  }

  if (characters > MAX_EXTRACTED_CHARACTERS) {
    throw new HttpError(
      413,
      "The extracted document is too large. Keep documents under 2,000,000 characters.",
    );
  }

  return sections;
}

export async function extractDocumentText({ buffer, filename, mimeType }) {
  const extension = extname(filename).toLowerCase();

  if (extension === ".pdf" || mimeType === "application/pdf") {
    return assertExtractedSections(await extractPdf(buffer));
  }

  if (
    extension === ".docx" ||
    mimeType ===
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  ) {
    return assertExtractedSections(await extractDocx(buffer));
  }

  if (TEXT_EXTENSIONS.has(extension) || mimeType.startsWith("text/")) {
    const rawText = buffer.toString("utf8");
    const content = normalizeExtractedText(
      HTML_EXTENSIONS.has(extension) || mimeType === "text/html"
        ? htmlToText(rawText)
        : rawText,
    );

    return assertExtractedSections([{ content, pageNumber: null }]);
  }

  throw new HttpError(
    415,
    "Unsupported document type. Upload PDF, DOCX, text, Markdown, CSV, JSON, HTML, XML, or a source-code file.",
  );
}
