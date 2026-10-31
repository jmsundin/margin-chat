import type { AppState, Conversation, VaultFileReference } from "../types";
import { MAX_VAULT_MEDIA_BYTES, mediaContentType } from "./documentMedia";
import { isVaultFileDocumentPath, vaultFileDocumentId, vaultFileKind, vaultFileTitle } from "@margin-chat/workspace-contracts";

// Shared with the server, which indexes the PDFs' and pages' text under the same document IDs.
export { isVaultFileDocumentPath, vaultFileDocumentId, vaultFileKind, vaultFileTitle };

/**
 * PDFs, images and HTML pages in the vault open as documents, like Obsidian shows them.
 * The file itself is never changed. Until someone writes a note, asks AI or
 * links it, its document exists only on screen; the first change saves a
 * Markdown companion (`Paper.pdf.md`) that holds the notes and conversation.
 */

const PDF = /\.pdf$/iu;
const HTML = /\.html?$/iu;

export type VaultFileKind = VaultFileReference["kind"];

/** A file the vault holds, or one only this device's folder holds. */
export interface VaultFileListing {
  path: string;
  size?: number;
  modifiedAt?: string;
  /** Too large to sync, so only the connected folder on this device has it. */
  localOnly?: boolean;
}

const addedKey = (userId: string) => `margin-chat:vault-file-added:${userId}`;

/**
 * When each PDF and image was added on this device, by path. The cloud vault
 * keeps no file dates, and an untouched file's document is never saved, so
 * without this an upload would be dated 1970 and listed as the oldest document.
 */
export function loadAddedVaultFileDates(userId: string): Record<string, string> {
  try {
    const stored = JSON.parse(localStorage.getItem(addedKey(userId)) ?? "{}");
    return Object.fromEntries(Object.entries(stored && typeof stored === "object" ? stored : {})
      .filter((entry): entry is [string, string] => typeof entry[1] === "string" && Number.isFinite(Date.parse(entry[1]))));
  } catch {
    return {};
  }
}

export function recordAddedVaultFileDates(userId: string, dates: Record<string, string>) {
  const added = Object.entries(dates).filter(([path]) => isVaultFileDocumentPath(path));
  if (!added.length) return;
  try {
    localStorage.setItem(addedKey(userId), JSON.stringify({ ...loadAddedVaultFileDates(userId), ...Object.fromEntries(added) }));
  } catch { /* Without storage the file is dated as before. */ }
}

/** Listings dated from when this device added them, unless the folder on disk says otherwise. */
export function withAddedVaultFileDates(listings: VaultFileListing[], dates: Record<string, string>): VaultFileListing[] {
  return listings.map((listing) => !listing.modifiedAt && dates[listing.path] ? { ...listing, modifiedAt: dates[listing.path] } : listing);
}

/** Whether a vault file can sync to the cloud; larger ones stay in the folder. */
export function isSyncableVaultFileSize(size: number) {
  return size <= MAX_VAULT_MEDIA_BYTES;
}

export function vaultFileContentType(path: string) {
  return PDF.test(path) ? "application/pdf" : HTML.test(path) ? "text/html" : mediaContentType(path);
}

function referencedIds(state: Pick<AppState, "conversations">) {
  const ids = new Set<string>();
  for (const conversation of Object.values(state.conversations)) {
    if (conversation.parentId) ids.add(conversation.parentId);
    if (conversation.branchAnchor) ids.add(conversation.branchAnchor.sourceConversationId);
    for (const id of conversation.linkedConversationIds ?? []) ids.add(id);
    for (const relation of conversation.relations ?? []) if (relation.targetConversationId) ids.add(relation.targetConversationId);
    for (const link of conversation.document?.links ?? []) ids.add(link.targetConversationId);
  }
  return ids;
}

/** A file's document that nobody has written in, asked about, or linked to yet. */
function isUntouched(conversation: Conversation, state: Pick<AppState, "defaultServiceId" | "defaultModelId">, referenced: Set<string>) {
  const file = conversation.vaultFile;
  if (!file || referenced.has(conversation.id)) return false;
  const document = conversation.document;
  return conversation.parentId === null && conversation.title === vaultFileTitle(file.path)
    && !conversation.messages.length && !conversation.notes?.length && !conversation.childIds.length
    && !conversation.documents?.length && !conversation.linkedConversationIds?.length && !conversation.relations?.length
    && !conversation.tags?.length && !conversation.nodeType && !conversation.publicTopic && !conversation.documentLayout
    && !conversation.ai && conversation.serviceId === state.defaultServiceId && conversation.modelId === state.defaultModelId
    && (!document || (!document.blocks.some((block) => block.content.trim()) && !document.prompts.length
      && !document.generations.length && !document.links?.length));
}

/** The workspace as it is saved: file documents nobody has touched stay unsaved. */
export function withoutUntouchedVaultFileDocuments(state: AppState): AppState {
  const files = Object.values(state.conversations).filter((conversation) => conversation.vaultFile);
  if (!files.length) return state;
  const referenced = referencedIds(state);
  const untouched = files.filter((conversation) => isUntouched(conversation, state, referenced));
  if (!untouched.length) return state;
  const conversations = { ...state.conversations };
  for (const conversation of untouched) delete conversations[conversation.id];
  return { ...state, conversations };
}

/**
 * Adds a document for each PDF and image that has none yet. A file whose
 * companion Markdown already exists keeps that document.
 */
export function addVaultFileDocuments(state: AppState, listings: Iterable<VaultFileListing>): AppState {
  const claimed = new Set(Object.values(state.conversations).flatMap((conversation) =>
    conversation.vaultFile ? [conversation.vaultFile.path.normalize("NFC").toLowerCase()] : []));
  let conversations: AppState["conversations"] | null = null;
  for (const listing of listings) {
    const kind = vaultFileKind(listing.path);
    const key = listing.path.normalize("NFC").toLowerCase();
    if (!kind || !isVaultFileDocumentPath(listing.path) || claimed.has(key)) continue;
    claimed.add(key);
    const id = vaultFileDocumentId(listing.path);
    if (state.conversations[id]) continue;
    const date = listing.modifiedAt && Number.isFinite(Date.parse(listing.modifiedAt)) ? listing.modifiedAt : "1970-01-01T00:00:00.000Z";
    conversations ??= { ...state.conversations };
    conversations[id] = {
      id, kind: "chat", title: vaultFileTitle(listing.path), parentId: null,
      serviceId: state.defaultServiceId, modelId: state.defaultModelId,
      vaultFile: { path: listing.path, kind },
      branchAnchor: null, childIds: [], documents: [], messages: [], notes: [],
      document: { schemaVersion: 1, blocks: [], prompts: [], generations: [] },
      createdAt: date, updatedAt: date,
    };
  }
  return conversations ? { ...state, conversations } : state;
}

/* Passages and areas of a file are anchored like passages of a message, with
 * a source ID that names where they are: `file:page:3` for text on page 3 of a
 * PDF, `file:area:120,300,250,180` for an area of an image (in thousandths). */

const PAGE_SOURCE = /^file:page:(\d+)$/u;
const AREA_SOURCE = /^file:area:(\d+),(\d+),(\d+),(\d+)$/u;

export function pdfPageSourceId(page: number) {
  return `file:page:${page}`;
}

export function pdfPageFromSourceId(sourceId: string | null | undefined): number | null {
  const match = sourceId ? PAGE_SOURCE.exec(sourceId) : null;
  return match ? Number(match[1]) : null;
}

/** An area of an image, as fractions of its width and height. */
export interface ImageArea { x: number; y: number; width: number; height: number }

const permille = (value: number) => Math.round(Math.min(1, Math.max(0, value)) * 1000);

export function imageAreaSourceId(area: ImageArea) {
  return `file:area:${permille(area.x)},${permille(area.y)},${permille(area.width)},${permille(area.height)}`;
}

export function imageAreaFromSourceId(sourceId: string | null | undefined): ImageArea | null {
  const match = sourceId ? AREA_SOURCE.exec(sourceId) : null;
  if (!match) return null;
  const [x, y, width, height] = match.slice(1).map((value) => Number(value) / 1000);
  return width > 0 && height > 0 && x + width <= 1.0005 && y + height <= 1.0005 ? { x, y, width, height } : null;
}

/** The text an image-area anchor quotes; it also tells AI which area was picked. */
export function imageAreaQuote(area: ImageArea) {
  const percent = (value: number) => `${Math.round(permille(value) / 10)}%`;
  return `Area of the image ${percent(area.x)} from the left, ${percent(area.y)} from the top, ${percent(area.width)} wide and ${percent(area.height)} tall`;
}

/** A PDF page's text as its text layer shows it: each run, then a line break where a line ends. */
export function pdfPageText(items: Iterable<{ str?: string; hasEOL?: boolean }>) {
  let text = "";
  for (const item of items) {
    if (typeof item.str !== "string") continue;
    text += item.str + (item.hasEOL ? "\n" : "");
  }
  return text;
}

/** Extracted text for AI, page by page, so answers can say which page they mean. */
export function pdfTextForAI(pages: string[]) {
  return pages.map((text, index) => `[Page ${index + 1}]\n${text.replace(/[ \t]+\n/gu, "\n").replace(/\n{3,}/gu, "\n\n").trim()}`)
    .filter((page) => !/^\[Page \d+\]\n?$/u.test(page)).join("\n\n");
}

/** What a file is called in lists and in what AI is told. */
export function vaultFileKindLabel(kind: VaultFileKind) {
  return kind === "pdf" ? "PDF" : kind === "html" ? "HTML page" : "image";
}
