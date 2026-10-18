import { zipSync, unzipSync, strToU8 } from "fflate";
import { UnreadableFileError, readFreshBytes, readFreshText } from "./fileSnapshot";
import { emptyVault, validDirectoryStats, validVaultPath, type DirectoryStats, type VaultDeferredEntry, type VaultFile, type VaultSnapshot, type VaultStore } from "./vaultTypes";

// Native base64 (where the browser has it) avoids copying a large file through a binary string.
type NativeBase64 = { toBase64?: (this: Uint8Array) => string };
const nativeFromBase64 = (Uint8Array as unknown as { fromBase64?: (value: string) => Uint8Array }).fromBase64;

export function bytesToBase64(bytes: Uint8Array): string {
  const toBase64 = (bytes as Uint8Array & NativeBase64).toBase64;
  if (typeof toBase64 === "function") return toBase64.call(bytes);
  let result = "";
  for (let i = 0; i < bytes.length; i += 8192) result += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(result);
}

export function vaultFileBytes(file: VaultFile): Uint8Array {
  if (file.encoding !== "base64") return new TextEncoder().encode(file.content);
  if (typeof nativeFromBase64 === "function") return nativeFromBase64(file.content);
  const binary = atob(file.content);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export const defaultVaultContentType = (path: string) => /\.md$/iu.test(path) ? "text/markdown; charset=utf-8"
  : path.endsWith(".json") ? "application/json" : "application/octet-stream";

/** The server addresses immutable files by the hash of metadata plus exact bytes. */
export async function vaultFileRevision(bytes: Uint8Array, encoding: "base64" | undefined, contentType: string): Promise<string> {
  const prefix = new TextEncoder().encode(`${encoding ?? "utf8"}\n${contentType}\n`);
  const input = new Uint8Array(prefix.length + bytes.length);
  input.set(prefix); input.set(bytes, prefix.length);
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", input.buffer))]
    .map((value) => value.toString(16).padStart(2, "0")).join("");
}

type FileRef = Omit<VaultFile, "content"> & { object: string };
type StoredBase = { revision: string; file: FileRef | null };
type StoredConflict = Omit<VaultSnapshot["conflicts"][number], "local" | "remote" | "base" | "result"> & {
  local: FileRef | null; remote: FileRef | null; base?: FileRef | null; result?: FileRef | null;
};
type StoredBaselines = Record<string, {
  manifest: NonNullable<VaultSnapshot["directoryBaselines"]>[string]["manifest"]; files: Record<string, FileRef>; stats?: DirectoryStats;
}>;
type StoredSnapshot = Omit<VaultSnapshot, "files" | "base" | "conflicts" | "directoryBaselines"> & {
  files: Record<string, FileRef>;
  base: Record<string, StoredBase>;
  conflicts: StoredConflict[];
  directoryBaselines?: StoredBaselines;
};
/** One save, relative to the state before it. A null entry removes that path or field. */
type StoredChange = {
  remoteRevision?: number;
  pulledRevision?: number | null;
  dismissedRecoveryIds?: string[] | null;
  files?: Record<string, FileRef | null>;
  base?: Record<string, StoredBase | null>;
  deferred?: Record<string, VaultDeferredEntry | null>;
  conflicts?: StoredConflict[];
  directoryBaselines?: StoredBaselines | null;
};
/** The commit point: a complete checkpoint plus the saves made since, one small file each. */
type JournalHead = { schemaVersion: 2; checkpoint: string; from: number; generation: number };

const HEAD = "vault-journal.json";
const LEGACY_INDEX = "vault-state.json";
const COMPACT_SEGMENTS = 256;

async function readText(directory: FileSystemDirectoryHandle, name: string): Promise<string | null> {
  try { return await readFreshText(() => directory.getFileHandle(name)); }
  catch (error) { if (error instanceof DOMException && error.name === "NotFoundError") return null; throw error; }
}
async function writeFile(directory: FileSystemDirectoryHandle, name: string, contents: string | Uint8Array) {
  let created = false;
  let handle: FileSystemFileHandle;
  try { handle = await directory.getFileHandle(name); }
  catch (error) {
    if (!(error instanceof DOMException && error.name === "NotFoundError")) throw error;
    handle = await directory.getFileHandle(name, { create: true });
    created = true;
  }
  let writer: FileSystemWritableFileStream | undefined;
  try {
    writer = await handle.createWritable();
    await writer.write(typeof contents === "string" ? contents : new Uint8Array(contents).buffer);
    await writer.close();
  } catch (error) {
    await writer?.abort().catch(() => undefined);
    // create:true may leave an empty directory entry even after abort. Do not
    // leave a failed first index behind, and never delete a committed old index.
    if (created) await directory.removeEntry(name).catch(() => undefined);
    throw error;
  }
}

async function hashBytes(bytes: Uint8Array): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes).buffer))]
    .map((value) => value.toString(16).padStart(2, "0")).join("");
}

const unreadable = () => new Error("The local vault index could not be read. Its Markdown history has been preserved.");
const sameFile = (left: VaultFile | null | undefined, right: VaultFile | null | undefined) => left === right
  || (!!left && !!right && left.content === right.content && left.encoding === right.encoding && left.contentType === right.contentType);
const sameRef = (left: FileRef | null | undefined, right: FileRef | null | undefined) => left === right
  || (!!left && !!right && left.object === right.object && left.encoding === right.encoding && left.contentType === right.contentType);
const refKey = (ref: FileRef) => `${ref.object}\0${ref.encoding ?? ""}\0${ref.contentType ?? ""}`;
const frozenFile = (file: VaultFile): VaultFile => Object.freeze({ content: file.content,
  ...(file.encoding ? { encoding: file.encoding } : {}), ...(file.contentType ? { contentType: file.contentType } : {}) });

/** A device's decoded vault and the stored references it came from. */
type Memo = {
  checkpoint: string;
  from: number;
  generation: number;
  stored: StoredSnapshot;
  snapshot: VaultSnapshot;
  checkpointBytes: number;
  journalBytes: number;
};

const freshCopyKey = (userId: string) => `margin-chat-vault-fresh-copy:${userId}`;

/** The folder in the browser's private storage that holds this device's copy of the vault. */
function vaultCopyFolder(userId: string): [string, string] {
  let fresh: string | null = null;
  try { fresh = globalThis.localStorage?.getItem(freshCopyKey(userId)) ?? null; } catch { /* Storage may be unavailable. */ }
  return fresh && /^[a-z0-9]+$/u.test(fresh) ? [`margin-chat-vaults-${fresh}`, encodeURIComponent(userId)] : ["margin-chat-vaults", encodeURIComponent(userId)];
}

/**
 * Keep a copy the browser can no longer read where it is and start a new, empty one, which the
 * cloud vault then fills. Nothing is deleted. Returns false when the browser cannot remember the choice.
 */
export function startFreshVaultCopy(userId: string): boolean {
  try { localStorage.setItem(freshCopyKey(userId), Date.now().toString(36)); return true; }
  catch { return false; }
}

const recoveryKey = (userId: string) => `margin-chat-vault-recovery:${userId}`;

/**
 * Switch to a fresh copy once per browser tab session, so a fresh copy that also fails to open
 * stops on its error instead of reloading forever. Returns false when it should not or cannot switch.
 */
export function recoverWithFreshVaultCopy(userId: string, step: string): boolean {
  try {
    if (sessionStorage.getItem(recoveryKey(userId))) return false;
    sessionStorage.setItem(recoveryKey(userId), JSON.stringify({ step, at: new Date().toISOString(), pending: true }));
  } catch { return false; }
  return startFreshVaultCopy(userId);
}

/** After a recovery reload: what happened, once, for a notice. */
export function takeVaultRecoveryNotice(userId: string): string | null {
  try {
    const raw = sessionStorage.getItem(recoveryKey(userId));
    const recovery = raw ? JSON.parse(raw) as { step?: string; pending?: boolean } : null;
    if (!recovery?.pending) return null;
    // Keep the key so this tab does not recover twice, but report it only once.
    sessionStorage.setItem(recoveryKey(userId), JSON.stringify({ ...recovery, pending: false }));
    return "Chrome couldn't open the copy of your vault saved on this device"
      + (recovery.step ? ` (while ${recovery.step})` : "")
      + ", so Margin Chat started a fresh copy and is downloading your vault from the cloud. The old copy was kept.";
  } catch { return null; }
}

/** Whether this tab may still switch to a fresh copy; once it has, a copy that still fails is not the copy's fault. */
export function canRecoverWithFreshVaultCopy(userId: string): boolean {
  try { return !sessionStorage.getItem(recoveryKey(userId)); } catch { return false; }
}

/** The notice for a vault opened in memory, naming what Chrome refused so a report says which step failed. */
export function inMemoryVaultNotice(refused: LocalVaultUnavailableError | null): string {
  const cause = refused?.cause instanceof DOMException ? refused.cause.name : null;
  return "Chrome won't open this site's storage on this device, so your vault was loaded from the cloud"
    + " and is kept in this tab only. Your changes still save to the cloud. To fix it, quit Chrome completely (⌘Q on a Mac) and reopen it."
    + " If that doesn't help, open DevTools > Application > Storage, click Clear site data, then reload and sign in again."
    + (refused ? ` (Chrome said ${cause ?? "an error"} while ${refused.step}.)` : "");
}

/** The browser refused an operation on this device's copy of the vault for a reason no retry fixed. */
export class LocalVaultUnavailableError extends Error {
  constructor(readonly step: string, cause: DOMException) {
    super(`This browser could not open the vault saved on this device while ${step} (${cause.name}: ${cause.message})`, { cause });
    this.name = "LocalVaultUnavailableError";
  }
}

/**
 * Content is stored as immutable Markdown/binary files named by their hash. The
 * index of references is a checkpoint plus a journal of small saves, so a
 * keystroke writes one document and a short journal entry, not an index of the
 * whole vault. Each tab keeps its decoded vault in memory and reads only the
 * saves other tabs made since; a reopened vault verifies every file it reads.
 */
export function createBrowserVaultStore(userId: string): VaultStore {
  let directoryPromise: Promise<FileSystemDirectoryHandle> | null = null;
  let memo: Memo | null = null;
  /** What the last read was doing, so a browser error says which step failed. */
  let step = "opening it";
  /** Decoded text whose bytes carried a BOM does not round-trip; it is rehashed when saved. */
  const lossy = new WeakSet<VaultFile>();
  /** What reading this file back from disk returns: TextDecoder drops a leading BOM. */
  function asRead(file: VaultFile): VaultFile {
    if (file.encoding === "base64" || file.content.charCodeAt(0) !== 0xfeff) return frozenFile(file);
    const decoded = frozenFile({ ...file, content: file.content.slice(1) });
    lossy.add(decoded);
    return decoded;
  }
  function directory() {
    if (directoryPromise) return directoryPromise;
    const opening = directoryPromise = (async () => {
      if (!navigator.storage?.getDirectory) throw new Error("This browser cannot save a local Markdown vault. Use a current version of Safari, Chrome, Edge, or Firefox.");
      const [vaultsName, userName] = vaultCopyFolder(userId);
      step = "opening the browser's private storage";
      const root = await navigator.storage.getDirectory();
      step = `opening ${vaultsName}/${userName}`;
      const vaults = await root.getDirectoryHandle(vaultsName, { create: true });
      return vaults.getDirectoryHandle(userName, { create: true });
    })();
    // A failed open is retried on the next read instead of being remembered.
    opening.catch(() => { if (directoryPromise === opening) directoryPromise = null; });
    return opening;
  }

  async function readHead(root: FileSystemDirectoryHandle): Promise<JournalHead | null> {
    step = `reading ${HEAD}`;
    const text = await readText(root, HEAD);
    if (text === null) return null;
    const head = JSON.parse(text) as JournalHead;
    if (head?.schemaVersion !== 2 || typeof head.checkpoint !== "string" || !/^vault-checkpoint-\d+\.json$/u.test(head.checkpoint)
      || !Number.isSafeInteger(head.from) || !Number.isSafeInteger(head.generation) || head.from < 1 || head.generation < head.from) throw unreadable();
    return head;
  }

  /** Decodes references, verifying each object read from disk once per load. */
  function decoder(history: FileSystemDirectoryHandle, known: Map<string, VaultFile>) {
    return async function decode(ref: FileRef | null): Promise<VaultFile | null> {
      if (!ref) return null;
      if (!/^[a-f0-9]{64}\.(md|bin|json|txt)$/u.test(ref.object)) throw new Error("Invalid local vault history reference.");
      const key = refKey(ref);
      const existing = known.get(key);
      if (existing) return existing;
      step = `reading history/${ref.object}`;
      const bytes = await readFreshBytes(() => history.getFileHandle(ref.object));
      if (await hashBytes(bytes) !== ref.object.slice(0, 64)) {
        throw new Error("A local vault history file is incomplete or damaged. Its index and other Markdown files have been preserved.");
      }
      const file = frozenFile({ content: ref.encoding === "base64" ? bytesToBase64(bytes) : new TextDecoder("utf-8", { fatal: true }).decode(bytes),
        ...(ref.encoding ? { encoding: ref.encoding } : {}), ...(ref.contentType ? { contentType: ref.contentType } : {}) });
      // TextDecoder consumes a UTF-8 BOM, so this text does not reproduce these bytes.
      if (ref.encoding !== "base64" && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) lossy.add(file);
      known.set(key, file);
      return file;
    };
  }

  /** Files already decoded on this device, by reference, for reuse after another tab compacts. */
  function knownFiles(current: Memo | null) {
    const known = new Map<string, VaultFile>();
    if (!current) return known;
    for (const [path, ref] of Object.entries(current.stored.files)) known.set(refKey(ref), current.snapshot.files[path]);
    for (const [path, base] of Object.entries(current.stored.base)) {
      if (base.file && current.snapshot.base[path]?.file) known.set(refKey(base.file), current.snapshot.base[path].file!);
    }
    return known;
  }

  async function applyChange(target: Memo, change: StoredChange, decode: (ref: FileRef | null) => Promise<VaultFile | null>) {
    const { stored, snapshot } = target;
    if (change.remoteRevision !== undefined) stored.remoteRevision = snapshot.remoteRevision = change.remoteRevision;
    if (change.pulledRevision !== undefined) {
      if (change.pulledRevision === null) { delete stored.pulledRevision; delete snapshot.pulledRevision; }
      else stored.pulledRevision = snapshot.pulledRevision = change.pulledRevision;
    }
    if (change.dismissedRecoveryIds !== undefined) {
      if (change.dismissedRecoveryIds === null) { delete stored.dismissedRecoveryIds; delete snapshot.dismissedRecoveryIds; }
      else stored.dismissedRecoveryIds = snapshot.dismissedRecoveryIds = change.dismissedRecoveryIds;
    }
    for (const [path, ref] of Object.entries(change.files ?? {})) {
      if (!validVaultPath(path)) throw new Error("Invalid path in local vault.");
      if (ref) { stored.files[path] = ref; snapshot.files[path] = (await decode(ref))!; }
      else { delete stored.files[path]; delete snapshot.files[path]; }
    }
    for (const [path, base] of Object.entries(change.base ?? {})) {
      if (base) { stored.base[path] = base; snapshot.base[path] = Object.freeze({ revision: base.revision, file: await decode(base.file) }); }
      else { delete stored.base[path]; delete snapshot.base[path]; }
    }
    if (change.deferred) {
      const deferred = { ...stored.deferred };
      for (const [path, entry] of Object.entries(change.deferred)) {
        if (entry && validVaultPath(path) && typeof entry.revision === "string") deferred[path] = Object.freeze({ ...entry });
        else delete deferred[path];
      }
      if (Object.keys(deferred).length) stored.deferred = snapshot.deferred = deferred;
      else { delete stored.deferred; delete snapshot.deferred; }
    }
    if (change.conflicts) {
      stored.conflicts = change.conflicts;
      snapshot.conflicts = [];
      for (const { local, remote, base, result, ...metadata } of change.conflicts) snapshot.conflicts.push(Object.freeze({ ...metadata,
        local: await decode(local), remote: await decode(remote),
        ...(base !== undefined ? { base: await decode(base) } : {}),
        ...(result !== undefined ? { result: await decode(result) } : {}),
      }));
    }
    if (change.directoryBaselines !== undefined) {
      if (change.directoryBaselines === null) { delete stored.directoryBaselines; delete snapshot.directoryBaselines; }
      else {
        stored.directoryBaselines = change.directoryBaselines;
        snapshot.directoryBaselines = {};
        for (const [id, baseline] of Object.entries(change.directoryBaselines)) {
          const files: Record<string, VaultFile> = {};
          for (const [path, ref] of Object.entries(baseline.files)) {
            if (!validVaultPath(path)) throw new Error("Invalid path in local folder history.");
            files[path] = (await decode(ref))!;
          }
          const stats = validDirectoryStats(baseline.stats);
          snapshot.directoryBaselines[id] = { manifest: baseline.manifest, files, ...(stats ? { stats } : {}) };
        }
      }
    }
  }

  /** The complete stored state, expressed as one change from an empty vault. */
  function asChange(stored: StoredSnapshot): StoredChange {
    return {
      remoteRevision: Number.isSafeInteger(stored.remoteRevision) ? stored.remoteRevision : 0,
      ...(Number.isSafeInteger(stored.pulledRevision) && stored.pulledRevision! >= 0 && stored.pulledRevision! <= stored.remoteRevision
        ? { pulledRevision: stored.pulledRevision } : {}),
      ...(Array.isArray(stored.dismissedRecoveryIds) ? { dismissedRecoveryIds: stored.dismissedRecoveryIds } : {}),
      files: stored.files, base: stored.base,
      ...(stored.deferred && typeof stored.deferred === "object" ? { deferred: stored.deferred } : {}),
      conflicts: stored.conflicts,
      ...(stored.directoryBaselines ? { directoryBaselines: stored.directoryBaselines } : {}),
    };
  }

  async function readChange(journal: FileSystemDirectoryHandle, generation: number) {
    step = `reading journal/${generation}.json`;
    const text = await readText(journal, `${generation}.json`);
    if (text === null) throw unreadable();
    return { change: JSON.parse(text) as StoredChange, bytes: text.length };
  }

  /** Bring this tab's decoded vault up to date with what is on disk. */
  async function load(): Promise<Memo | null> {
    const root = await directory();
    const head = await readHead(root);
    step = "opening history";
    const history = await root.getDirectoryHandle("history", { create: true });
    if (!head) {
      // A vault saved before the journal existed: one index of every reference.
      step = `reading ${LEGACY_INDEX}`;
      const legacy = await readText(root, LEGACY_INDEX);
      memo = null;
      if (legacy === null) return null;
      const stored = JSON.parse(legacy) as StoredSnapshot;
      if (stored.schemaVersion !== 1 || !stored.files || !stored.base || !Array.isArray(stored.conflicts)) {
        throw new Error("The local vault index could not be read. Its Markdown history has been preserved.");
      }
      const loaded: Memo = { checkpoint: LEGACY_INDEX, from: 0, generation: 0, stored: emptyStored(), snapshot: emptyVault(),
        checkpointBytes: legacy.length, journalBytes: 0 };
      await applyChange(loaded, asChange(stored), decoder(history, new Map()));
      return memo = loaded;
    }
    if (memo && memo.checkpoint === head.checkpoint && memo.generation === head.generation) return memo;
    step = "opening journal";
    const journal = await root.getDirectoryHandle("journal", { create: true });
    if (memo && memo.checkpoint === head.checkpoint && memo.generation >= head.from && memo.generation < head.generation) {
      // Another tab saved since this one last looked. Apply only those saves.
      const next: Memo = { ...memo, stored: cloneStored(memo.stored), snapshot: view(memo.snapshot) };
      const decode = decoder(history, knownFiles(memo));
      for (let generation = memo.generation + 1; generation <= head.generation; generation += 1) {
        const { change, bytes } = await readChange(journal, generation);
        await applyChange(next, change, decode);
        next.journalBytes += bytes;
      }
      next.generation = head.generation;
      return memo = next;
    }
    step = `reading ${head.checkpoint}`;
    const text = await readText(root, head.checkpoint);
    if (text === null) throw unreadable();
    const stored = JSON.parse(text) as StoredSnapshot;
    if (stored.schemaVersion !== 1 || !stored.files || !stored.base || !Array.isArray(stored.conflicts)) throw unreadable();
    const decode = decoder(history, knownFiles(memo));
    const loaded: Memo = { checkpoint: head.checkpoint, from: head.from, generation: head.generation, stored: emptyStored(), snapshot: emptyVault(),
      checkpointBytes: text.length, journalBytes: 0 };
    await applyChange(loaded, asChange(stored), decode);
    for (let generation = head.from + 1; generation <= head.generation; generation += 1) {
      const { change, bytes } = await readChange(journal, generation);
      await applyChange(loaded, change, decode);
      loaded.journalBytes += bytes;
    }
    return memo = loaded;
  }

  return {
    async lock<T>(operation: () => Promise<T>) {
      if (!navigator.locks) throw new Error("This browser cannot safely coordinate local saves. Update your browser before editing this vault.");
      return navigator.locks.request(`margin-chat-vault:${userId}`, operation);
    },
    async read() {
      try {
        const current = await load();
        return current ? view(current.snapshot) : null;
      } catch (error) {
        memo = null;
        // readFreshFile already retried and read the file directly; it is unreadable here.
        if (error instanceof UnreadableFileError) {
          throw new Error(`This browser could not read “${error.fileName}” from the vault saved on this device (${error.detail}).`, { cause: error });
        }
        // Name the step instead of showing the browser's bare message.
        if (error instanceof DOMException && error.name !== "NotFoundError") throw new LocalVaultUnavailableError(step, error);
        throw error;
      }
    },
    async write(snapshot) {
      const root = await directory();
      const history = await root.getDirectoryHandle("history", { create: true });
      // A damaged or unreadable previous state must not prevent saving a complete new one.
      let previous: Memo | null = null;
      try { previous = await load(); } catch { memo = null; }
      const head = await readHead(root).catch(() => null);
      const verified = new Set<string>();
      async function storeFile(file: VaultFile, path: string, before?: VaultFile | null, beforeRef?: FileRef | null): Promise<FileRef> {
        if (before && beforeRef && sameFile(before, file) && !lossy.has(before)) return beforeRef;
        const bytes = vaultFileBytes(file);
        const hash = await hashBytes(bytes);
        const extension = file.encoding === "base64" ? "bin" : path.endsWith(".md") ? "md" : path.endsWith(".json") ? "json" : "txt";
        const object = `${hash}.${extension}`;
        if (!verified.has(object)) {
          let existing: Uint8Array | null = null;
          try { existing = await readFreshBytes(() => history.getFileHandle(object)); }
          catch (error) {
            if (!(error instanceof DOMException && error.name === "NotFoundError")) throw error;
          }
          // An aborted write or interrupted process may have created this name
          // without its content. A filename alone is never a durable receipt.
          if (!existing || existing.length !== bytes.length || !existing.every((value, index) => value === bytes[index])) {
            await writeFile(history, object, bytes);
          }
          verified.add(object);
        }
        return { object, ...(file.encoding ? { encoding: file.encoding } : {}), ...(file.contentType ? { contentType: file.contentType } : {}) };
      }
      const prior = previous?.snapshot;
      const priorStored = previous?.stored;
      const next: Memo = { checkpoint: previous?.checkpoint ?? "", from: previous?.from ?? 0, generation: previous?.generation ?? 0,
        stored: emptyStored(), snapshot: emptyVault(), checkpointBytes: previous?.checkpointBytes ?? 0, journalBytes: previous?.journalBytes ?? 0 };
      const change: StoredChange = {};
      next.stored.remoteRevision = next.snapshot.remoteRevision = snapshot.remoteRevision;
      if (snapshot.remoteRevision !== priorStored?.remoteRevision) change.remoteRevision = snapshot.remoteRevision;
      if (snapshot.pulledRevision !== undefined) next.stored.pulledRevision = next.snapshot.pulledRevision = snapshot.pulledRevision;
      if (snapshot.pulledRevision !== priorStored?.pulledRevision) change.pulledRevision = snapshot.pulledRevision ?? null;
      if (snapshot.dismissedRecoveryIds) next.stored.dismissedRecoveryIds = next.snapshot.dismissedRecoveryIds = [...snapshot.dismissedRecoveryIds];
      if (JSON.stringify(snapshot.dismissedRecoveryIds) !== JSON.stringify(priorStored?.dismissedRecoveryIds)) change.dismissedRecoveryIds = snapshot.dismissedRecoveryIds ?? null;

      for (const [path, file] of Object.entries(snapshot.files)) {
        if (!validVaultPath(path)) throw new Error("Invalid vault file path.");
        const ref = await storeFile(file, path, prior?.files[path], priorStored?.files[path]);
        next.stored.files[path] = ref;
        next.snapshot.files[path] = sameRef(ref, priorStored?.files[path]) && prior?.files[path] ? prior.files[path] : asRead(file);
        if (!sameRef(ref, priorStored?.files[path])) (change.files ??= {})[path] = ref;
      }
      for (const path of Object.keys(priorStored?.files ?? {})) if (!snapshot.files[path]) (change.files ??= {})[path] = null;

      for (const [path, base] of Object.entries(snapshot.base)) {
        const before = priorStored?.base[path];
        const file = base.file ? await storeFile(base.file, path, prior?.base[path]?.file, before?.file) : null;
        const stored = before && before.revision === base.revision && sameRef(before.file, file) ? before : { revision: base.revision, file };
        next.stored.base[path] = stored;
        next.snapshot.base[path] = stored === before && prior?.base[path] ? prior.base[path]
          : Object.freeze({ revision: base.revision, file: base.file ? asRead(base.file) : null });
        if (stored !== before) (change.base ??= {})[path] = stored;
      }
      for (const path of Object.keys(priorStored?.base ?? {})) if (!snapshot.base[path]) (change.base ??= {})[path] = null;

      if (snapshot.deferred && Object.keys(snapshot.deferred).length) {
        next.stored.deferred = next.snapshot.deferred = {};
        for (const [path, entry] of Object.entries(snapshot.deferred)) {
          const before = priorStored?.deferred?.[path];
          const same = !!before && JSON.stringify(before) === JSON.stringify(entry);
          next.stored.deferred[path] = same ? before : Object.freeze({ ...entry });
          if (!same) (change.deferred ??= {})[path] = next.stored.deferred[path];
        }
      }
      for (const path of Object.keys(priorStored?.deferred ?? {})) if (!snapshot.deferred?.[path]) (change.deferred ??= {})[path] = null;

      const conflictFile = async (file: VaultFile | null | undefined, path: string, id: string, side: "local" | "remote" | "base" | "result") => {
        if (!file) return null;
        const index = prior?.conflicts.findIndex((conflict) => conflict.id === id) ?? -1;
        return storeFile(file, path, index >= 0 ? prior!.conflicts[index][side] : null, index >= 0 ? priorStored!.conflicts[index]?.[side] : null);
      };
      for (const { local, remote, base, result, ...metadata } of snapshot.conflicts) {
        next.stored.conflicts.push({ ...metadata,
          local: await conflictFile(local, metadata.path, metadata.id, "local"), remote: await conflictFile(remote, metadata.path, metadata.id, "remote"),
          ...(base !== undefined ? { base: await conflictFile(base, metadata.path, metadata.id, "base") } : {}),
          ...(result !== undefined ? { result: await conflictFile(result, metadata.path, metadata.id, "result") } : {}),
        });
      }
      if (JSON.stringify(next.stored.conflicts) !== JSON.stringify(priorStored?.conflicts ?? [])) change.conflicts = next.stored.conflicts;
      next.snapshot.conflicts = snapshot.conflicts.map((conflict) => Object.freeze({ ...conflict,
        local: conflict.local && asRead(conflict.local), remote: conflict.remote && asRead(conflict.remote),
        ...(conflict.base !== undefined ? { base: conflict.base && asRead(conflict.base) } : {}),
        ...(conflict.result !== undefined ? { result: conflict.result && asRead(conflict.result) } : {}),
      }));

      if (snapshot.directoryBaselines) {
        next.stored.directoryBaselines = {};
        next.snapshot.directoryBaselines = {};
        for (const [id, baseline] of Object.entries(snapshot.directoryBaselines)) {
          const files: Record<string, FileRef> = {};
          for (const [path, file] of Object.entries(baseline.files)) {
            if (!validVaultPath(path)) throw new Error("Invalid path in local folder history.");
            files[path] = await storeFile(file, path, prior?.directoryBaselines?.[id]?.files[path], priorStored?.directoryBaselines?.[id]?.files[path]);
          }
          const stats = validDirectoryStats(baseline.stats);
          next.stored.directoryBaselines[id] = { manifest: baseline.manifest, files, ...(stats ? { stats } : {}) };
          next.snapshot.directoryBaselines[id] = { manifest: structuredClone(baseline.manifest),
            files: Object.fromEntries(Object.entries(baseline.files).map(([path, file]) => [path, asRead(file)])),
            ...(stats ? { stats: structuredClone(stats) } : {}) };
        }
      }
      if (JSON.stringify(next.stored.directoryBaselines ?? null) !== JSON.stringify(priorStored?.directoryBaselines ?? null)) {
        change.directoryBaselines = next.stored.directoryBaselines ?? null;
      }

      const generation = (head?.generation ?? 0) + 1;
      const changed = Object.keys(change).length > 0;
      const segment = changed ? JSON.stringify(change) : "";
      const compact = !previous || !head || previous.checkpoint === LEGACY_INDEX
        || generation - head.from > COMPACT_SEGMENTS || previous.journalBytes + segment.length > Math.max(1_000_000, previous.checkpointBytes / 4);
      if (!changed && !compact) return;
      if (compact) {
        // A new checkpoint holds everything. The head names it only after it is complete.
        const checkpoint = `vault-checkpoint-${generation}.json`;
        const text = JSON.stringify(next.stored);
        await writeFile(root, checkpoint, text);
        await writeFile(root, HEAD, JSON.stringify({ schemaVersion: 2, checkpoint, from: generation, generation } satisfies JournalHead));
        Object.assign(next, { checkpoint, from: generation, generation, checkpointBytes: text.length, journalBytes: 0 });
        memo = next;
        // Older copies are only cleanup; a failure leaves harmless unused files.
        if (head) {
          await root.removeEntry(head.checkpoint).catch(() => undefined);
          const journal = await root.getDirectoryHandle("journal", { create: true }).catch(() => null);
          for (let old = head.from + 1; journal && old <= head.generation; old += 1) await journal.removeEntry(`${old}.json`).catch(() => undefined);
        }
        // Older versions of the app read only this index. Leave one they reject,
        // so an outdated tab reports an error instead of saving where no one looks.
        const legacy = await readText(root, LEGACY_INDEX).catch(() => null);
        if (legacy !== null && !legacy.includes(`"movedTo"`)) {
          await writeFile(root, LEGACY_INDEX, JSON.stringify({ schemaVersion: 2, movedTo: HEAD })).catch(() => undefined);
        }
        return;
      }
      const journal = await root.getDirectoryHandle("journal", { create: true });
      await writeFile(journal, `${generation}.json`, segment);
      await writeFile(root, HEAD, JSON.stringify({ schemaVersion: 2, checkpoint: head!.checkpoint, from: head!.from, generation } satisfies JournalHead));
      Object.assign(next, { generation, journalBytes: previous!.journalBytes + segment.length });
      memo = next;
    },
  };
}

function emptyStored(): StoredSnapshot {
  return { schemaVersion: 1, remoteRevision: 0, files: {}, base: {}, conflicts: [] };
}

function cloneStored(stored: StoredSnapshot): StoredSnapshot {
  return { ...stored, files: { ...stored.files }, base: { ...stored.base }, conflicts: [...stored.conflicts],
    ...(stored.deferred ? { deferred: { ...stored.deferred } } : {}) };
}

/** A copy whose maps the caller may change; the files themselves are shared and frozen. */
function view(snapshot: VaultSnapshot): VaultSnapshot {
  return { ...snapshot, files: { ...snapshot.files }, base: { ...snapshot.base }, conflicts: [...snapshot.conflicts],
    ...(snapshot.deferred ? { deferred: { ...snapshot.deferred } } : {}),
    ...(snapshot.dismissedRecoveryIds ? { dismissedRecoveryIds: [...snapshot.dismissedRecoveryIds] } : {}),
    ...(snapshot.directoryBaselines ? { directoryBaselines: { ...snapshot.directoryBaselines } } : {}) };
}

/** A vault kept only in this tab's memory. The cloud fills it, and it is gone when the tab closes. */
export function createMemoryVaultStore(): VaultStore {
  let current: VaultSnapshot | null = null;
  let tail = Promise.resolve();
  return {
    lock<T>(operation: () => Promise<T>): Promise<T> {
      const result = tail.then(operation);
      tail = result.then(() => undefined, () => undefined);
      return result;
    },
    async read() { return current ? view(current) : null; },
    async write(snapshot) { current = view(snapshot); },
  };
}

/**
 * This device's saved copy of the vault, unless the browser refuses to open it at all and
 * `fallBack` agrees: then an empty copy in memory, which the cloud fills, for the rest of the session.
 */
export function createVaultStoreWithMemoryFallback(saved: VaultStore, fallBack: (error: LocalVaultUnavailableError) => boolean): VaultStore & {
  inMemory(): boolean; refused(): LocalVaultUnavailableError | null;
} {
  let memory: VaultStore | null = null;
  let refused: LocalVaultUnavailableError | null = null;
  return {
    inMemory: () => memory !== null,
    refused: () => refused,
    lock(operation) { return (memory ?? saved).lock(operation); },
    async read() {
      if (memory) return memory.read();
      try { return await saved.read(); } catch (error) {
        if (!(error instanceof LocalVaultUnavailableError) || !fallBack(error)) throw error;
        refused = error;
        console.error("Margin Chat opened the vault in memory because the browser refused its storage", error);
        memory = createMemoryVaultStore();
        return null;
      }
    },
    write(snapshot) { return (memory ?? saved).write(snapshot); },
  };
}

export function exportVault(snapshot: VaultSnapshot): Uint8Array {
  const files: Record<string, Uint8Array> = {};
  for (const [path, file] of Object.entries(snapshot.files)) files[path] = vaultFileBytes(file);
  const info = {
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    files: Object.fromEntries(Object.entries(snapshot.files).map(([path, file]) => [path, { encoding: file.encoding, contentType: file.contentType }])),
  };
  files["vault-export.json"] = strToU8(JSON.stringify(info, null, 2));
  return zipSync(files, { level: 6 });
}

/** `include` leaves out entries such as a Mac's `__MACOSX` copies before they are read. */
export function importVault(bytes: Uint8Array, include: (path: string) => boolean = () => true): Record<string, VaultFile> {
  if (bytes.length > 100_000_000) throw new Error("Please import a vault smaller than 100 MB.");
  let total = 0;
  const archive = unzipSync(bytes, { filter: (entry) => {
    if (!include(entry.name)) return false;
    total += entry.originalSize;
    if (total > 200_000_000 || entry.originalSize > 20_000_000) throw new Error("The expanded vault is too large to import.");
    if (!entry.name.endsWith("/") && !validVaultPath(entry.name)) throw new Error("The archive contains an invalid file path.");
    return !entry.name.endsWith("/");
  } });
  const info = archive["vault-export.json"] ? JSON.parse(new TextDecoder().decode(archive["vault-export.json"])) : { files: {} };
  const files: Record<string, VaultFile> = {};
  for (const [path, data] of Object.entries(archive)) {
    if (path === "vault-export.json") continue;
    const metadata = info.files?.[path] ?? {};
    const binary = metadata.encoding === "base64" || !/\.(md|markdown|json|txt)$/iu.test(path);
    files[path] = { content: binary ? bytesToBase64(data) : new TextDecoder("utf-8", { fatal: true }).decode(data),
      ...(binary ? { encoding: "base64" as const } : {}),
      ...(typeof metadata.contentType === "string" ? { contentType: metadata.contentType } : {}) };
  }
  return files;
}
