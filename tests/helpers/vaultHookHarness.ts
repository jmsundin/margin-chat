import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Window } from "happy-dom";
import { createVaultService } from "../../server/vault/index.mjs";
import { createFileVaultStorage } from "../../server/vault/storage.mjs";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
const browser = new Window({ url: "http://fixture.test" });
for (const name of ["window", "document", "navigator", "HTMLElement", "Event", "localStorage"]) {
  Object.defineProperty(globalThis, name, { configurable: true, value: name === "window" ? browser : (browser as any)[name] });
}
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
let writeGate: ReturnType<typeof deferred> | null = null;
let writeEntered: ReturnType<typeof deferred> | null = null;
let failLocalWrites = false;
function directory(name: string): any {
  const entries = new Map<string, any>();
  return {
    name, kind: "directory",
    queryPermission: async () => "granted",
    async *entries() { yield* entries.entries(); },
    async removeEntry(child: string) { entries.delete(child); },
    async getDirectoryHandle(child: string, options: any = {}) {
      if (!entries.has(child) && options.create) entries.set(child, directory(child));
      if (!entries.has(child)) throw new DOMException("Missing directory", "NotFoundError");
      return entries.get(child);
    },
    async getFileHandle(child: string, options: any = {}) {
      if (!entries.has(child) && options.create) {
        let contents = Buffer.alloc(0);
        entries.set(child, {
          name: child, kind: "file",
          getFile: async () => new File([contents], child),
          async createWritable() {
            let pending = contents;
            return {
              write: async (value: any) => { pending = Buffer.from(value); },
              abort: async () => undefined,
              async close() {
                if (child === "vault-state.json" && failLocalWrites) throw new DOMException("Injected local disk failure", "QuotaExceededError");
                if (child === "vault-state.json" && writeGate) {
                  const gate = writeGate;
                  writeGate = null;
                  writeEntered?.resolve();
                  await gate.promise;
                }
                contents = pending;
              },
            };
          },
        });
      }
      if (!entries.has(child)) throw new DOMException("Missing file", "NotFoundError");
      return entries.get(child);
    },
  };
}
const opfs = directory("root");
const connectedFolder = directory("Connected preview folder");
const storedDirectories = new Map<string, any>();
Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: {
  open() {
    const request: any = {};
    queueMicrotask(() => {
      request.result = {
        close() {}, objectStoreNames: { contains: () => true },
        transaction() {
          const transaction: any = { objectStore: () => ({
            get(id: string) {
              const result: any = {};
              queueMicrotask(() => { result.result = storedDirectories.get(id); result.onsuccess?.(); });
              return result;
            },
            put(handle: any, id: string) { storedDirectories.set(id, handle); queueMicrotask(() => transaction.oncomplete?.()); },
            delete(id: string) { storedDirectories.delete(id); queueMicrotask(() => transaction.oncomplete?.()); },
          }) };
          return transaction;
        },
      };
      request.onsuccess?.();
    });
    return request;
  },
} });
(browser as any).showDirectoryPicker = async () => connectedFolder;
Object.defineProperty(browser.navigator, "storage", { value: { getDirectory: async () => opfs, persist: async () => true } });
const locks = new Map<string, Promise<unknown>>();
Object.defineProperty(browser.navigator, "locks", { value: {
  request(name: string, operation: () => Promise<unknown>) {
    const next = (locks.get(name) ?? Promise.resolve()).then(operation);
    locks.set(name, next.catch(() => undefined));
    return next;
  },
} });
const { act, createElement, useState } = await import("../../client/node_modules/react/index.js");
const { createRoot } = await import("../../client/node_modules/react-dom/client.js");
const { createEmptyState } = await import("../../client/src/initialState");
const { useMarkdownVault } = await import("../../client/src/lib/useMarkdownVault");
const { createBrowserVaultStore, exportVault } = await import("../../client/src/lib/vaultLocal");
const { emptyVault } = await import("../../client/src/lib/vaultTypes");
const user: any = {
  id: "preview-hook", displayName: "Fixture", email: "fixture@example.test", role: "admin",
  billing: { accessKind: "admin" }, apiKeys: { byProvider: {}, hasAny: false },
};
const storageDirectory = await mkdtemp(join(tmpdir(), "margin-chat-hook-test-"));
const remote = createVaultService({ storage: createFileVaultStorage(storageDirectory), env: {} });
await remote.commit(user.id, [{ path: "Notes/phone.md", content: "# From phone\n\nCloud Markdown arrived.", baseRevision: null }]);
const initialNetwork = deferred();
const networkEntered = deferred();
let networkReleased = false;
globalThis.fetch = (async (input: any, init: any) => {
  const url = new URL(String(input), "http://fixture.test");
  if (url.pathname === "/api/vault") {
    if (!networkReleased) { networkEntered.resolve(); await initialNetwork.promise; }
    return Response.json(await remote.status(user.id));
  }
  if (url.pathname === "/api/vault/file") {
    if (init?.method === "PUT") return Response.json(await remote.commitBinary(user.id, {
      path: url.searchParams.get("path"), baseRevision: url.searchParams.get("baseRevision") || null,
      bytes: Buffer.from(init.body), contentType: new Headers(init.headers).get("Content-Type"),
    }));
    const source = await remote.readFile({ userId: user.id, path: url.searchParams.get("path"), revision: url.searchParams.get("revision") });
    return new Response(source.bytes, { headers: { "Content-Type": source.contentType } });
  }
  if (url.pathname === "/api/vault/commit") return Response.json(await remote.commit(user.id, JSON.parse(init.body).changes));
  throw new Error(`Unexpected fixture request: ${url.pathname}`);
}) as typeof fetch;
let current: any;
function Host() {
  const [state, setState] = useState(createEmptyState);
  const vault = useMarkdownVault({ user, state, setState, legacyHasState: false });
  current = { state, setState, vault };
  return createElement("div", null, vault.ready ? "ready" : "loading");
}
const container = browser.document.createElement("div");
browser.document.body.append(container);
let root = createRoot(container as unknown as Element);
const local = createBrowserVaultStore(user.id);
async function until(predicate: () => boolean | Promise<boolean>, reason: string, timeout = 2500) {
  const expires = Date.now() + timeout;
  while (Date.now() < expires) {
    if (await predicate()) return;
    await act(async () => { await new Promise((done) => setTimeout(done, 5)); });
  }
  throw new Error(reason);
}
function type(content: string) {
  current.setState((state: any) => ({ ...state, conversations: {
    ...state.conversations,
    [state.rootId]: { ...state.conversations[state.rootId], title: "Local drafting", messages: [
      { id: "typed-message", role: "user", createdAt: "2026-09-13T00:00:00.000Z", content },
    ] },
  } }));
}
try {
  await act(async () => { root.render(createElement(Host)); });
  await until(() => current?.vault.ready, "Local editor waited for the cloud before becoming ready.");
  await networkEntered.promise;
  await act(async () => { type("Typed while the cloud is still pending."); });
  await until(async () => Object.values((await local.read())?.files ?? {}).some((file: any) => file.content.includes("Typed while the cloud is still pending.")),
    "A pending network request blocked the local Markdown save.");
  assert.equal(networkReleased, false);
  networkReleased = true;
  initialNetwork.resolve();
  await until(() => Object.values(current.state.conversations).some((conversation: any) => conversation.title === "From phone"),
    "Actual UTF-8 cloud Markdown was not hydrated into the editor.");
  assert(Object.values(current.state.conversations).some((conversation: any) => conversation.messages.some((message: any) => message.content === "Typed while the cloud is still pending.")),
    "Hydration lost typing that occurred during the initial request.");

  const slowWrite = deferred();
  writeEntered = deferred();
  writeGate = slowWrite;
  await act(async () => { type("First edit while OPFS closes."); });
  await writeEntered.promise;
  await act(async () => { type("Newest edit during the pending OPFS write."); });
  const refresh = current.vault.syncNow();
  slowWrite.resolve();
  await act(async () => { await refresh; });
  assert(Object.values(current.state.conversations).some((conversation: any) => conversation.messages.some((message: any) => message.content === "Newest edit during the pending OPFS write.")),
    "Publishing an earlier snapshot replaced the newest editor text.");
  assert(Object.values((await local.read())?.files ?? {}).some((file: any) => file.content.includes("Newest edit during the pending OPFS write.")),
    "Newest typing was marked saved without reaching durable Markdown.");

  const importedVault = emptyVault();
  importedVault.files = {
    "Notes/imported.md": { content: "# Imported note\n\nImported content survives concurrent typing." },
    "Attachments/raw.bin": { content: "AP8BAg==", encoding: "base64", contentType: "application/octet-stream" },
  };
  const archive = new File([exportVault(importedVault)], "import.zip", { type: "application/zip" });
  const importGate = deferred();
  writeEntered = deferred();
  writeGate = importGate;
  const importing = current.vault.importArchive(archive);
  await writeEntered.promise;
  await act(async () => { type("Typing continued while a vault was importing."); });
  importGate.resolve();
  await act(async () => { await importing; });
  assert(Object.values(current.state.conversations).some((conversation: any) => conversation.title === "Imported note"), "Imported note disappeared while reconciling concurrent typing.");
  assert(Object.values(current.state.conversations).some((conversation: any) => conversation.messages.some((message: any) => message.content === "Typing continued while a vault was importing.")), "Import replaced concurrent editor typing.");

  let exportsCreated = 0;
  const createObjectURL = URL.createObjectURL;
  URL.createObjectURL = (() => { exportsCreated++; return "blob:fixture-export"; }) as typeof URL.createObjectURL;
  failLocalWrites = true;
  await act(async () => { type("This edit must not be silently omitted from a download."); });
  await until(() => Boolean(current.vault.localSaveError), "A local durable-write failure was not reported.");
  await act(async () => { await assert.rejects(current.vault.download(), /Injected local disk failure/); });
  assert.equal(exportsCreated, 0, "A failed durable write still produced an incomplete vault download.");
  URL.createObjectURL = createObjectURL;
  failLocalWrites = false;
  await act(async () => { await current.vault.flushLocal(); });

  await act(async () => { await current.vault.chooseDirectory(); });
  const attachmentFolder = await connectedFolder.getDirectoryHandle("Attachments");
  const companionBytes = new Uint8Array(await (await (await attachmentFolder.getFileHandle("raw.bin")).getFile()).arrayBuffer());
  assert.deepEqual([...companionBytes], [0, 255, 1, 2], "Connected folder did not receive original companion bytes.");
  const settingsHandle = await connectedFolder.getFileHandle("workspace.json");
  const settings = JSON.parse(await (await settingsHandle.getFile()).text());
  settings.workspace.preferences.externalSetting = "Retain external companion changes";
  const settingsWriter = await settingsHandle.createWritable();
  await settingsWriter.write(JSON.stringify(settings, null, 2));
  await settingsWriter.close();
  await act(async () => { await current.vault.syncNow(); });
  assert.equal(JSON.parse((await local.read())!.files["workspace.json"].content).workspace.preferences.externalSetting, "Retain external companion changes",
    "A connected folder settings edit was overwritten during synchronization.");
  await act(async () => { await current.vault.clearDirectory(); });

  const normalFetch = globalThis.fetch;
  const automaticGate = deferred();
  const automaticEntered = deferred();
  let automaticManifestRequests = 0;
  globalThis.fetch = (async (input: any, init: any) => {
    if (new URL(String(input), "http://fixture.test").pathname === "/api/vault") {
      automaticManifestRequests++;
      automaticEntered.resolve();
      await automaticGate.promise;
    }
    return normalFetch(input, init);
  }) as typeof fetch;
  await act(async () => { browser.dispatchEvent(new browser.Event("focus")); });
  await automaticEntered.promise;
  await act(async () => {
    for (let index = 0; index < 30; index++) browser.dispatchEvent(new browser.Event("focus"));
  });
  automaticGate.resolve();
  await act(async () => { await new Promise((done) => setTimeout(done, 80)); });
  assert.equal(automaticManifestRequests, 1, "Repeated automatic triggers accumulated cloud requests behind a slow sync.");
  globalThis.fetch = normalFetch;

  const beforeConflict = (await local.read())!;
  const changedPath = Object.entries(beforeConflict.files).find(([path, file]) => path.endsWith(".md") && file.content.includes("This edit must not be silently omitted from a download."))![0];
  const remoteBeforeConflict = await remote.snapshot(user.id);
  const remotePlain = "# Remote plain note\n\nThe remote version remains current after conflict review.\n";
  await act(async () => { type("Preserve this local version as a conflict."); });
  await act(async () => { await current.vault.flushLocal(); });
  await remote.commit(user.id, [{
    path: changedPath,
    baseRevision: remoteBeforeConflict.manifest.files[changedPath].revision,
    content: remotePlain,
  }]);
  await act(async () => { await current.vault.syncNow(); });
  await act(async () => { await new Promise((done) => setTimeout(done, 1100)); });
  assert((await remote.readFile({ userId: user.id, path: changedPath })).bytes.toString().includes("The remote version remains current after conflict review."),
    "The hook rewrote a conflicted remote document without a new editor change.");
  assert((await local.read())!.conflicts.some((conflict: any) => conflict.local?.content.includes("Preserve this local version as a conflict.")),
    "The offline version was not retained for review.");
  // A device-only UI change must not auto-stamp the conflicting plain remote
  // file and make its preserved local version impossible to select.
  await act(async () => { current.setState((state: any) => ({ ...state, railOpen: !state.railOpen })); });
  await act(async () => { await current.vault.flushLocal(); });
  const plainConflict = (await local.read())!.conflicts.find((conflict: any) => conflict.path === changedPath)!;
  assert(plainConflict, "The plain Markdown conflict was not available for resolution.");
  assert.equal((await local.read())!.files[changedPath].content, remotePlain,
    "Saving unchanged content rewrote the plain remote file before conflict resolution.");
  await act(async () => { await current.vault.resolveConflict(plainConflict.id, "local"); });
  assert((await remote.readFile({ userId: user.id, path: changedPath })).bytes.toString().includes("Preserve this local version as a conflict."),
    "Selecting the local conflict version did not synchronize it to the cloud.");
  assert.equal((await local.read())!.conflicts.length, 0, "Resolved conflicts remained pending.");
  await act(async () => { root.unmount(); });
  globalThis.fetch = (async () => { throw new TypeError("Offline fixture"); }) as typeof fetch;
  root = createRoot(container as unknown as Element);
  await act(async () => { root.render(createElement(Host)); });
  await until(() => current?.vault.ready, "Offline reopen did not hydrate the durable local vault.");
  assert(Object.values(current.state.conversations).some((conversation: any) => conversation.messages.some((message: any) => message.content === "Preserve this local version as a conflict.")),
    "Offline reopen lost the previously persisted Markdown.");
  console.log(JSON.stringify({ checks: ["local hydration before network", "local saves during pending sync", "real server UTF-8 hydration", "typing retained during hydration", "typing retained during delayed OPFS close", "offline reopen from durable Markdown", "import retains concurrent typing", "failed local write blocks download", "folder preserves original companion bytes", "external folder settings sync safely", "automatic refresh requests coalesce", "conflict resolution does not create spontaneous writes", "plain Markdown conflict resolves to local and syncs"] }));
} finally {
  initialNetwork.resolve();
  writeGate?.resolve();
  await act(async () => { root.unmount(); });
  await browser.happyDOM.abort();
  await rm(storageDirectory, { recursive: true, force: true });
}
