/**
 * PDFs and images in the vault open as documents. The client lists them and the
 * server indexes their text, so both name a file's document the same way.
 */

const PDF = /\.pdf$/iu;
const IMAGE = /\.(?:png|jpe?g|gif|webp|avif|svg|bmp)$/iu;
/** Margin Chat's own folders: pasted media, upload originals, recovery copies. */
const MANAGED = /^(?:attachments|_conflicts|\.margin-chat)(?:\/|$)/iu;

export function vaultFileKind(path) {
  return PDF.test(path) ? "pdf" : IMAGE.test(path) ? "image" : null;
}

/** A PDF or image outside Margin Chat's own folders and hidden folders. */
export function isVaultFileDocumentPath(path) {
  return vaultFileKind(path) !== null && !MANAGED.test(path) && !path.split("/").some((segment) => segment.startsWith("."));
}

export function vaultFileTitle(path) {
  return path.split("/").at(-1) || path;
}

/** The same file always opens the same document, on every device. */
export function vaultFileDocumentId(path) {
  let hash = 0x811c9dc5;
  for (const character of path.normalize("NFC")) {
    hash ^= character.codePointAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  let second = 0;
  for (const character of path.normalize("NFC").toLowerCase()) second = (Math.imul(second, 31) + character.codePointAt(0)) >>> 0;
  return `file-${hash.toString(36)}${second.toString(36)}`;
}
