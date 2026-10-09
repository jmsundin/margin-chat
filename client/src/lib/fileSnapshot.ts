/**
 * A File from getFile() is a snapshot. Chromium refuses to read it once the
 * file changed after the snapshot was taken (NotReadableError, or
 * InvalidStateError: "state cached in an interface object ... had changed since
 * it was read from disk"). Take a fresh snapshot and read again. When snapshots
 * of a file in the browser's private storage keep failing, read its bytes
 * directly through a sync access handle in a worker, which takes no snapshot.
 */
export function isStaleFileSnapshot(error: unknown) {
  return typeof DOMException !== "undefined" && error instanceof DOMException
    && (error.name === "InvalidStateError" || error.name === "NotReadableError");
}

/** A file that could not be read even after fresh snapshots and a direct read. */
export class UnreadableFileError extends Error {
  readonly detail: string;
  constructor(readonly fileName: string, cause: unknown) {
    const detail = cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause);
    super(`The browser could not read “${fileName}” (${detail})`, { cause });
    this.detail = detail;
    this.name = "UnreadableFileError";
  }
}

const STALE_SNAPSHOT_ATTEMPTS = 4;

export async function readFreshFile<T>(handle: () => Promise<FileSystemFileHandle>, read: (file: File) => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    let fileHandle: FileSystemFileHandle | undefined;
    try {
      fileHandle = await handle();
      return await read(await fileHandle.getFile());
    } catch (error) {
      if (!isStaleFileSnapshot(error)) throw error;
      if (attempt < STALE_SNAPSHOT_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, 25 * attempt));
        continue;
      }
      if (!fileHandle) throw error;
      const bytes = await readWithoutSnapshot(fileHandle).catch(() => null);
      if (bytes) return read(new File([bytes], fileHandle.name));
      console.error(`Margin Chat could not read ${fileHandle.name}`, error);
      throw new UnreadableFileError(fileHandle.name, error);
    }
  }
}

export const readFreshBytes = (handle: () => Promise<FileSystemFileHandle>) =>
  readFreshFile(handle, async (file) => new Uint8Array(await file.arrayBuffer()));

export const readFreshText = (handle: () => Promise<FileSystemFileHandle>) =>
  readFreshFile(handle, (file) => file.text());

const SYNC_READ_WORKER = `onmessage = async ({ data: handle }) => {
  let access;
  try {
    access = await handle.createSyncAccessHandle({ mode: "read-only" }).catch(() => handle.createSyncAccessHandle());
    const bytes = new Uint8Array(access.getSize());
    access.read(bytes, { at: 0 });
    postMessage({ bytes }, [bytes.buffer]);
  } catch (error) {
    postMessage({ error: String(error && error.name || error) });
  } finally {
    access?.close();
  }
};`;

/** Sync access handles exist only for the browser's private storage, and only in workers. */
function readWithoutSnapshot(handle: FileSystemFileHandle): Promise<Uint8Array> {
  if (typeof Worker === "undefined" || typeof Blob === "undefined" || typeof URL.createObjectURL !== "function") {
    return Promise.reject(new Error("Workers are unavailable."));
  }
  const url = URL.createObjectURL(new Blob([SYNC_READ_WORKER], { type: "text/javascript" }));
  const worker = new Worker(url);
  return new Promise<Uint8Array>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("The direct read timed out.")), 10_000);
    worker.onmessage = ({ data }) => {
      clearTimeout(timer);
      if (data?.bytes instanceof Uint8Array) resolve(data.bytes);
      else reject(new Error(data?.error ?? "The direct read failed."));
    };
    worker.onerror = (event) => { clearTimeout(timer); reject(new Error(event.message || "The direct read failed.")); };
    worker.postMessage(handle);
  }).finally(() => { worker.terminate(); URL.revokeObjectURL(url); });
}
