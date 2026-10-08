import { apiFetch } from "./apiTransport";
import { ApiError } from "./apiError";
import { validVaultPath, type VaultCommitReceipt, type VaultEntry, type VaultFile, type VaultIndex, type VaultIndexEntry, type VaultManifest, type VaultSearchEvent, type VaultSearchPassage, type VaultTransport } from "./vaultTypes";
import { bytesToBase64, vaultFileBytes } from "./vaultLocal";

const revisionPattern = /^[a-f0-9]{64}$/u;
const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const defaultContentType = (path: string) => /\.md$/iu.test(path) ? "text/markdown; charset=utf-8"
  : path.endsWith(".json") ? "application/json" : "application/octet-stream";

function readManifest(value: unknown): VaultManifest {
  if (!isRecord(value) || value.schemaVersion !== 1 || !Number.isSafeInteger(value.revision)
    || (value.revision as number) < 0 || !isRecord(value.files)) {
    throw new Error("The server returned an invalid vault manifest.");
  }
  const files: Record<string, VaultEntry> = {};
  for (const [path, entry] of Object.entries(value.files)) {
    if (!validVaultPath(path) || !isRecord(entry) || typeof entry.revision !== "string" || !revisionPattern.test(entry.revision)
      || typeof entry.deleted !== "boolean" || (entry.encoding !== undefined && entry.encoding !== "utf8" && entry.encoding !== "base64")
      || (entry.contentType !== undefined && (typeof entry.contentType !== "string" || entry.contentType.length > 160
        || !/^[\w.+-]+\/[\w.+-]+(?:; ?charset=[\w-]+)?$/iu.test(entry.contentType)))) {
      throw new Error("The server returned an invalid vault manifest.");
    }
    files[path] = { revision: entry.revision, deleted: entry.deleted,
      ...(entry.encoding === "base64" ? { encoding: "base64" as const } : {}),
      ...(typeof entry.contentType === "string" ? { contentType: entry.contentType } : {}),
    };
  }
  return { schemaVersion: 1, revision: value.revision as number, files };
}

const optionalString = (value: unknown) => typeof value === "string" && value.length <= 2048 ? value : undefined;

function readIndexEntry(entry: unknown): VaultIndexEntry | null {
  // A malformed row only hides that file from the index; it never blocks opening the vault.
  if (!isRecord(entry) || typeof entry.path !== "string" || !validVaultPath(entry.path) || typeof entry.id !== "string"
    || typeof entry.revision !== "string" || !revisionPattern.test(entry.revision)) return null;
  const parentPath = optionalString(entry.parentPath);
  const linkedPaths = Array.isArray(entry.linkedPaths) ? entry.linkedPaths.filter((path): path is string => typeof path === "string" && validVaultPath(path)) : [];
  return { path: entry.path, id: entry.id, revision: entry.revision,
    type: entry.type === "note" ? "note" : "conversation", kind: entry.kind === "chat" ? "chat" : "note",
    title: optionalString(entry.title)?.slice(0, 300) || entry.path.split("/").pop()!.replace(/\.md$/iu, ""),
    ...(optionalString(entry.created) ? { created: optionalString(entry.created) } : {}),
    ...(optionalString(entry.updated) ? { updated: optionalString(entry.updated) } : {}),
    ...(parentPath && validVaultPath(parentPath) ? { parentPath } : {}),
    ...(linkedPaths.length ? { linkedPaths } : {}),
  };
}

function readIndex(value: unknown): VaultIndex {
  if (!isRecord(value) || !Number.isSafeInteger(value.revision) || !Array.isArray(value.entries)) {
    throw new Error("The server returned an invalid vault index.");
  }
  return { revision: value.revision as number, entries: value.entries.flatMap((entry) => readIndexEntry(entry) ?? []) };
}

const offset = (value: unknown) => Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : null;
const passageSources = { documents: "document", messages: "message", notes: "note" } as const;

function readPassage(value: unknown): VaultSearchPassage | null {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.title !== "string" || typeof value.snippet !== "string"
    || !Object.values(passageSources).includes(value.source as never) || !isRecord(value.match) || !isRecord(value.position)) return null;
  const match = { start: offset(value.match.start), end: offset(value.match.end) };
  const position = { start: offset(value.position.start), end: offset(value.position.end) };
  if (match.start === null || match.end === null || position.start === null || position.end === null) return null;
  const where = value.position;
  const located = Object.fromEntries((["blockId", "messageId", "noteId"] as const)
    .flatMap((key) => typeof where[key] === "string" ? [[key, where[key]]] : []));
  return { id: value.id, title: value.title.slice(0, 300), source: value.source as VaultSearchPassage["source"],
    snippet: value.snippet.slice(0, 1000), match: match as VaultSearchPassage["match"],
    position: { ...located, start: position.start, end: position.end },
    ...(typeof value.path === "string" && validVaultPath(value.path) ? { path: value.path } : {}),
    ...(optionalString(value.updated) ? { updated: optionalString(value.updated) } : {}),
  };
}

function readSearchEvent(value: unknown): VaultSearchEvent | null {
  if (!isRecord(value) || !Array.isArray(value.results) && value.type !== "done" && value.type !== "error") return null;
  if (value.type === "documents") return { type: "documents", results: (value.results as unknown[]).flatMap((entry) => readIndexEntry(entry) ?? []) };
  if (value.type === "passages" && typeof value.source === "string" && Object.hasOwn(passageSources, value.source)) {
    return { type: "passages", source: value.source as keyof typeof passageSources,
      results: (value.results as unknown[]).flatMap((passage) => readPassage(passage) ?? []),
      ...(typeof value.error === "string" ? { error: value.error.slice(0, 300) } : {}) };
  }
  if (value.type === "done" && Number.isSafeInteger(value.revision)) {
    return { type: "done", revision: value.revision as number,
      ...(Number.isSafeInteger(value.indexedRevision) || value.indexedRevision === null ? { indexedRevision: value.indexedRevision as number | null } : {}) };
  }
  if (value.type === "error") return { type: "error", error: typeof value.error === "string" ? value.error.slice(0, 300) : "Search stopped before it finished." };
  return null;
}

const isNdjson = (response: Response) => (response.headers.get("content-type") ?? "").includes("application/x-ndjson") && !!response.body;

/** Each JSON line of a streamed response, as it arrives. */
async function* ndjsonLines(response: Response): AsyncGenerator<unknown> {
  const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += value;
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) yield JSON.parse(line);
        newline = buffer.indexOf("\n");
      }
    }
    if (buffer.trim()) yield JSON.parse(buffer);
  } finally {
    reader.releaseLock();
  }
}

async function fileRevision(bytes: Uint8Array, encoding: "base64" | undefined, contentType: string): Promise<string> {
  // The server addresses immutable files by the hash of metadata plus exact bytes.
  // Verify that receipt before accepting a download or acknowledging an upload.
  const prefix = new TextEncoder().encode(`${encoding ?? "utf8"}\n${contentType}\n`);
  const input = new Uint8Array(prefix.length + bytes.length);
  input.set(prefix); input.set(bytes, prefix.length);
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", input.buffer))]
    .map((value) => value.toString(16).padStart(2, "0")).join("");
}

async function request(path: string, init?: RequestInit) {
  const response = await apiFetch(path, { credentials: "same-origin", cache: "no-store", signal: AbortSignal.timeout(30_000), ...init });
  if (!response.ok) {
    const payload = await response.json().catch(() => null);
    throw new ApiError(response.status, payload?.error ?? "Unable to synchronize the vault.");
  }
  return response;
}

export function createVaultTransport(userId?: string, onProjectionStatus?: (status: "pending" | "ready") => void): VaultTransport {
  const accountRequest = (path: string, init?: RequestInit) => request(path, {
    ...init,
    headers: { ...Object.fromEntries(new Headers(init?.headers)), ...(userId ? { "X-Margin-Vault-User": userId } : {}) },
  });
  const reportProjection = (projection: unknown) => {
    if (isRecord(projection) && (projection.status === "pending" || projection.status === "ready")) onProjectionStatus?.(projection.status);
  };
  return {
    async manifest(): Promise<VaultManifest> {
      const payload = await (await accountRequest("/api/vault")).json();
      if (payload?.configured === false) throw new Error("Cloud vault storage has not been configured. Your files are saved on this device.");
      const manifest = readManifest(payload?.manifest);
      reportProjection(payload?.projection);
      return manifest;
    },
    async changes(since: number): Promise<VaultManifest> {
      const payload = await (await accountRequest(`/api/vault/changes?${new URLSearchParams({ since: String(since) })}`)).json();
      if (payload?.configured === false) throw new Error("Cloud vault storage has not been configured. Your files are saved on this device.");
      const changes = readManifest({ schemaVersion: 1, revision: payload?.revision, files: payload?.files });
      reportProjection(payload?.projection);
      return changes;
    },
    async index(onProgress?: (index: VaultIndex) => void): Promise<VaultIndex> {
      // A large index streams for longer than an ordinary request may take.
      const response = await accountRequest("/api/vault/index", { headers: { Accept: "application/x-ndjson" }, signal: AbortSignal.timeout(300_000) });
      if (!isNdjson(response)) {
        const payload = await response.json();
        if (payload?.configured === false) throw new Error("Cloud vault storage has not been configured. Your files are saved on this device.");
        return readIndex(payload);
      }
      let revision: number | null = null;
      const entries: VaultIndexEntry[] = [];
      let reported = 50;
      for await (const line of ndjsonLines(response)) {
        if (revision === null) {
          if (!isRecord(line) || line.type !== "index") throw new Error("The server returned an invalid vault index.");
          if (line.configured === false) throw new Error("Cloud vault storage has not been configured. Your files are saved on this device.");
          if (!Number.isSafeInteger(line.revision)) throw new Error("The server returned an invalid vault index.");
          revision = line.revision as number;
          continue;
        }
        const entry = readIndexEntry(line);
        if (entry) entries.push(entry);
        // Report at doubling sizes so the copies stay proportional to the index.
        if (onProgress && entries.length >= reported) {
          reported *= 2;
          onProgress({ revision, entries: [...entries] });
        }
      }
      if (revision === null) throw new Error("The server returned an invalid vault index.");
      return { revision, entries };
    },
    async search(query, { limit = 20, signal } = {}, onEvent) {
      const response = await accountRequest(`/api/vault/search?${new URLSearchParams({ q: query, limit: String(limit) })}`, {
        headers: { Accept: "application/x-ndjson" },
        signal: signal && typeof AbortSignal.any === "function" ? AbortSignal.any([signal, AbortSignal.timeout(60_000)]) : signal ?? AbortSignal.timeout(60_000),
      });
      if (!isNdjson(response)) throw new Error("This server cannot search the vault yet.");
      for await (const line of ndjsonLines(response)) {
        if (signal?.aborted) return;
        const event = readSearchEvent(line);
        if (event) onEvent(event);
      }
    },
    async read(path: string, entry: VaultEntry): Promise<VaultFile> {
      const response = await accountRequest(`/api/vault/file?${new URLSearchParams({ path, revision: entry.revision })}`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (await fileRevision(bytes, entry.encoding === "base64" ? "base64" : undefined, entry.contentType ?? defaultContentType(path)) !== entry.revision) {
        throw new Error("A downloaded vault file does not match its saved revision. Your local files are preserved; retry cloud sync.");
      }
      return { content: entry.encoding === "base64"
        ? bytesToBase64(bytes) : new TextDecoder("utf-8", { fatal: true }).decode(bytes),
        ...(entry.encoding === "base64" ? { encoding: "base64" as const } : {}),
        ...(entry.contentType ? { contentType: entry.contentType } : {}),
      };
    },
    async commit(changes): Promise<VaultCommitReceipt> {
      let manifest: VaultManifest;
      let projection: unknown;
      let previousRevision: unknown;
      if (changes.length === 1 && changes[0].encoding === "base64" && changes[0].content !== null) {
        const change = changes[0];
        const payload = await (await accountRequest(`/api/vault/file?${new URLSearchParams({ path: change.path, baseRevision: change.baseRevision ?? "", acknowledge: "changes" })}`, {
          method: "PUT", headers: { "Content-Type": change.contentType ?? "application/octet-stream", "X-Margin-Vault-Write": "1" },
          body: new Uint8Array(vaultFileBytes({ content: change.content!, encoding: "base64" })).buffer,
        })).json();
        manifest = readManifest(payload?.manifest);
        projection = payload?.projection;
        previousRevision = payload?.previousRevision;
      } else {
        const payload = await (await accountRequest("/api/vault/commit?acknowledge=changes", {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ changes }),
        })).json();
        manifest = readManifest(payload?.manifest);
        projection = payload?.projection;
        previousRevision = payload?.previousRevision;
      }
      for (const change of changes) {
        const entry = manifest.files[change.path];
        if (!entry || entry.deleted !== (change.content === null)) throw new Error("The server did not acknowledge a saved file.");
        if (change.content === null) continue;
        const contentType = change.contentType ?? (changes.length === 1 && change.encoding === "base64"
          ? "application/octet-stream" : defaultContentType(change.path));
        const revision = await fileRevision(vaultFileBytes({ content: change.content, encoding: change.encoding }), change.encoding, contentType);
        if (entry.revision !== revision) throw new Error("The server did not acknowledge the uploaded file contents. Your edits remain saved locally; retry cloud sync.");
      }
      reportProjection(projection);
      return Number.isSafeInteger(previousRevision) && (previousRevision as number) >= 0 && (previousRevision as number) <= manifest.revision
        ? { ...manifest, previousRevision: previousRevision as number } : manifest;
    },
  };
}
