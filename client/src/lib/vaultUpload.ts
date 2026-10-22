import { MAX_VAULT_MEDIA_BYTES, MAX_VAULT_MEDIA_LABEL, safeName } from "./documentMedia";
import { isVaultFileDocumentPath, vaultFileContentType } from "./vaultFileDocuments";
import { bytesToBase64, importVault } from "./vaultLocal";
import type { VaultFile } from "./vaultTypes";

/**
 * Files picked on any device, a phone included, become vault files: notes and
 * text as Markdown documents, PDFs and images as file documents, and a zip of
 * a vault folder as everything in it. Names already in the vault get a number,
 * so an upload never replaces or conflicts with an existing document.
 */

export interface VaultUpload {
  name: string;
  /** Milliseconds since 1970; 0 when the device doesn't say. */
  lastModified: number;
  bytes: Uint8Array;
}

export interface VaultUploadPlan {
  files: Record<string, VaultFile>;
  /** When each added file was made: its own date when the device gives one,
   * otherwise the moment of the upload, never "unknown" (which reads as 1970). */
  createdAtByPath: Record<string, string>;
  /** Picked files that were added (a zip counts once). */
  added: string[];
  skipped: Array<{ name: string; reason: string }>;
}

const MARKDOWN = /\.(?:md|markdown|txt)$/iu;
const ZIP = /\.zip$/iu;
/** Zips made by macOS carry resource forks and Finder files that aren't notes. */
const ZIP_JUNK = /(?:^|\/)(?:__MACOSX|\.DS_Store$|\._)/u;

function uniquePath(base: string, extension: string, taken: Set<string>) {
  for (let copy = 1; ; copy += 1) {
    const path = `${base}${copy > 1 ? ` ${copy}` : ""}.${extension}`;
    if (!taken.has(path.toLowerCase())) { taken.add(path.toLowerCase()); return path; }
  }
}

function fileBase(name: string) {
  return safeName(name.split(/[\\/]/u).at(-1)!.replace(/\.[^.]+$/u, "")) || "Untitled";
}

/** A zip made on a phone holds one folder named after the vault; its contents belong at the top. */
function withoutSharedFolder(files: Record<string, VaultFile>) {
  const paths = Object.keys(files);
  const top = paths[0]?.split("/")[0];
  if (!top || !paths.every((path) => path.startsWith(`${top}/`))) return files;
  return Object.fromEntries(paths.map((path) => [path.slice(top.length + 1), files[path]!]));
}

export function planVaultUpload(uploads: VaultUpload[], existingPaths: Iterable<string>, now = Date.now()): VaultUploadPlan {
  const taken = new Set([...existingPaths].map((path) => path.toLowerCase()));
  const plan: VaultUploadPlan = { files: {}, createdAtByPath: {}, added: [], skipped: [] };
  // A date from the future (a wrong device clock) would pin the file above everything.
  const createdAt = (lastModified: number) => new Date(lastModified > 0 && lastModified <= now ? lastModified : now).toISOString();
  for (const upload of uploads) {
    const extension = /\.([a-z0-9]+)$/iu.exec(upload.name)?.[1]?.toLowerCase() ?? "";
    try {
      if (ZIP.test(upload.name)) {
        const archive = importVault(upload.bytes, (path) => !ZIP_JUNK.test(path));
        const files = archive["vault-export.json"] || archive["workspace.json"] ? archive : withoutSharedFolder(archive);
        if (!Object.keys(files).some((path) => MARKDOWN.test(path) || isVaultFileDocumentPath(path))) {
          plan.skipped.push({ name: upload.name, reason: "has no notes, PDFs or images" });
          continue;
        }
        // A zip keeps no dates we can read, so its notes count from the upload (a note's own `created` still wins).
        for (const [path, file] of Object.entries(files)) {
          plan.files[path] = file; plan.createdAtByPath[path] = createdAt(0); taken.add(path.toLowerCase());
        }
        plan.added.push(upload.name);
      } else if (MARKDOWN.test(upload.name)) {
        const content = new TextDecoder("utf-8", { fatal: true }).decode(upload.bytes);
        const path = uniquePath(fileBase(upload.name), "md", taken);
        plan.files[path] = { content };
        plan.createdAtByPath[path] = createdAt(upload.lastModified);
        plan.added.push(upload.name);
      } else if (isVaultFileDocumentPath(`file.${extension}`)) {
        if (upload.bytes.length > MAX_VAULT_MEDIA_BYTES) {
          plan.skipped.push({ name: upload.name, reason: `is larger than ${MAX_VAULT_MEDIA_LABEL}, the most a vault file can sync` });
          continue;
        }
        const path = uniquePath(fileBase(upload.name), extension, taken);
        plan.files[path] = { content: bytesToBase64(upload.bytes), encoding: "base64", contentType: vaultFileContentType(path) };
        plan.createdAtByPath[path] = createdAt(upload.lastModified);
        plan.added.push(upload.name);
      } else {
        plan.skipped.push({ name: upload.name, reason: "isn’t a note, PDF, image or zip" });
      }
    } catch (error) {
      plan.skipped.push({ name: upload.name, reason: error instanceof TypeError ? "isn’t readable text" : error instanceof Error ? error.message : "couldn’t be read" });
    }
  }
  return plan;
}

/** One line for the person who uploaded, naming what was left out and why. */
export function describeVaultUpload(plan: Pick<VaultUploadPlan, "added" | "skipped">) {
  const added = plan.added.length === 1 ? `Added “${plan.added[0]}” to your vault.` : plan.added.length ? `Added ${plan.added.length} files to your vault.` : "";
  const skipped = plan.skipped.map(({ name, reason }) => `“${name}” ${reason}`).join("; ");
  return [added, skipped ? `Not added: ${skipped}.` : ""].filter(Boolean).join(" ");
}
