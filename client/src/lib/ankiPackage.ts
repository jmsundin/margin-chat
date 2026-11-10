import { unzipSync, zipSync } from "fflate";
import { decompress as zstdDecompress } from "fzstd";
import type { Database, SqlJsStatic } from "sql.js";
import { parseFlashcards, type Flashcard } from "./flashcards";
import type { FlashcardReview, FlashcardSchedule } from "./flashcardSchedule";

/**
 * Reading and writing Anki's .apkg files: a zip holding an SQLite collection,
 * the media files, and a list naming them. Imports read the old (collection.anki2),
 * the 2.1 (collection.anki21) and the current compressed format (collection.anki21b).
 * Exports write the old format, which every Anki version still opens.
 */

export interface AnkiNote {
  id: number;
  fields: string[];
  tags: string;
  cloze: boolean;
  cards: Array<{ id: number; ord: number; did: number; queue: number }>;
}

export interface AnkiCollection {
  decks: Map<number, string>;
  notes: AnkiNote[];
  revlog: Array<{ id: number; cid: number; ease: number; type: number; time: number }>;
  media: Map<string, Uint8Array>;
}

const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd];
const isZstd = (bytes: Uint8Array) => ZSTD_MAGIC.every((byte, index) => bytes[index] === byte);
const inflate = (bytes: Uint8Array) => (isZstd(bytes) ? zstdDecompress(bytes) : bytes);

/** The few protobuf fields Anki's media list uses: entries (1) each with a name (1). */
function readMediaEntries(bytes: Uint8Array): string[] {
  const names: string[] = [];
  let offset = 0;
  const varint = (buffer: Uint8Array, at: number): [number, number] => {
    let value = 0, shift = 0, position = at;
    for (;;) {
      const byte = buffer[position++];
      value += (byte & 0x7f) * 2 ** shift;
      if (!(byte & 0x80)) return [value, position];
      shift += 7;
    }
  };
  const skip = (buffer: Uint8Array, at: number, wire: number) => {
    if (wire === 0) return varint(buffer, at)[1];
    if (wire === 1) return at + 8;
    if (wire === 5) return at + 4;
    if (wire === 2) { const [length, next] = varint(buffer, at); return next + length; }
    throw new Error("This Anki media list isn't readable.");
  };
  while (offset < bytes.length) {
    const [key, next] = varint(bytes, offset);
    offset = next;
    if (key >> 3 === 1 && (key & 7) === 2) {
      const [length, start] = varint(bytes, offset);
      const entry = bytes.subarray(start, start + length);
      offset = start + length;
      let name = "", cursor = 0;
      while (cursor < entry.length) {
        const [field, after] = varint(entry, cursor);
        if (field >> 3 === 1 && (field & 7) === 2) {
          const [size, from] = varint(entry, after);
          name = new TextDecoder().decode(entry.subarray(from, from + size));
          cursor = from + size;
        } else cursor = skip(entry, after, field & 7);
      }
      names.push(name);
    } else offset = skip(bytes, offset, key & 7);
  }
  return names;
}

const rows = (db: Database, sql: string): Array<Record<string, unknown>> => {
  const result = db.exec(sql)[0];
  if (!result) return [];
  return result.values.map((values) => Object.fromEntries(result.columns.map((column, index) => [column, values[index]])));
};

/** Read an .apkg (or .colpkg) file. */
export function readAnkiPackage(bytes: Uint8Array, SQL: SqlJsStatic): AnkiCollection {
  let files: Record<string, Uint8Array>;
  try { files = unzipSync(bytes); } catch { throw new Error("This isn't an Anki deck file (.apkg)."); }
  const collectionFile = files["collection.anki21b"] ? inflate(files["collection.anki21b"])
    : files["collection.anki21"] ?? files["collection.anki2"];
  if (!collectionFile) throw new Error("This file has no Anki collection in it.");
  const db = new SQL.Database(collectionFile);
  try {
    const decks = new Map<number, string>();
    const hasDeckTable = rows(db, "select name from sqlite_master where type = 'table' and name = 'decks'").length > 0;
    if (hasDeckTable) {
      for (const row of rows(db, "select id, name from decks")) decks.set(Number(row.id), String(row.name).split("\u001f").join("::"));
    } else {
      const col = rows(db, "select decks from col")[0];
      for (const deck of Object.values(JSON.parse(String(col?.decks ?? "{}")) as Record<string, { id: number; name: string }>)) decks.set(Number(deck.id), deck.name);
    }
    // Cloze note types: type 1 in the old JSON; in the new tables, any note with a cloze in a field counts.
    const clozeModels = new Set<number>();
    if (!hasDeckTable) {
      const col = rows(db, "select models from col")[0];
      for (const model of Object.values(JSON.parse(String(col?.models ?? "{}")) as Record<string, { id: number; type: number }>)) if (model.type === 1) clozeModels.add(Number(model.id));
    }
    const notes = new Map<number, AnkiNote>();
    for (const row of rows(db, "select id, mid, flds, tags from notes order by id")) {
      const fields = String(row.flds).split("\u001f");
      notes.set(Number(row.id), {
        id: Number(row.id), fields, tags: String(row.tags ?? "").trim(),
        cloze: clozeModels.has(Number(row.mid)) || fields.some((field) => /\{\{c\d+::/u.test(field)),
        cards: [],
      });
    }
    for (const row of rows(db, "select id, nid, ord, did, queue from cards order by nid, ord")) {
      notes.get(Number(row.nid))?.cards.push({ id: Number(row.id), ord: Number(row.ord), did: Number(row.did), queue: Number(row.queue) });
    }
    const revlog = rows(db, "select id, cid, ease, type, time from revlog order by id").map((row) => ({
      id: Number(row.id), cid: Number(row.cid), ease: Number(row.ease), type: Number(row.type), time: Number(row.time),
    }));

    const media = new Map<string, Uint8Array>();
    if (files.media) {
      const list = inflate(files.media);
      let names: string[];
      try {
        const map = JSON.parse(new TextDecoder().decode(list)) as Record<string, string>;
        names = [];
        for (const [index, name] of Object.entries(map)) names[Number(index)] = name;
      } catch { names = readMediaEntries(list); }
      names.forEach((name, index) => { const file = files[String(index)]; if (name && file) media.set(name, inflate(file)); });
    }
    return { decks, notes: [...notes.values()], revlog, media };
  } finally { db.close(); }
}

const ENTITIES: Record<string, string> = { nbsp: " ", amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'" };

/** Anki fields are HTML. Keep line breaks, bold, italics, images and sounds; drop the rest. */
export function ankiHtmlToMarkdown(html: string, embed: (name: string) => string | null): string {
  const text = html
    .replace(/\r/gu, "")
    .replace(/<br\s*\/?>/giu, "\n")
    .replace(/<\/(?:div|p|li|h\d|tr)>/giu, "\n")
    .replace(/<li[^>]*>/giu, "- ")
    .replace(/<img[^>]*\bsrc\s*=\s*["']?([^"' >]+)["']?[^>]*>/giu, (_match, src: string) => `\n${embed(decodeURIComponent(src)) ?? `[image: ${src}]`}\n`)
    .replace(/\[sound:([^\]]+)\]/gu, (_match, name: string) => `\n${embed(name) ?? `[sound: ${name}]`}\n`)
    .replace(/<(b|strong)>([\s\S]*?)<\/\1>/giu, (_match, _tag, inner: string) => (inner.trim() ? `**${inner.trim()}**` : inner))
    .replace(/<(i|em)>([\s\S]*?)<\/\1>/giu, (_match, _tag, inner: string) => (inner.trim() ? `*${inner.trim()}*` : inner))
    .replace(/<[^>]+>/gu, "")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/giu, (match, entity: string) => {
      if (entity[0] === "#") return String.fromCodePoint(entity[1].toLowerCase() === "x" ? parseInt(entity.slice(2), 16) : Number(entity.slice(1)));
      return ENTITIES[entity.toLowerCase()] ?? match;
    });
  // A blank line would end the card early, so lines stay together.
  return text.split("\n").map((line) => line.replace(/[ \t]+/gu, " ").trim()).filter(Boolean).join("\n");
}

/** One note as Markdown that Margin Chat reads back as the same cards. */
export function ankiNoteMarkdown(note: AnkiNote, embed: (name: string) => string | null): string | null {
  const fields = note.fields.map((field) => ankiHtmlToMarkdown(field, embed));
  if (note.cloze) {
    const text = fields[0];
    if (!/\{\{c\d+::/u.test(text)) return null;
    const extra = fields.slice(1).filter(Boolean).join("\n");
    return extra ? `${text}\n\n${extra}` : text;
  }
  const front = fields[0], back = fields.slice(1).filter(Boolean).join("\n");
  if (!front || !back) return null;
  const both = note.cards.some((card) => card.ord === 1);
  const oneLine = !front.includes("\n") && !back.includes("\n") && !/\s::/u.test(front) && !/\s::/u.test(back) && !/\{\{c\d+::/u.test(front + back);
  return oneLine ? `${front} ${both ? ":::" : "::"} ${back}` : `${front}\n${both ? "??" : "?"}\n${back}`;
}

export interface AnkiImportPlan {
  documents: Array<{ id: string; title: string; markdown: string; cards: Flashcard[] }>;
  reviews: FlashcardReview[];
  suspended: string[];
  skippedNotes: number;
}

/**
 * Turn a collection into one document per deck, the cards they hold, and the
 * full review history moved onto those cards.
 */
export function planAnkiImport(collection: AnkiCollection, options: { embed: (name: string) => string | null; createId: () => string }): AnkiImportPlan {
  const byDeck = new Map<number, AnkiNote[]>();
  for (const note of collection.notes) {
    const did = note.cards[0]?.did ?? 1;
    byDeck.set(did, [...byDeck.get(did) ?? [], note]);
  }
  const cardIds = new Map<number, string>();
  const suspended: string[] = [];
  const documents: AnkiImportPlan["documents"] = [];
  let skippedNotes = 0;
  for (const [did, notes] of byDeck) {
    const id = options.createId();
    const parts: string[] = [];
    for (const note of notes) {
      const markdown = ankiNoteMarkdown(note, options.embed);
      if (!markdown) { skippedNotes++; continue; }
      parts.push(markdown);
      // The note's own cards, with the ids the document will give them.
      const cards = parseFlashcards(id, markdown);
      for (const card of note.cards) {
        const match = note.cloze ? cards.find((item) => item.kind === "cloze" && item.cloze === card.ord + 1)
          : cards.find((item) => item.kind === (card.ord === 1 ? "reverse" : "basic"));
        if (!match) continue;
        cardIds.set(card.id, match.id);
        if (card.queue === -1) suspended.push(match.id);
      }
    }
    if (!parts.length) continue;
    const name = collection.decks.get(did) ?? "Anki deck";
    const markdown = parts.join("\n\n");
    documents.push({ id, title: name.split("::").map((part) => part.trim()).join(" › "), markdown: `${markdown}\n`, cards: parseFlashcards(id, markdown) });
  }
  const reviews: FlashcardReview[] = [];
  for (const entry of collection.revlog) {
    const cardId = cardIds.get(entry.cid);
    // Ease 0 is a manual reschedule, not an answer.
    if (!cardId || entry.ease < 1 || entry.ease > 4 || entry.type === 4) continue;
    reviews.push({
      // The id names our card too: the same deck imported again gets its own cards and keeps their history.
      id: `anki-${entry.id}-${cardId}`, cardId, rating: entry.ease as 1 | 2 | 3 | 4,
      reviewedAt: new Date(entry.id).toISOString(), ...(entry.time > 0 ? { durationMs: Math.min(entry.time, 86_400_000) } : {}),
    });
  }
  return { documents, reviews, suspended: [...new Set(suspended)], skippedNotes };
}

// ---------------------------------------------------------------- export

const escapeHtml = (text: string) => text.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;");

/** Markdown to the small HTML Anki shows. Images become their file name in the package. */
export function markdownToAnkiHtml(markdown: string, mediaName: (target: string) => string | null): string {
  return markdown.split("\n").map((line) => {
    const image = /^\s*!\[\[([^\]|]+)(?:\|[^\]]*)?\]\]\s*$|^\s*!\[[^\]]*\]\(\s*<?([^)\s>]+)>?\s*\)\s*$/u.exec(line);
    if (image) {
      const name = mediaName(decodeURIComponent(image[1] ?? image[2]));
      return name ? (/\.(mp3|m4a|wav|ogg|opus|flac)$/iu.test(name) ? `[sound:${name}]` : `<img src="${escapeHtml(name)}">`) : "";
    }
    return escapeHtml(line)
      .replace(/\*\*([^*]+)\*\*/gu, "<b>$1</b>")
      .replace(/(^|[^*])\*([^*\s][^*]*)\*/gu, "$1<i>$2</i>")
      .replace(/`([^`]+)`/gu, "<code>$1</code>");
  }).filter((line, index, all) => line || index < all.length - 1).join("<br>");
}

/** Every vault file a card's text shows, by the target its embed names. */
export function cardMediaTargets(markdown: string): string[] {
  const targets: string[] = [];
  for (const match of markdown.matchAll(/!\[\[([^\]|]+)(?:\|[^\]]*)?\]\]|!\[[^\]]*\]\(\s*<?([^)\s>]+)>?\s*\)/gu)) {
    const target = decodeURIComponent(match[1] ?? match[2]);
    if (!/^[a-z][a-z0-9+.-]*:/iu.test(target)) targets.push(target);
  }
  return targets;
}

export interface ExportCard {
  card: Flashcard & { docTitle: string; suspended?: boolean };
  schedule: FlashcardSchedule;
  reviews: FlashcardReview[];
}

const SCHEMA = `
create table col (id integer primary key, crt integer not null, mod integer not null, scm integer not null, ver integer not null, dty integer not null, usn integer not null, ls integer not null, conf text not null, models text not null, decks text not null, dconf text not null, tags text not null);
create table notes (id integer primary key, guid text not null, mid integer not null, mod integer not null, usn integer not null, tags text not null, flds text not null, sfld integer not null, csum integer not null, flags integer not null, data text not null);
create table cards (id integer primary key, nid integer not null, did integer not null, ord integer not null, mod integer not null, usn integer not null, type integer not null, queue integer not null, due integer not null, ivl integer not null, factor integer not null, reps integer not null, lapses integer not null, left integer not null, odue integer not null, odid integer not null, flags integer not null, data text not null);
create table revlog (id integer primary key, cid integer not null, usn integer not null, ease integer not null, ivl integer not null, lastIvl integer not null, factor integer not null, time integer not null, type integer not null);
create table graves (usn integer not null, oid integer not null, type integer not null);
create index ix_notes_usn on notes (usn);
create index ix_cards_usn on cards (usn);
create index ix_revlog_usn on revlog (usn);
create index ix_cards_nid on cards (nid);
create index ix_cards_sched on cards (did, queue, due);
create index ix_revlog_cid on revlog (cid);
create index ix_notes_csum on notes (csum);`;

const CSS = ".card { font-family: Georgia, serif; font-size: 22px; text-align: left; line-height: 1.5; }";
const field = (name: string, ord: number) => ({ name, ord, sticky: false, rtl: false, font: "Arial", size: 20, media: [] });
const template = (name: string, ord: number, qfmt: string, afmt: string) => ({ name, ord, qfmt, afmt, bqfmt: "", bafmt: "", did: null, bfont: "", bsize: 0 });
const model = (id: number, name: string, type: number, flds: ReturnType<typeof field>[], tmpls: ReturnType<typeof template>[], now: number) =>
  ({ id, name, type, mod: now, usn: -1, sortf: 0, did: 1, tmpls, flds, css: CSS, latexPre: "", latexPost: "", latexsvg: false,
    req: tmpls.map((tmpl) => [tmpl.ord, "any", [tmpl.ord === 1 ? 1 : 0]]), tags: [], vers: [] });

const GUID_CHARS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!#$%&()*+,-./:;<=>?@[]^_`{|}~";
/** A stable note guid from our card id, so exporting twice and re-importing updates instead of duplicating. */
function guidFor(id: string) {
  let hash = 0n;
  for (const char of id) hash = (hash * 131n + BigInt(char.codePointAt(0)!)) & ((1n << 64n) - 1n);
  let guid = "";
  do { guid += GUID_CHARS[Number(hash % BigInt(GUID_CHARS.length))]; hash /= BigInt(GUID_CHARS.length); } while (hash > 0n);
  return guid;
}

async function checksum(text: string) {
  const plain = text.replace(/<[^>]+>/gu, "");
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-1", new TextEncoder().encode(plain)));
  return ((digest[0] << 24) >>> 0) + (digest[1] << 16) + (digest[2] << 8) + digest[3];
}

/**
 * Write cards, their scheduling and every review as an .apkg. Each document becomes a deck.
 * Two-way cards become one "Basic (and reversed card)" note; cloze cards from one
 * paragraph become one Cloze note.
 */
export async function buildAnkiPackage(cards: ReadonlyArray<ExportCard>, media: Map<string, Uint8Array>, SQL: SqlJsStatic, now = Date.now()): Promise<Uint8Array> {
  const db = new SQL.Database();
  try {
    db.exec(SCHEMA);
    const nowSecs = Math.floor(now / 1000);
    const crt = Math.floor(new Date(new Date(now).setHours(4, 0, 0, 0)).getTime() / 1000) - 365 * 86400;
    const basicId = 1_700_000_000_001, reversedId = 1_700_000_000_002, clozeId = 1_700_000_000_003;
    const models = {
      [basicId]: model(basicId, "Margin Chat Basic", 0, [field("Front", 0), field("Back", 1)],
        [template("Card 1", 0, "{{Front}}", "{{FrontSide}}<hr id=answer>{{Back}}")], nowSecs),
      [reversedId]: model(reversedId, "Margin Chat Basic (and reversed card)", 0, [field("Front", 0), field("Back", 1)],
        [template("Card 1", 0, "{{Front}}", "{{FrontSide}}<hr id=answer>{{Back}}"), template("Card 2", 1, "{{Back}}", "{{FrontSide}}<hr id=answer>{{Front}}")], nowSecs),
      [clozeId]: { ...model(clozeId, "Margin Chat Cloze", 1, [field("Text", 0), field("Back Extra", 1)],
        [template("Cloze", 0, "{{cloze:Text}}", "{{cloze:Text}}<br>{{Back Extra}}")], nowSecs), req: [[0, "any", [0]]] },
    };

    // Decks, one per document title.
    const deckIds = new Map<string, number>();
    const decks: Record<string, unknown> = {};
    const deck = (id: number, name: string) => ({ id, name, mod: nowSecs, usn: -1, lrnToday: [0, 0], revToday: [0, 0], newToday: [0, 0], timeToday: [0, 0],
      collapsed: false, browserCollapsed: false, desc: "", dyn: 0, conf: 1, extendNew: 0, extendRev: 0 });
    decks["1"] = deck(1, "Default");
    const deckFor = (title: string) => {
      const name = (title || "Untitled").replace(/\s*›\s*/gu, "::").replace(/[\u0000-\u001f"]/gu, " ").trim() || "Untitled";
      let id = deckIds.get(name);
      if (!id) { id = 1_700_000_000_000 + deckIds.size + 100; deckIds.set(name, id); decks[String(id)] = deck(id, name); }
      return id;
    };
    const dconf = { "1": { id: 1, name: "Default", mod: 0, usn: 0, maxTaken: 60, autoplay: true, timer: 0, replayq: true, dyn: false,
      new: { delays: [1, 10], ints: [1, 4, 0], initialFactor: 2500, order: 1, perDay: 20, bury: false },
      rev: { perDay: 200, ease4: 1.3, ivlFct: 1, maxIvl: 36500, hardFactor: 1.2, bury: false },
      lapse: { delays: [10], mult: 0, minInt: 1, leechFails: 8, leechAction: 1 } } };

    // Media: every vault file a card shows, under a unique plain name.
    const mediaNames = new Map<string, string>();
    const usedNames = new Set<string>();
    for (const target of media.keys()) {
      const base = target.split("/").pop()!.replace(/[\\/:*?"<>|]/gu, "_");
      let name = base;
      for (let index = 2; usedNames.has(name); index++) name = base.replace(/(\.[^.]*)?$/u, (ext) => `-${index}${ext}`);
      usedNames.add(name);
      mediaNames.set(target, name);
    }
    const toHtml = (markdown: string) => markdownToAnkiHtml(markdown, (target) => mediaNames.get(target) ?? null);

    // Notes: pair two-way cards, group cloze cards by their paragraph.
    interface PendingNote { key: string; mid: number; fields: [string, string]; did: number; cards: Array<{ ord: number; entry: ExportCard }> }
    const pending = new Map<string, PendingNote>();
    const basics = new Map<string, ExportCard>();
    for (const entry of cards) if (entry.card.kind === "basic") basics.set(`${entry.card.docId}\u0000${entry.card.front}\u0000${entry.card.back}`, entry);
    const pairedBasics = new Set<string>();
    for (const entry of cards) {
      const { card } = entry;
      const did = deckFor(card.docTitle);
      if (card.kind === "cloze") {
        const source = card.source ?? card.back.replace(/\*\*([^*]+)\*\*/u, `{{c${card.cloze ?? 1}::$1}}`);
        const key = `cloze\u0000${card.docId}\u0000${source}`;
        const note = pending.get(key) ?? { key: card.id, mid: clozeId, fields: [toHtml(source), ""] as [string, string], did, cards: [] };
        note.cards.push({ ord: (card.cloze ?? 1) - 1, entry });
        pending.set(key, note);
      } else if (card.kind === "reverse") {
        const pair = basics.get(`${card.docId}\u0000${card.back}\u0000${card.front}`);
        const key = `pair\u0000${card.docId}\u0000${card.back}\u0000${card.front}`;
        const note = pending.get(key) ?? { key: pair?.card.id ?? card.id, mid: pair ? reversedId : basicId, fields: [toHtml(pair ? card.back : card.front), toHtml(pair ? card.front : card.back)] as [string, string], did, cards: [] };
        if (pair) { note.cards.push({ ord: 0, entry: pair }, { ord: 1, entry }); pairedBasics.add(pair.card.id); }
        else note.cards.push({ ord: 0, entry });
        pending.set(key, note);
      }
    }
    for (const entry of cards) {
      if (entry.card.kind !== "basic" || pairedBasics.has(entry.card.id)) continue;
      pending.set(`basic\u0000${entry.card.id}`, { key: entry.card.id, mid: basicId, fields: [toHtml(entry.card.front), toHtml(entry.card.back)], did: deckFor(entry.card.docTitle), cards: [{ ord: 0, entry }] });
    }

    const insertNote = db.prepare("insert into notes values (?, ?, ?, ?, -1, '', ?, ?, ?, 0, '')");
    const insertCard = db.prepare("insert into cards values (?, ?, ?, ?, ?, -1, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 0, '')");
    const insertReview = db.prepare("insert into revlog values (?, ?, -1, ?, ?, ?, ?, ?, ?)");
    let noteId = now, cardId = now, newPosition = 0;
    // A review's id is its time in ms and must be unique; answers in the same ms move by one.
    const usedReviewIds = new Set<number>();
    const dayNumber = (ms: number) => Math.max(0, Math.floor((ms / 1000 - crt) / 86400));
    for (const note of pending.values()) {
      noteId++;
      insertNote.run([noteId, guidFor(note.key), note.mid, nowSecs, note.fields.join("\u001f"), note.fields[0].replace(/<[^>]+>/gu, ""), await checksum(note.fields[0])]);
      for (const { ord, entry } of note.cards.sort((a, b) => a.ord - b.ord)) {
        cardId++;
        const { schedule } = entry;
        const type = { new: 0, learning: 1, review: 2, relearning: 3 }[schedule.state];
        const queue = entry.card.suspended ? -1 : type === 3 ? 1 : type;
        const intervalDays = schedule.lastReview ? Math.max(0, Math.round((schedule.due - schedule.lastReview) / 86_400_000)) : 0;
        const due = type === 0 ? newPosition++ : type === 2 ? dayNumber(schedule.due) : Math.floor(schedule.due / 1000);
        const factor = type === 0 ? 0 : Math.round(1300 + (10 - Math.min(10, Math.max(1, schedule.difficulty))) * 200);
        insertCard.run([cardId, noteId, note.did, ord, nowSecs, type, queue, due, type === 2 ? Math.max(1, intervalDays) : 0, factor, schedule.reps, schedule.lapses]);
        let lastIvl = 0;
        for (const review of [...entry.reviews].sort((a, b) => a.reviewedAt.localeCompare(b.reviewedAt))) {
          const at = Date.parse(review.reviewedAt);
          if (!Number.isFinite(at)) continue;
          let reviewId = at;
          while (usedReviewIds.has(reviewId)) reviewId++;
          usedReviewIds.add(reviewId);
          insertReview.run([reviewId, cardId, review.rating, 0, lastIvl, 2500, Math.min(review.durationMs ?? 0, 60_000), lastIvl ? 1 : 0]);
          lastIvl = 1;
        }
      }
    }
    insertNote.free(); insertCard.free(); insertReview.free();
    const conf = { schedVer: 2, nextPos: newPosition + 1, estTimes: true, activeDecks: [1], sortType: "noteFld", timeLim: 0, sortBackwards: false, addToCur: true, curDeck: 1, newBury: true, newSpread: 0, dueCounts: true, curModel: String(basicId), collapseTime: 1200 };
    db.run("insert into col values (1, ?, ?, ?, 11, 0, 0, 0, ?, ?, ?, ?, '{}')",
      [crt, now, now, JSON.stringify(conf), JSON.stringify(models), JSON.stringify(decks), JSON.stringify(dconf)]);
    const collection = db.export();

    const files: Record<string, Uint8Array> = { "collection.anki2": collection };
    const mediaMap: Record<string, string> = {};
    [...mediaNames.entries()].forEach(([target, name], index) => { mediaMap[String(index)] = name; files[String(index)] = media.get(target)!; });
    files.media = new TextEncoder().encode(JSON.stringify(mediaMap));
    return zipSync(files, { level: 6 });
  } finally { db.close(); }
}
