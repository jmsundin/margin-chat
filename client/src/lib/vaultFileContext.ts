import { isHiddenFromAI } from "@margin-chat/workspace-contracts";
import type { Conversation, VaultFileReference } from "../types";
import type { VaultMedia } from "./vaultMedia";
import { getConversationPath } from "./tree";
import { pdfPageFromSourceId, pdfTextForAI, vaultFileTitle } from "./vaultFileDocuments";

/** What the server receives about the PDF or image a conversation is about. */
export interface VaultFileContext {
  name: string;
  kind: VaultFileReference["kind"];
  /** A PDF's text page by page, or an SVG image's source. */
  text?: string;
  /** A picture, in a format every image-reading model accepts. */
  image?: { mediaType: "image/png" | "image/jpeg" | "image/gif" | "image/webp"; data: string };
  /** Why the file's content is missing, for the model to pass on. */
  note?: string;
  /** The page a selected passage is on. */
  page?: number;
}

const MAX_TEXT = 1_000_000;
const SENDABLE = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const MAX_IMAGE_BYTES = 1_500_000;
const MAX_IMAGE_SIDE = 2_000;

/** The file a conversation is about: its own, or the nearest one it branched from. */
export function nearestVaultFile(conversations: Record<string, Conversation>, conversation: Conversation) {
  const path = conversation.parentId ? [...getConversationPath(conversations, conversation.parentId), conversation] : [conversation];
  for (let index = path.length - 1; index >= 0; index -= 1) {
    const file = path[index].vaultFile;
    if (!file) continue;
    // A PDF or image the user hid from AI is never read for it.
    if (isHiddenFromAI(path[index])) return null;
    // A passage selected on a PDF page, by this conversation or the branch between.
    const anchored = path.slice(index + 1).find((item) => item.branchAnchor?.sourceConversationId === path[index].id);
    const page = pdfPageFromSourceId(anchored?.branchAnchor?.sourceMessageId);
    return { file, ...(page ? { page } : {}) };
  }
  return null;
}

function bytesToBase64(bytes: Uint8Array) {
  let result = "";
  for (let index = 0; index < bytes.length; index += 8192) result += String.fromCharCode(...bytes.subarray(index, index + 8192));
  return btoa(result);
}

/** Large or unusual images are redrawn smaller, as JPEG (PNG when they have transparency). */
async function sendableImage(blob: Blob): Promise<VaultFileContext["image"] | null> {
  const type = blob.type.toLowerCase();
  if (SENDABLE.has(type) && blob.size <= MAX_IMAGE_BYTES && type !== "image/gif") {
    try {
      const bitmap = await createImageBitmap(blob);
      const small = Math.max(bitmap.width, bitmap.height) <= MAX_IMAGE_SIDE;
      bitmap.close();
      if (small) return { mediaType: type as "image/png", data: bytesToBase64(new Uint8Array(await blob.arrayBuffer())) };
    } catch {
      return { mediaType: type as "image/png", data: bytesToBase64(new Uint8Array(await blob.arrayBuffer())) };
    }
  }
  if (typeof createImageBitmap !== "function" || typeof document === "undefined") return null;
  const bitmap = await createImageBitmap(blob);
  try {
    for (const side of [MAX_IMAGE_SIDE, 1_400, 1_000]) {
      const scale = Math.min(1, side / Math.max(bitmap.width, bitmap.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      const context = canvas.getContext("2d");
      if (!context) return null;
      const keepAlpha = type === "image/png" || type === "image/webp" || type === "image/gif";
      if (!keepAlpha) { context.fillStyle = "#fff"; context.fillRect(0, 0, canvas.width, canvas.height); }
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const mediaType = keepAlpha ? "image/png" : "image/jpeg";
      const output = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, mediaType, 0.88));
      if (output && output.size <= MAX_IMAGE_BYTES) return { mediaType, data: bytesToBase64(new Uint8Array(await output.arrayBuffer())) };
    }
    return null;
  } finally {
    bitmap.close();
  }
}

/** Reads the file for an AI request. Never throws: what could not be read is described instead. */
export async function loadVaultFileContext(media: VaultMedia | null, found: { file: VaultFileReference; page?: number }): Promise<VaultFileContext> {
  const { file, page } = found;
  const base = { name: vaultFileTitle(file.path), kind: file.kind, ...(page ? { page } : {}) };
  let blob: Blob | null = null;
  try { blob = (await media?.read(file.path))?.blob ?? null; } catch { blob = null; }
  if (!blob) return { ...base, note: "The file isn't available on this device, so only its name was sent." };
  try {
    if (file.kind === "pdf") {
      const { readPdfPages } = await import("./pdfDocuments");
      const text = pdfTextForAI(await readPdfPages(file.path, blob));
      return { ...base, text: text.slice(0, MAX_TEXT) };
    }
    if (/svg/iu.test(blob.type) || /\.svg$/iu.test(file.path)) return { ...base, text: (await blob.text()).slice(0, 40_000) };
    const image = await sendableImage(blob);
    return image ? { ...base, image } : { ...base, note: "The image was too large to send, so only its name was sent." };
  } catch {
    return { ...base, note: file.kind === "pdf" ? "The PDF's text couldn't be read, so only its name was sent." : "The image couldn't be read, so only its name was sent." };
  }
}
