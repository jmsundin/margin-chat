// The vault folder interface shared by every filesystem adapter. See index.d.mts.

export function vaultFsError(name, message = name) {
  const error = new Error(message);
  error.name = name;
  return error;
}

export function isVaultFsError(error, name) {
  return error !== null && typeof error === "object" && error.name === name;
}

// eslint-disable-next-line no-control-regex
const UNSAFE_PATH_CHARACTERS = /[\\\u0000-\u001f\u007f]/u;

export function isVaultFsPath(path) {
  return typeof path === "string" && path.length > 0 && !path.startsWith("/") && !UNSAFE_PATH_CHARACTERS.test(path)
    && path.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

export function assertVaultFsPath(path, allowRoot = false) {
  if (allowRoot && path === "") return path;
  if (!isVaultFsPath(path)) throw new TypeError(`Not a path inside the vault folder: ${JSON.stringify(path)}`);
  return path;
}

export function joinVaultFsPath(directory, name) {
  return directory ? `${directory}/${name}` : name;
}

const utf8 = new TextDecoder("utf-8");
const encoder = new TextEncoder();

/** UTF-8 text as a browser's File.text() decodes it: a leading byte-order mark is dropped, bad bytes become U+FFFD. */
export function decodeVaultFsText(bytes) {
  return utf8.decode(bytes);
}

const toBytes = (contents) => typeof contents === "string" ? encoder.encode(contents) : new Uint8Array(contents);
const parentOf = (path) => path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";

export function createMemoryVaultFs(initial = {}, { name = "vault", now = () => Date.now() } = {}) {
  const files = new Map();
  let state = "available";
  const listeners = new Set();
  let clock = 0;
  // Each change gets a later time than the last, even within one millisecond.
  const tick = () => (clock = Math.max(clock + 1, now()));
  for (const [path, contents] of Object.entries(initial)) files.set(assertVaultFsPath(path), { bytes: toBytes(contents), modifiedMs: tick() });

  function fire(paths) { for (const listener of listeners) listener(paths); }
  function ensureAvailable() {
    if (state === "missing") throw vaultFsError("NotFoundError", `The folder “${name}” can't be found.`);
    if (state === "refused") throw vaultFsError("NotAllowedError", `The folder “${name}” can't be opened.`);
  }
  const isDirectory = (path) => path === "" || [...files.keys()].some((file) => file.startsWith(`${path}/`));
  function ensureParent(path) {
    // A file can't hold a folder.
    let parent = parentOf(path);
    while (parent) {
      if (files.has(parent)) throw vaultFsError("TypeMismatchError", `${parent} is a file.`);
      parent = parentOf(parent);
    }
    if (isDirectory(path)) throw vaultFsError("TypeMismatchError", `${path} is a folder.`);
  }

  return {
    name,
    files,
    async *list(directory) {
      ensureAvailable();
      assertVaultFsPath(directory, true);
      if (files.has(directory) || !isDirectory(directory)) throw vaultFsError(files.has(directory) ? "TypeMismatchError" : "NotFoundError", directory);
      const prefix = directory ? `${directory}/` : "";
      const seen = new Map();
      for (const path of files.keys()) {
        if (!path.startsWith(prefix)) continue;
        const [first, ...rest] = path.slice(prefix.length).split("/");
        seen.set(first, rest.length ? "directory" : "file");
      }
      for (const [entry, kind] of seen) yield { name: entry, kind };
    },
    async stat(path) {
      ensureAvailable();
      const file = files.get(assertVaultFsPath(path));
      return file ? { size: file.bytes.length, modifiedMs: file.modifiedMs } : null;
    },
    async read(path) {
      ensureAvailable();
      const file = files.get(assertVaultFsPath(path));
      return file ? { bytes: new Uint8Array(file.bytes), stat: { size: file.bytes.length, modifiedMs: file.modifiedMs } } : null;
    },
    async writeAtomic(path, contents) {
      ensureAvailable();
      ensureParent(assertVaultFsPath(path));
      files.set(path, { bytes: toBytes(contents), modifiedMs: tick() });
      fire([path]);
    },
    async move(from, to) {
      ensureAvailable();
      const file = files.get(assertVaultFsPath(from));
      if (!file) throw vaultFsError("NotFoundError", from);
      if (files.has(assertVaultFsPath(to))) throw vaultFsError("InvalidModificationError", `${to} already exists.`);
      ensureParent(to);
      files.delete(from);
      files.set(to, file);
      fire([from, to]);
    },
    async delete(path) {
      ensureAvailable();
      if (!files.delete(assertVaultFsPath(path))) throw vaultFsError("NotFoundError", path);
      fire([path]);
    },
    async availability() { return state; },
    watch(onChange) {
      listeners.add(onChange);
      return () => { listeners.delete(onChange); };
    },
    put(path, contents, modifiedMs) {
      files.set(assertVaultFsPath(path), { bytes: toBytes(contents), modifiedMs: modifiedMs ?? tick() });
      fire([path]);
    },
    remove(path) {
      if (files.delete(path)) fire([path]);
    },
    setAvailability(next) { state = next; },
  };
}
