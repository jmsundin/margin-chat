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
  const identity = Symbol(name);
  return {
    name, kind: "directory",
    fixtureIdentity: identity,
    async isSameEntry(other: any) { return other.fixtureIdentity === identity; },
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
const { act, createElement, useState } = await import("react");
const { createRoot } = await import("react-dom/client");
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
const emptySettingsScenario = process.argv.includes("--empty-settings");
const historyScenario = process.argv.includes("--chat-history");
const focusScenario = process.argv.includes("--document-focus");
if (!emptySettingsScenario && !historyScenario && !focusScenario) await remote.commit(user.id, [{ path: "Notes/phone.md", content: "# From phone\n\nCloud Markdown arrived.", baseRevision: null }]);
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
async function checkDocumentFocus() {
  const { createMainConversation, createChildConversation } = await import("../../client/src/initialState");
  const { stateToVaultFiles } = await import("../../client/src/lib/vaultWorkspace");
  const { focusDocument } = await import("../../client/src/lib/documentWorkspace");
  const seed = createEmptyState();
  const other = createMainConversation({ id: "other-root" });
  other.title = "Other document";
  const child = createChildConversation({ id: "last-focused-child", parentConversation: other });
  child.title = "Last focused side document";
  seed.conversations[other.id] = other;
  seed.conversations[child.id] = child;
  other.childIds = [child.id];
  const snapshot = emptyVault();
  snapshot.files = stateToVaultFiles(seed, {});
  await local.write(snapshot);
  const onlineFetch = globalThis.fetch;
  globalThis.fetch = (async () => { throw new TypeError("Offline fixture"); }) as typeof fetch;
  const reopen = async () => {
    await act(async () => { root.unmount(); });
    current = null;
    root = createRoot(container as unknown as Element);
    await act(async () => { root.render(createElement(Host)); });
    await until(() => current?.vault.ready, "Focus fixture did not reopen.");
  };
  await act(async () => { root.render(createElement(Host)); });
  await until(() => current?.vault.ready, "Focus fixture did not load.");
  const before = (await local.read())!.files;
  await act(async () => { current.setState((state: any) => focusDocument(state, child.id)); });
  // Reopen immediately after navigation, without an edit, explicit save or sync debounce.
  await reopen();
  assert.equal(current.state.activeConversationId, child.id, "Reopening lost the last focused document.");
  assert.equal(current.state.rootId, other.id, "Reopening selected the wrong document family.");
  assert.deepEqual((await local.read())!.files, before, "Navigation rewrote authored vault files.");

  // An account with identical document IDs must keep its own selection.
  const originalUserId = user.id;
  user.id = "another-focus-user";
  await createBrowserVaultStore(user.id).write(snapshot);
  await reopen();
  assert.notEqual(current.state.activeConversationId, child.id, "Another account inherited the focused document.");
  user.id = originalUserId;
  await reopen();
  assert.equal(current.state.activeConversationId, child.id);

  // The remembered document may arrive after the initial local hydration.
  await act(async () => { root.unmount(); });
  await remote.commit(user.id, Object.entries(snapshot.files).map(([path, file]) => ({ path, content: file.content, baseRevision: null })));
  await local.write(emptyVault());
  globalThis.fetch = onlineFetch;
  current = null;
  root = createRoot(container as unknown as Element);
  await act(async () => { root.render(createElement(Host)); });
  await until(() => current?.vault.ready, "Local readiness waited for cloud focus restoration.");
  await networkEntered.promise;
  networkReleased = true;
  initialNetwork.resolve();
  await until(() => Boolean(current.state.conversations[child.id]), "Cloud documents did not load.");
  assert.equal(current.state.activeConversationId, child.id, "Initial local fallback replaced the remembered cloud document.");
  assert.equal(current.state.rootId, other.id);

  // A user's selection while cloud hydration is pending wins over startup restoration.
  await act(async () => { await current.vault.syncNow(); });
  await act(async () => { root.unmount(); });
  const partial = emptyVault();
  const partialState = { ...seed, conversations: { ...seed.conversations } };
  delete partialState.conversations[child.id];
  partial.files = stateToVaultFiles(partialState, {});
  await local.write(partial);
  const delayedCloud = deferred();
  const delayedCloudEntered = deferred();
  globalThis.fetch = (async (input: any, init: any) => {
    if (new URL(String(input), "http://fixture.test").pathname === "/api/vault") {
      delayedCloudEntered.resolve();
      await delayedCloud.promise;
    }
    return onlineFetch(input, init);
  }) as typeof fetch;
  current = null;
  root = createRoot(container as unknown as Element);
  await act(async () => { root.render(createElement(Host)); });
  await until(() => current?.vault.ready, "Partial local vault did not load.");
  await delayedCloudEntered.promise;
  await act(async () => { current.setState((state: any) => focusDocument(state, other.id)); });
  delayedCloud.resolve();
  await until(() => Boolean(current.state.conversations[child.id]), "Delayed cloud child did not load.");
  assert.equal(current.state.activeConversationId, other.id, "Cloud hydration overrode the user's new selection.");
  await act(async () => { await current.vault.syncNow(); });
  await act(async () => { current.setState((state: any) => focusDocument(state, child.id)); });

  // Deleted targets must fall back to a valid document and matching root.
  globalThis.fetch = (async () => { throw new TypeError("Offline fixture"); }) as typeof fetch;
  await act(async () => { root.unmount(); });
  delete seed.conversations[child.id];
  other.childIds = [];
  const withoutChild = emptyVault();
  withoutChild.files = stateToVaultFiles(seed, {});
  await local.write(withoutChild);
  current = null;
  root = createRoot(container as unknown as Element);
  await act(async () => { root.render(createElement(Host)); });
  await until(() => current?.vault.ready, "Deleted focus fallback did not load.");
  assert(current.state.conversations[current.state.activeConversationId]);
  assert.equal(current.state.rootId, current.state.activeConversationId);
  await act(async () => { current.setState((state: any) => focusDocument(state, other.id)); });
  await reopen();
  assert.equal(current.state.activeConversationId, other.id, "New navigation did not replace the missing remembered document.");
  console.log(JSON.stringify({ checks: ["focus-only offline reopen", "side-document root restoration", "no authored file changes", "account isolation", "delayed cloud restoration", "new navigation wins over delayed restoration", "deleted target fallback", "new selection replaces missing target"] }));
}
async function checkChatHistory() {
  const { parseChatGPTHistory } = await import("../../client/src/lib/chatHistoryImport");
  const { chatGPTFixture } = await import("./chatHistoryFixture");
  networkReleased = true;
  initialNetwork.resolve();
  await act(async () => { root.render(createElement(Host)); });
  await until(() => current?.vault.ready, "Workspace did not become ready.");
  await act(async () => { await current.vault.syncNow(); });
  const preview = await parseChatGPTHistory([chatGPTFixture(), chatGPTFixture("second")]);
  const first = preview.chats[0];
  const second = preview.chats[1];
  const model = current.state.defaultModelId;
  const gate = deferred();
  writeEntered = deferred();
  writeGate = gate;
  const importing = current.vault.importChatHistory([first]);
  await writeEntered.promise;
  await act(async () => { type("My draft while history is importing."); });
  gate.resolve();
  let receipt: any;
  await act(async () => { receipt = await importing; });
  assert.equal(receipt.conversationIds[0], first.id);
  assert.deepEqual(current.state.conversations[first.id].messages, first.messages);
  assert(Object.values(current.state.conversations).some((chat: any) => chat.messages.some((m: any) => m.content === "My draft while history is importing.")), "Import lost concurrent writing.");
  assert.equal(current.state.defaultModelId, model);
  await act(async () => { await current.vault.syncNow(); });
  const cloud = await remote.snapshot(user.id);
  const { workspaceFromVault } = await import("../../client/src/lib/vaultWorkspace");
  const importedPath = workspaceFromVault((await local.read())!.files).manifest.files.find((record) => record.id === first.id)!.path;
  assert(cloud.manifest.files[importedPath] && !cloud.manifest.files[importedPath].deleted, "Imported chat did not reach cloud storage.");
  const uploaded = await remote.readFile({ userId: user.id, path: importedPath });
  assert(uploaded.bytes.toString().includes(`margin-chat-id: ${JSON.stringify(first.id)}`), "Cloud file lost the imported identity.");
  await act(async () => { assert.equal((await current.vault.importChatHistory([first])).skipped, 1); });
  await act(async () => {
    current.setState((state: any) => ({ ...state, conversations: { ...state.conversations,
      [first.id]: { ...state.conversations[first.id], messages: [...state.conversations[first.id].messages,
        { id: "continued", role: "user", content: "Continue my imported conversation.", createdAt: new Date().toISOString() }] },
    } }));
  });
  await act(async () => { assert.deepEqual(await current.vault.undoChatHistory(receipt), { removed: 0, kept: 1 }); });
  let secondReceipt: any;
  await act(async () => { secondReceipt = await current.vault.importChatHistory([second]); });
  await act(async () => { assert.deepEqual(await current.vault.undoChatHistory(secondReceipt), { removed: 1, kept: 0 }); });
  assert.equal(current.state.conversations[second.id], undefined);
  await act(async () => { await current.vault.syncNow(); });
  await act(async () => { root.unmount(); });
  globalThis.fetch = (async () => { throw new TypeError("Offline fixture"); }) as typeof fetch;
  current = null;
  root = createRoot(container as unknown as Element);
  await act(async () => { root.render(createElement(Host)); });
  await until(() => current?.vault.ready, "Imported history did not reopen offline.");
  assert.equal(current.state.conversations[first.id].messages.at(-1).content, "Continue my imported conversation.");
  assert.equal(current.state.conversations[second.id], undefined);
  console.log(JSON.stringify({ checks: ["import preserves concurrent writing", "cloud synchronization", "duplicate prevention", "undo keeps continued chats", "undo removes unchanged chats", "offline reopening"] }));
}
async function checkEmptyWorkspaceSettings() {
  networkReleased = true;
  initialNetwork.resolve();
  await act(async () => { root.render(createElement(Host)); });
  await until(() => current?.vault.ready, "Empty workspace did not become ready.");
  await act(async () => { await current.vault.syncNow(); });
  await act(async () => {
    current.setState((state: any) => ({
      ...state, defaultServiceId: "openai-api", defaultModelId: "gpt-6-astra",
      groups: { drafts: { id: "drafts", name: "Drafts", color: "#4fbf9f", collapsed: false, conversationIds: [] } },
      conversations: { ...state.conversations, [state.rootId]: {
        ...state.conversations[state.rootId], serviceId: "openai-api", modelId: "gpt-6-astra",
      } },
    }));
  });
  // Exercise the real automatic debounce: no explicit save/sync hides a reset.
  await act(async () => { await new Promise((done) => setTimeout(done, 1100)); });
  await until(() => !current.vault.saving, "Automatic empty-workspace save did not finish.");
  const assertSelection = () => {
    assert.equal(current.state.defaultServiceId, "openai-api");
    assert.equal(current.state.defaultModelId, "gpt-6-astra");
    assert.equal(current.state.conversations[current.state.rootId].serviceId, "openai-api");
    assert.equal(current.state.conversations[current.state.rootId].modelId, "gpt-6-astra");
    assert.equal(current.state.groups.drafts.name, "Drafts");
  };
  const assertNoDocuments = async () => {
    assert.equal(Object.keys((await local.read())!.files).filter((path) => /\.md$/i.test(path)).length, 0,
      "Saving empty-workspace settings created a Markdown placeholder.");
    const cloud = await remote.snapshot(user.id);
    assert.equal(Object.entries(cloud.manifest.files).filter(([path, entry]: [string, any]) => /\.md$/i.test(path) && !entry.deleted).length, 0,
      "A deleted or empty editor was published as a cloud document.");
    const settings = JSON.parse((await remote.readFile({ userId: user.id, path: "workspace.json" })).bytes.toString());
    assert.equal(settings.workspace.preferences.defaultServiceId, "openai-api");
    assert.equal(settings.workspace.preferences.defaultModelId, "gpt-6-astra");
  };
  assertSelection();
  await assertNoDocuments();

  // Reopen from the durable settings while offline, before any cloud response.
  await act(async () => { root.unmount(); });
  const onlineFetch = globalThis.fetch;
  globalThis.fetch = (async () => { throw new TypeError("Offline fixture"); }) as typeof fetch;
  current = null;
  root = createRoot(container as unknown as Element);
  await act(async () => { root.render(createElement(Host)); });
  await until(() => current?.vault.ready, "Empty workspace settings did not hydrate offline.");
  assertSelection();
  globalThis.fetch = onlineFetch;
  await act(async () => { await current.vault.syncNow(); });

  await act(async () => { type("Create a document before deleting it from another device."); });
  await act(async () => { await current.vault.syncNow(); });
  const beforeDeletion = await remote.snapshot(user.id);
  const deletions = Object.entries(beforeDeletion.manifest.files)
    .filter(([path, entry]: [string, any]) => /\.md$/i.test(path) && !entry.deleted)
    .map(([path, entry]: [string, any]) => ({ path, baseRevision: entry.revision, content: null }));
  assert.equal(deletions.length, 1, "The real authored document was not saved.");
  await remote.commit(user.id, deletions);
  await act(async () => { await current.vault.syncNow(); });
  assertSelection();
  assert.equal(current.state.conversations[current.state.rootId].messages.length, 0);
  await act(async () => { current.setState((state: any) => ({ ...state, railOpen: !state.railOpen })); });
  await act(async () => { await new Promise((done) => setTimeout(done, 1100)); });
  await until(() => !current.vault.saving, "Refresh after deletion did not finish.");
  await assertNoDocuments();
  console.log(JSON.stringify({ checks: ["empty settings survive automatic debounce", "settings sync without placeholder Markdown", "offline reopen restores selected provider and model", "empty groups survive reopening", "remote deletion does not resurrect placeholder"] }));
}
async function checkPopulatedWorkspace() {
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

  const olderExport = emptyVault();
  olderExport.files = { "Notes/older-name.md": structuredClone((await local.read())!.files["Notes/imported.md"]) };
  await act(async () => {
    current.setState((state: any) => ({ ...state, conversations: Object.fromEntries(Object.entries(state.conversations).map(([id, conversation]: [string, any]) => [id,
      conversation.title === "Imported note" ? { ...conversation, notes: conversation.notes.map((note: any) => ({ ...note, content: "Newer writing must survive an older archive." })) } : conversation,
    ])) }));
    await current.vault.flushLocal();
  });
  await act(async () => { await current.vault.importArchive(new File([exportVault(olderExport)], "older.zip")); });
  const importConflict = (await local.read())!.conflicts.find((conflict: any) => conflict.sourcePath === "Notes/older-name.md");
  assert(importConflict, "An older-path archive did not preserve its divergent version for review.");
  assert.equal((await local.read())!.files["Notes/older-name.md"], undefined, "Import persisted a duplicate document identity.");
  assert((await local.read())!.files["Notes/imported.md"].content.includes("Newer writing must survive an older archive."));
  await act(async () => { await current.vault.resolveConflict(importConflict.id, "current"); });

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

  const originalDirectoryId = current.vault.localDirectoryStatus.directoryId;
  assert(originalDirectoryId && (await local.read())!.directoryBaselines?.[originalDirectoryId], "Folder baseline was not durable.");
  await act(async () => { root.unmount(); });
  const noteDirectory = await connectedFolder.getDirectoryHandle("Notes");
  const renamedWriter = await (await noteDirectory.getFileHandle("renamed.md", { create: true })).createWritable();
  await renamedWriter.write(await (await (await noteDirectory.getFileHandle("imported.md")).getFile()).text());
  await renamedWriter.close();
  await noteDirectory.removeEntry("imported.md");
  current = null;
  root = createRoot(container as unknown as Element);
  await act(async () => { root.render(createElement(Host)); });
  await until(() => current?.vault.ready, "Folder rename prevented reopening the vault.");
  await act(async () => { await current.vault.syncNow(); });
  assert.equal((await local.read())!.files["Notes/imported.md"], undefined, "Reopening retained a renamed document's old path.");
  assert((await local.read())!.files["Notes/renamed.md"].content.includes("Newer writing must survive an older archive."));

  await act(async () => { root.unmount(); });
  await noteDirectory.removeEntry("renamed.md");
  await attachmentFolder.removeEntry("raw.bin");
  current = null;
  root = createRoot(container as unknown as Element);
  await act(async () => { root.render(createElement(Host)); });
  await until(() => current?.vault.ready, "Folder deletions prevented reopening the vault.");
  await act(async () => { await current.vault.syncNow(); });
  assert.equal((await local.read())!.files["Notes/renamed.md"], undefined, "Reopening resurrected a deleted note.");
  assert.equal((await local.read())!.files["Attachments/raw.bin"], undefined, "Reopening resurrected a deleted companion.");

  const anotherFolder = directory(connectedFolder.name);
  (browser as any).showDirectoryPicker = async () => anotherFolder;
  const beforeSwitch = Object.keys((await local.read())!.files);
  await act(async () => { await current.vault.chooseDirectory(); });
  assert.notEqual(current.vault.localDirectoryStatus.directoryId, originalDirectoryId, "Different folders with the same name reused a deletion baseline.");
  for (const path of beforeSwitch) assert((await local.read())!.files[path], "Switching to an empty folder deleted vault content.");
  (browser as any).showDirectoryPicker = async () => ({ ...connectedFolder });
  await act(async () => { await current.vault.chooseDirectory(); });
  assert.equal(current.vault.localDirectoryStatus.directoryId, originalDirectoryId, "Reselecting the same folder lost its identity.");
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
  console.log(JSON.stringify({ checks: ["local hydration before network", "local saves during pending sync", "real server UTF-8 hydration", "typing retained during hydration", "typing retained during delayed OPFS close", "offline reopen from durable Markdown", "import retains concurrent typing", "failed local write blocks download", "folder preserves original companion bytes", "external folder settings sync safely", "automatic refresh requests coalesce", "conflict resolution does not create spontaneous writes", "plain Markdown conflict resolves to local and syncs", "older archive preserves current edits without duplicate identities", "folder rename survives reopening", "folder note and companion deletions survive reopening", "directory baselines follow identity instead of name"] }));
}
try {
  if (focusScenario) await checkDocumentFocus();
  else if (historyScenario) await checkChatHistory();
  else if (emptySettingsScenario) await checkEmptyWorkspaceSettings();
  else await checkPopulatedWorkspace();
} finally {
  initialNetwork.resolve();
  writeGate?.resolve();
  await act(async () => { root.unmount(); });
  await browser.happyDOM.abort();
  await rm(storageDirectory, { recursive: true, force: true });
}
