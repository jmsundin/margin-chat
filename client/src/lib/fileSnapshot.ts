/**
 * A File from getFile() is a snapshot. Chromium refuses to read it once the
 * file changed after the snapshot was taken (InvalidStateError: "state cached
 * in an interface object ... had changed since it was read from disk"), and
 * other browsers report NotReadableError. Take a fresh snapshot and read again.
 */
export function isStaleFileSnapshot(error: unknown) {
  return typeof DOMException !== "undefined" && error instanceof DOMException
    && (error.name === "InvalidStateError" || error.name === "NotReadableError");
}

const STALE_SNAPSHOT_ATTEMPTS = 4;

export async function readFreshFile<T>(handle: () => Promise<FileSystemFileHandle>, read: (file: File) => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try { return await read(await (await handle()).getFile()); }
    catch (error) {
      if (attempt >= STALE_SNAPSHOT_ATTEMPTS || !isStaleFileSnapshot(error)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 25 * attempt));
    }
  }
}

export const readFreshBytes = (handle: () => Promise<FileSystemFileHandle>) =>
  readFreshFile(handle, async (file) => new Uint8Array(await file.arrayBuffer()));

export const readFreshText = (handle: () => Promise<FileSystemFileHandle>) =>
  readFreshFile(handle, (file) => file.text());
