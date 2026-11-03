import type { AppState } from "../types";
import { apiFetch } from "./apiTransport";
import { MEDIA_CONTENT_TYPES, safeName } from "./documentMedia";
import type { VaultMedia } from "./vaultMedia";

/** Pictures one imported document saves into the vault; the rest stay as web links. */
export const IMPORT_IMAGES_PER_DOCUMENT = 60;
const CONCURRENCY = 3;
const REMOTE_IMAGE = /!\[([^\]\n]*)\]\(\s*<?(https?:\/\/[^)\s>]+)>?(?:\s+"[^"\n]*")?\s*\)/gu;
/** Status badges and vector drawings stay links: badges change, and SVG can carry scripts. */
const SKIPPED = /^(?:img\.shields\.io|badgen\.net|badge\.fury\.io|travis-ci\.(?:org|com)|codecov\.io|circleci\.com)$/iu;

export interface RemoteImage { url: string; alt: string }

/** The web pictures in a document's Markdown worth saving, each address once, in reading order. */
export function remoteImages(markdown: string): RemoteImage[] {
  const seen = new Set<string>();
  const images: RemoteImage[] = [];
  for (const match of markdown.matchAll(REMOTE_IMAGE)) {
    const url = match[2];
    if (seen.has(url)) continue;
    let parsed: URL;
    try { parsed = new URL(url); } catch { continue; }
    if (SKIPPED.test(parsed.hostname) || /\.svg$/iu.test(parsed.pathname) || /\/badge(?:s)?\//iu.test(parsed.pathname)) continue;
    seen.add(url);
    images.push({ url, alt: match[1].trim() });
  }
  return images;
}

/** `Document title 3.jpg`: the picture's place in its document, with the type the server reported. */
export function importedImageName(title: string, index: number, contentType: string) {
  const ext = Object.entries(MEDIA_CONTENT_TYPES).find(([, type]) => type === contentType)?.[0] ?? "png";
  // Long titles (an X post's first line) are cut at a word, so names stay readable in a file list.
  const full = safeName(title);
  const cut = full.length > 60 ? full.slice(0, 60).replace(/\s+\S*$/u, "") : full;
  const base = cut.replace(/[\s.,;:!?'"’-]+$/u, "").trim() || "Imported image";
  return `${base} ${index + 1}.${ext === "jpeg" ? "jpg" : ext}`;
}

/** Each `![alt](url)` of a saved picture replaced by the vault embed that shows it, alt text kept. */
export function replaceRemoteImages(markdown: string, saved: Map<string, string>) {
  return markdown.replace(REMOTE_IMAGE, (match, alt: string, url: string) => {
    const embed = saved.get(url);
    if (!embed) return match;
    const label = alt.replace(/[[\]|\n]/gu, " ").replace(/\s+/gu, " ").trim();
    return label && embed.endsWith("]]") ? `${embed.slice(0, -2)}|${label}]]` : embed;
  });
}

/** Download a web picture through the server, which reads it the way it reads pages. */
export async function fetchImportImage(url: string, options: { expectedUserId?: string; signal?: AbortSignal } = {}): Promise<Blob> {
  const response = await apiFetch(`/api/web/image?url=${encodeURIComponent(url)}`, {
    credentials: "same-origin", signal: options.signal,
    headers: options.expectedUserId ? { "X-Margin-Vault-User": options.expectedUserId } : {},
  });
  if (!response.ok) throw new Error(`The picture could not be downloaded (${response.status}).`);
  return response.blob();
}

async function inBatches<T>(items: T[], run: (item: T, index: number) => Promise<void>) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      await run(items[index], index);
    }
  }));
}

/** A newly imported document whose pictures to save: its id, title and Markdown as created. */
export interface ImportedImageSource { id: string; title: string; markdown: string }

/** The imported documents among `ids`, as they are in `state`, for saveImportedImages. */
export function importedImageSources(state: AppState, ids: string[]): ImportedImageSource[] {
  return ids.flatMap((id) => {
    const conversation = state.conversations[id];
    return conversation?.document ? [{ id, title: conversation.title, markdown: conversation.document.blocks.map((block) => block.content).join("\n\n") }] : [];
  });
}

/**
 * Save the web pictures in newly imported documents into the vault, beside the
 * text, and point each document at its saved copies. A picture that can't be
 * downloaded keeps its web link. `update` applies a change to the latest state.
 */
export async function saveImportedImages(args: {
  documents: ImportedImageSource[];
  update: (change: (state: AppState) => AppState) => void;
  media: Pick<VaultMedia, "save">;
  fetchImage?: (url: string) => Promise<Blob>;
}): Promise<{ saved: number; failed: number }> {
  const fetchImage = args.fetchImage ?? ((url: string) => fetchImportImage(url));
  let saved = 0;
  let failed = 0;
  for (const { id, title, markdown } of args.documents) {
    const images = remoteImages(markdown).slice(0, IMPORT_IMAGES_PER_DOCUMENT);
    if (!images.length) continue;
    const embeds = new Map<string, string>();
    await inBatches(images, async (image, index) => {
      try {
        const blob = await fetchImage(image.url);
        const type = blob.type.split(";")[0].trim();
        if (!/^image\/(?:png|jpeg|gif|webp|avif)$/u.test(type)) throw new Error("Not a picture.");
        embeds.set(image.url, await args.media.save(new File([blob], importedImageName(title, index, type), { type })));
        saved += 1;
      } catch {
        failed += 1;
      }
    });
    if (!embeds.size) continue;
    args.update((state) => {
      const current = state.conversations[id];
      if (!current?.document) return state;
      let changed = false;
      const blocks = current.document.blocks.map((block) => {
        const content = replaceRemoteImages(block.content, embeds);
        if (content === block.content) return block;
        changed = true;
        return { ...block, content };
      });
      return changed ? { ...state, conversations: { ...state.conversations, [id]: { ...current, document: { ...current.document, blocks } } } } : state;
    });
  }
  return { saved, failed };
}
