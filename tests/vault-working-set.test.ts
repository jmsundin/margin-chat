import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { planVaultEviction } from "../client/src/lib/vaultHydration";
import { VaultSync, pendingVaultChanges } from "../client/src/lib/vaultSync";
import { type VaultIndexEntry, type VaultSnapshot, type VaultStore, type VaultTransport } from "../client/src/lib/vaultTypes";
import { WORKING_SET_IDLE_MS, claimWorkingSetCheck, loadOpenedDocuments, recordOpenedDocuments, workspaceReferenceIds } from "../client/src/lib/vaultWorkingSet";
import { createVaultService } from "../server/vault/index.mjs";
import { digest } from "../server/vault/storage.mjs";

const DAY = 24 * 60 * 60 * 1000;
const now = Date.parse("2026-10-08T12:00:00.000Z");
const ago = (days: number) => new Date(now - days * DAY).toISOString();
const entry = (id: string, updated: string, extra: Partial<VaultIndexEntry> = {}): VaultIndexEntry =>
  ({ id, path: `${id}.md`, revision: "a".repeat(64), type: "conversation", kind: "note", title: id, updated, ...extra });

describe("planning which documents return to the cloud", () => {
  // Old: a family (old + its branch), a document linking to a recent one, a pinned
  // document, an opened one, and one that a recent document links to.
  const index = [
    entry("old", ago(200)), entry("old-branch", ago(10), { parentPath: "old.md" }),
    entry("stale", ago(400)),
    entry("linker", ago(300), { linkedPaths: ["recent.md"] }),
    entry("recent", ago(3), { linkedPaths: ["needed.md"] }),
    entry("needed", ago(500)),
    entry("pinned", ago(365)),
    entry("opened", ago(365)),
    entry("cloud-only", ago(900)),
  ];
  const local = index.filter((item) => item.id !== "cloud-only").map((item) => item.path);
  const plan = (options: Partial<Parameters<typeof planVaultEviction>[2]> = {}) => planVaultEviction(index, local, {
    opened: new Map([["opened", now - 5 * DAY]]), protectedIds: new Set(["pinned"]), now, idleMs: WORKING_SET_IDLE_MS, ...options,
  }).sort();

  test("idle families leave; what remaining documents need stays", () => {
    // The old family stays because its branch was edited recently.
    expect(plan()).toEqual(["linker.md", "stale.md"]);
  });

  test("a family leaves together once all of it is idle", () => {
    expect(plan({ now: now + 82 * DAY })).toEqual(["linker.md", "old-branch.md", "old.md", "stale.md"]);
  });

  test("protected and recently opened documents keep what they link to", () => {
    expect(plan({ protectedIds: new Set(["pinned", "stale", "linker"]) })).toEqual([]);
    expect(plan({ opened: new Map() })).toEqual(["linker.md", "opened.md", "stale.md"]);
  });
});

function store(initial: VaultSnapshot | null = null): VaultStore & { current(): VaultSnapshot | null } {
  let snapshot = structuredClone(initial);
  let tail = Promise.resolve();
  return {
    current: () => snapshot,
    async read() { return structuredClone(snapshot); },
    async write(value) { snapshot = structuredClone(value); },
    lock<T>(operation: () => Promise<T>): Promise<T> {
      const current = tail.then(operation);
      tail = current.then(() => undefined, () => undefined);
      return current;
    },
  };
}

function cloud() {
  const objects = new Map<string, Buffer>();
  const server = createVaultService({ storage: {
    kind: "memory",
    async read(key: string) { const bytes = objects.get(key); return bytes ? { bytes, etag: digest(bytes) } : null; },
    async putImmutable(key: string, bytes: Buffer) { objects.set(key, Buffer.from(bytes)); },
    async compareAndSwap(key: string, bytes: Buffer, expected: string | null) {
      if ((objects.has(key) ? digest(objects.get(key)!) : null) !== expected) return false;
      objects.set(key, Buffer.from(bytes)); return true;
    },
  } });
  const downloaded: string[] = [];
  const clean = (manifest: any) => ({ schemaVersion: 1 as const, revision: manifest.revision, files: Object.fromEntries(Object.entries<any>(manifest.files)
    .map(([path, item]) => [path, { revision: item.revision, deleted: item.deleted, ...(item.contentType ? { contentType: item.contentType } : {}) }])) });
  const transport: VaultTransport = {
    async manifest() { return clean((await server.status("user")).manifest); },
    async read(path, item) {
      downloaded.push(path);
      const { bytes } = await server.readFile({ userId: "user", path, revision: item.revision });
      return { content: bytes.toString("utf8"), ...(item.contentType ? { contentType: item.contentType } : {}) };
    },
    async commit(changes) { return clean((await server.commit("user", changes)).manifest); },
  };
  return { transport, downloaded, device: () => { const local = store(); return { local, sync: new VaultSync(local, transport) }; } };
}

const markdown = (content: string) => ({ content, contentType: "text/markdown; charset=utf-8" });

async function write(device: VaultSync, path: string, content: string) {
  const previous = (await device.read()).files;
  return device.edit({ ...previous, [path]: markdown(content) }, previous);
}

describe("returning synced documents to the cloud", () => {
  test("an evicted document is listed in the cloud, stays current, and opens with its latest text", async () => {
    const remote = cloud();
    const laptop = remote.device().sync;
    await write(laptop, "old.md", "# Old\n\nFirst.\n");
    await write(laptop, "kept.md", "# Kept\n");
    await laptop.sync();
    const phone = remote.device();
    await phone.sync.sync();

    const { evicted, snapshot } = await phone.sync.evict(["old.md"], new Map([["old.md", "old-id"]]));
    expect(evicted).toEqual(["old.md"]);
    expect(snapshot.files["old.md"]).toBeUndefined();
    expect(snapshot.base["old.md"]).toBeUndefined();
    expect(snapshot.deferred?.["old.md"]).toMatchObject({ id: "old-id", deleted: false, contentType: "text/markdown; charset=utf-8" });
    expect(pendingVaultChanges(phone.local.current()!)).toEqual([]);

    // Another device edits it; this device only records the new revision.
    await write(laptop, "old.md", "# Old\n\nEdited on the laptop.\n");
    await laptop.sync();
    remote.downloaded.length = 0;
    await phone.sync.sync();
    expect(remote.downloaded).toEqual([]);
    expect(phone.local.current()!.files["old.md"]).toBeUndefined();

    await phone.sync.hydrate(["old.md"]);
    const opened = await phone.sync.sync();
    expect(opened.files["old.md"].content).toContain("Edited on the laptop.");
    expect(opened.deferred).toBeUndefined();
  });

  test("a view still showing a returned document edits it without a conflict", async () => {
    const remote = cloud();
    const laptop = remote.device().sync;
    await write(laptop, "old.md", "# Old\n\nFirst.\n");
    await laptop.sync();
    const phone = remote.device();
    await phone.sync.sync();
    // Another tab on the phone still shows old.md when this one returns it.
    const shown = (await phone.sync.read()).files;
    await phone.sync.evict(["old.md"]);

    const edited = await phone.sync.edit({ ...shown, "old.md": markdown("# Old\n\nEdited in the other tab.\n") }, shown);
    expect(edited.conflicts).toEqual([]);
    expect(edited.deferred).toBeUndefined();
    expect(Object.keys(edited.files).filter((path) => path.startsWith(".margin-chat/history/"))).toEqual([]);
    await phone.sync.sync();
    expect((await laptop.sync()).files["old.md"].content).toContain("Edited in the other tab.");
  });

  test("a stale view does not overwrite a newer cloud revision of a returned document", async () => {
    const remote = cloud();
    const laptop = remote.device().sync;
    await write(laptop, "old.md", "# Old\n\nFirst.\n");
    await laptop.sync();
    const phone = remote.device();
    await phone.sync.sync();
    const shown = (await phone.sync.read()).files;
    await phone.sync.evict(["old.md"]);
    await write(laptop, "old.md", "# Old\n\nNewer on the laptop.\n");
    await laptop.sync();
    await phone.sync.sync();

    const edited = await phone.sync.edit({ ...shown, "old.md": markdown("# Old\n\nStale edit.\n") }, shown);
    expect(edited.deferred?.["old.md"]).toBeDefined();
    expect(edited.conflicts.map((conflict) => conflict.path)).toEqual(["old.md"]);
    await phone.sync.sync();
    expect((await laptop.sync()).files["old.md"].content).toContain("Newer on the laptop.");
  });

  test("unsaved edits, conflicts, folder copies and unsynced vaults are never evicted", async () => {
    const remote = cloud();
    const device = remote.device();
    await write(device.sync, "edited.md", "# Edited\n");
    await write(device.sync, "clean.md", "# Clean\n");
    expect((await device.sync.evict(["clean.md"])).evicted).toEqual([]);
    await device.sync.sync();
    await write(device.sync, "edited.md", "# Edited\n\nNot synced yet.\n");
    expect((await device.sync.evict(["edited.md", "workspace.json", "missing.md"])).evicted).toEqual([]);

    const conflicted = structuredClone(device.local.current()!);
    conflicted.conflicts.push({ id: "c", path: "clean.md", local: markdown("# Clean"), remote: markdown("# Other"), createdAt: now } as any);
    const withConflict = new VaultSync(store(conflicted), remote.transport);
    expect((await withConflict.evict(["clean.md"])).evicted).toEqual([]);

    const folder = structuredClone(device.local.current()!);
    folder.directoryBaselines = { folder: {} as any };
    expect((await new VaultSync(store(folder), remote.transport).evict(["clean.md"])).evicted).toEqual([]);
    expect((await device.sync.evict(["clean.md"])).evicted).toEqual(["clean.md"]);
  });
});

describe("working set records", () => {
  let values: Map<string, string>;
  const original = (globalThis as any).localStorage;
  beforeEach(() => {
    values = new Map();
    (globalThis as any).localStorage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
      removeItem: (key: string) => { values.delete(key); },
    };
  });
  afterEach(() => { (globalThis as any).localStorage = original; });

  test("opened documents are remembered until they would no longer protect anything", () => {
    recordOpenedDocuments("u", ["a"], now - WORKING_SET_IDLE_MS - DAY);
    recordOpenedDocuments("u", ["b"], now);
    expect([...loadOpenedDocuments("u").keys()]).toEqual(["b"]);
    expect(loadOpenedDocuments("someone-else").size).toBe(0);
  });

  test("a device looks for idle documents at most once a day, once its records cover an idle period", () => {
    // Documents read before records began would look idle, so the first look only starts the records.
    expect(claimWorkingSetCheck("u", now)).toBe(false);
    expect(claimWorkingSetCheck("u", now + 30 * DAY)).toBe(false);
    const start = now + WORKING_SET_IDLE_MS;
    expect(claimWorkingSetCheck("u", start)).toBe(true);
    expect(claimWorkingSetCheck("u", start + DAY / 2)).toBe(false);
    expect(claimWorkingSetCheck("u", start + DAY)).toBe(true);
  });

  test("pins, docked panes and the open document are protected; an unreadable sidecar protects everything", () => {
    const view = { pinnedItemIds: ["p"], activeItemId: "a", documentDock: { tree: { type: "split", first: { type: "pane", documentId: "d1" }, second: { type: "pane", documentId: "d2" } } } };
    expect([...workspaceReferenceIds({ content: JSON.stringify({ workspace: { view } }) })!].sort()).toEqual(["a", "d1", "d2", "p"]);
    expect(workspaceReferenceIds(undefined)!.size).toBe(0);
    expect(workspaceReferenceIds({ content: "{" })).toBeNull();
  });
});
