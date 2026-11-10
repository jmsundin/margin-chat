import type { SqlJsStatic } from "sql.js";
import type { Flashcard } from "./flashcards";
import type { FlashcardReview } from "./flashcardSchedule";
import type { ExportCard } from "./ankiPackage";
import type { VaultMedia } from "./vaultMedia";

/** SQLite (as WebAssembly) and the Anki reader load only when someone imports or exports. */
let sqlite: Promise<SqlJsStatic> | null = null;
function loadSqlite() {
  sqlite ??= Promise.all([import("sql.js"), import("sql.js/dist/sql-wasm.wasm?url")])
    .then(([module, wasm]) => module.default({ locateFile: () => wasm.default }))
    .catch((error: unknown) => { sqlite = null; throw error; });
  return sqlite;
}

export interface AnkiImportResult {
  documents: Array<{ id: string; title: string; markdown: string; cards: Flashcard[] }>;
  reviews: FlashcardReview[];
  suspended: string[];
  skippedNotes: number;
  mediaSaved: number;
  mediaFailed: number;
}

/** Read an .apkg, saving its images and sounds into the vault on the way. */
export async function importAnkiFile(file: File, { media, createId, onProgress }: {
  media: VaultMedia | null;
  createId: () => string;
  onProgress?: (message: string) => void;
}): Promise<AnkiImportResult> {
  onProgress?.("Reading the deck…");
  const [SQL, anki] = await Promise.all([loadSqlite(), import("./ankiPackage")]);
  const collection = anki.readAnkiPackage(new Uint8Array(await file.arrayBuffer()), SQL);
  // Only files a card shows are saved, so a deck with leftover media doesn't fill the vault.
  const used = new Set<string>();
  for (const note of collection.notes) for (const field of note.fields) {
    for (const match of field.matchAll(/<img[^>]*\bsrc\s*=\s*["']?([^"' >]+)/giu)) used.add(decodeURIComponent(match[1]));
    for (const match of field.matchAll(/\[sound:([^\]]+)\]/gu)) used.add(match[1]);
  }
  const embeds = new Map<string, string>();
  let mediaFailed = 0, index = 0;
  for (const [name, bytes] of collection.media) {
    if (!used.has(name)) continue;
    onProgress?.(`Saving images and sounds (${++index} of ${used.size})…`);
    try {
      if (!media) throw new Error("no vault");
      const embed = await media.save(new File([bytes as BlobPart], name, { type: "" }));
      embeds.set(name, embed.trim());
    } catch { mediaFailed++; }
  }
  onProgress?.("Writing cards…");
  const plan = anki.planAnkiImport(collection, { embed: (name) => embeds.get(name) ?? null, createId });
  return { ...plan, mediaSaved: embeds.size, mediaFailed };
}

/** Write cards as an .apkg the person can open in Anki. */
export async function exportAnkiFile(cards: ReadonlyArray<ExportCard>, media: VaultMedia | null): Promise<{ blob: Blob; missingMedia: number }> {
  const [SQL, anki] = await Promise.all([loadSqlite(), import("./ankiPackage")]);
  const files = new Map<string, Uint8Array>();
  let missingMedia = 0;
  const targets = new Set(cards.flatMap(({ card }) => [...anki.cardMediaTargets(card.front), ...anki.cardMediaTargets(card.back), ...anki.cardMediaTargets(card.source ?? "")]));
  for (const target of targets) {
    const file = media ? await media.read(target).catch(() => null) : null;
    if (file) files.set(target, new Uint8Array(await file.blob.arrayBuffer())); else missingMedia++;
  }
  const bytes = await anki.buildAnkiPackage(cards, files, SQL);
  return { blob: new Blob([bytes as BlobPart], { type: "application/octet-stream" }), missingMedia };
}

export function downloadBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
