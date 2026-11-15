import type { HtmlScreen } from "./htmlDocuments";

/**
 * Play reads what an open HTML page shows right now, so a moment note or a question to AI is about
 * the screen in front of you. Each page that is open registers how to read it; there is at most one
 * reader per document.
 */
type ScreenReader = () => Promise<HtmlScreen | null>;
const readers = new Map<string, ScreenReader>();

export function registerHtmlScreen(documentId: string, reader: ScreenReader) {
  readers.set(documentId, reader);
  return () => { if (readers.get(documentId) === reader) readers.delete(documentId); };
}

/** The page's screen now, or null when it isn't open or doesn't answer in time. */
export async function readHtmlScreen(documentId: string): Promise<HtmlScreen | null> {
  const reader = readers.get(documentId);
  if (!reader) return null;
  try { return await reader(); } catch { return null; }
}

/** The screen's words in view, cut at a word near `max` characters, for a note's quote or title. */
export function screenExcerpt(screen: HtmlScreen, max: number) {
  const text = (screen.visible || screen.page).replace(/\s+/gu, " ").trim();
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/** A moment note: the screen as a quote, then room to write. */
export function momentNoteContent(screen: HtmlScreen) {
  const lines = (screen.visible || screen.page).split("\n").map((line) => line.trim()).filter(Boolean);
  let quoted = "";
  for (const line of lines) {
    if (quoted.length + line.length > 360) { quoted += "> …\n"; break; }
    quoted += `> ${line}\n`;
  }
  const typed = screen.fields.filter((field) => field.value.trim()).slice(0, 3)
    .map((field) => `**${field.label || "Typed"}:**\n\n\`\`\`\n${field.value.slice(0, 1_500)}\n\`\`\`\n`).join("\n");
  return `${quoted || "> (Nothing to read on screen)\n"}${typed ? `\n${typed}` : ""}\n`;
}
