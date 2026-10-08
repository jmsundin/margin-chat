import { describe, expect, test } from "bun:test";
import { createChildConversation, createEmptyState, createStandaloneNoteConversation } from "../client/src/initialState";
import { preserveDeferredWorkspaceReferences, recentVaultEntries, searchVaultIndex, vaultHydrationClosure } from "../client/src/lib/vaultHydration";
import { VaultSync, pendingVaultChanges } from "../client/src/lib/vaultSync";
import { type VaultManifest, type VaultSnapshot, type VaultStore, type VaultTransport } from "../client/src/lib/vaultTypes";
import { stateToVaultFiles, vaultToState, workspaceFromVault } from "../client/src/lib/vaultWorkspace";
import { createVaultService } from "../server/vault/index.mjs";
import { digest } from "../server/vault/storage.mjs";
import type { AppState } from "../client/src/types";

function store(initial: VaultSnapshot | null = null): VaultStore {
  let snapshot = structuredClone(initial);
  let tail = Promise.resolve();
  return {
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
  const reads: string[] = [];
  const server = createVaultService({ storage: {
    kind: "memory",
    async read(key: string) {
      reads.push(key);
      const bytes = objects.get(key); return bytes ? { bytes, etag: digest(bytes) } : null;
    },
    async putImmutable(key: string, bytes: Buffer) { objects.set(key, Buffer.from(bytes)); },
    async compareAndSwap(key: string, bytes: Buffer, expected: string | null) {
      if ((objects.has(key) ? digest(objects.get(key)) : null) !== expected) return false;
      objects.set(key, Buffer.from(bytes)); return true;
    },
  } });
  const normalize = (manifest: any): VaultManifest => ({ ...manifest, files: Object.fromEntries(Object.entries(manifest.files).map(([path, entry]: [string, any]) => [path, { ...entry, encoding: entry.encoding === "base64" ? "base64" : undefined }])) });
  const downloaded: string[] = [];
  const transport: VaultTransport = {
    async manifest() { return normalize((await server.status("user")).manifest); },
    async index() { const { revision, entries } = await server.index("user"); return { revision, entries }; },
    async read(path, entry) {
      downloaded.push(path);
      const { bytes } = await server.readFile({ userId: "user", path, revision: entry.revision });
      return { content: bytes.toString(entry.encoding === "base64" ? "base64" : "utf8"), ...(entry.encoding ? { encoding: entry.encoding } : {}), contentType: entry.contentType };
    },
    async commit(changes) { return normalize((await server.commit("user", changes)).manifest); },
  };
  return { server, transport, reads, downloaded, device: () => new VaultSync(store(), transport) };
}

/** Research (old) has a branch; Design (recent) links to Source; Archive is old, pinned and grouped. */
function vaultState(): AppState {
  const state = createEmptyState();
  const research = state.conversations[state.rootId];
  research.title = "Research";
  research.createdAt = research.updatedAt = "2026-01-01T00:00:00.000Z";
  const branch = createChildConversation({ id: "branch", parentConversation: research, createdAt: research.createdAt });
  branch.title = "Follow-up";
  branch.updatedAt = research.createdAt;
  research.childIds.push(branch.id);
  state.conversations[branch.id] = branch;
  const note = (id: string, title: string, at: string) => {
    const conversation = createStandaloneNoteConversation({ id, noteId: `${id}-body`, createdAt: at });
    conversation.title = title;
    conversation.updatedAt = at;
    conversation.notes![0].content = `${title} body`;
    state.conversations[id] = conversation;
    return conversation;
  };
  note("design", "Design plan", "2026-09-01T00:00:00.000Z").linkedConversationIds = ["source"];
  note("source", "Source notes", "2025-06-01T00:00:00.000Z");
  note("archive", "Archive", "2025-01-01T00:00:00.000Z");
  state.groups = { old: { id: "old", name: "Old work", color: "#4fbf9f", collapsed: false, conversationIds: ["archive", "design"] } };
  state.pinnedThreadIds = ["archive", "design"];
  return state;
}

const pathOf = (files: Record<string, unknown>, id: string) =>
  workspaceFromVault(files as never).manifest.files.find((record) => record.id === id)!.path;

describe("opening a cloud vault on a new device", () => {
  test("the cloud index describes every document with its relationships and reuses unchanged summaries", async () => {
    const remote = cloud();
    const files = stateToVaultFiles(vaultState(), {});
    const device = remote.device();
    await device.edit(files, {});
    await device.sync();
    const { entries } = await remote.transport.index!();
    const byId = new Map(entries.map((entry) => [entry.id, entry]));
    expect(byId.get("design")).toMatchObject({ title: "Design plan", type: "conversation", kind: "note", linkedPaths: [pathOf(files, "source")] });
    expect(byId.get("branch")).toMatchObject({ title: "Follow-up", parentPath: pathOf(files, state0Root(files)) });
    expect(recentVaultEntries(entries, 1)[0].id).toBe("design");
    expect(searchVaultIndex(entries, "foll UP").map((entry) => entry.id)).toEqual(["branch"]);

    remote.reads.length = 0;
    await remote.transport.index!();
    expect(remote.reads.filter((key) => key.includes("/files/"))).toEqual([]);
  });

  test("recent documents load first, the rest stay in the cloud until opened, and nothing deferred is lost", async () => {
    const remote = cloud();
    const original = vaultState();
    const files = stateToVaultFiles(original, {});
    const laptop = remote.device();
    await laptop.edit(files, {});
    await laptop.sync();

    const phone = remote.device();
    const [manifest, index] = await Promise.all([remote.transport.manifest(), remote.transport.index!()]);
    const keep = vaultHydrationClosure(index.entries, recentVaultEntries(index.entries, 1).map((entry) => entry.path));
    // A linked document arrives with the document that links to it.
    expect([...keep].sort()).toEqual([pathOf(files, "design"), pathOf(files, "source")].sort());
    expect(await phone.deferFresh(manifest, keep, new Map(index.entries.map((entry) => [entry.path, entry.id])))).toBe(true);
    remote.downloaded.length = 0;
    let snapshot = await phone.sync();
    expect(remote.downloaded.sort()).toEqual([...keep, "workspace.json"].sort());
    const partial = vaultToState(snapshot.files, createEmptyState());
    expect(Object.keys(partial.conversations).sort()).toEqual(["design", "source"]);

    // Editing on the partial device keeps pins and groups that refer to cloud-only documents.
    const edited = structuredClone(partial);
    edited.conversations.design.notes![0].content = "Edited on the phone";
    edited.conversations.design.updatedAt = "2026-09-02T00:00:00.000Z";
    const deferredIds = new Set(Object.values(snapshot.deferred!).flatMap((entry) => entry.id ? [entry.id] : []));
    const next = stateToVaultFiles(edited, snapshot.files);
    next["workspace.json"] = preserveDeferredWorkspaceReferences(next["workspace.json"], snapshot.files["workspace.json"], deferredIds);
    await phone.edit(next, snapshot.files);
    snapshot = await phone.sync();
    expect(pendingVaultChanges(snapshot)).toEqual([]);
    const cloudManifest = await remote.transport.manifest();
    for (const id of ["archive", "branch"]) {
      expect(cloudManifest.files[pathOf(files, id)].revision).toBe(manifest.files[pathOf(files, id)].revision);
    }
    const sidecar = JSON.parse((await remote.server.readFile({ userId: "user", path: "workspace.json" })).bytes.toString("utf8"));
    expect(sidecar.workspace.view.pinnedItemIds).toEqual(expect.arrayContaining(["archive", "design"]));
    expect(sidecar.workspace.view.groups.old.conversationIds).toEqual(expect.arrayContaining(["archive", "design"]));

    // A cloud-only document edited elsewhere is not downloaded until opened, then arrives current.
    const laptopFiles = (await laptop.sync()).files;
    const laptopState = vaultToState(laptopFiles, createEmptyState());
    const research = laptopState.conversations[state0Root(laptopFiles)];
    research.messages = [...research.messages, { id: "laptop-message", role: "user", createdAt: "2026-09-03T00:00:00.000Z", content: "Added on the laptop" }];
    await laptop.edit(stateToVaultFiles(laptopState, laptopFiles), laptopFiles);
    await laptop.sync();
    remote.downloaded.length = 0;
    snapshot = await phone.sync();
    expect(remote.downloaded).toEqual(["workspace.json"]);
    expect(remote.downloaded).not.toContain(pathOf(files, state0Root(files)));
    expect(remote.downloaded).not.toContain(pathOf(files, "branch"));
    expect(snapshot.deferred![pathOf(files, state0Root(files))].revision)
      .toBe((await remote.transport.manifest()).files[pathOf(files, state0Root(files))].revision);
    const researchPaths = vaultHydrationClosure((await remote.transport.index!()).entries,
      [Object.keys(snapshot.deferred!).find((path) => snapshot.deferred![path].id === state0Root(files))!]);
    expect(researchPaths.size).toBe(2);
    await phone.hydrate(researchPaths);
    snapshot = await phone.sync();
    const opened = vaultToState(snapshot.files, createEmptyState());
    expect(opened.conversations[state0Root(files)].messages.at(-1)?.content).toBe("Added on the laptop");
    expect(opened.conversations.branch.parentId).toBe(state0Root(files));
    expect(Object.values(snapshot.deferred!).map((entry) => entry.id)).toEqual(["archive"]);
  });

  test("streamed documents land one family at a time and never overwrite local work", async () => {
    const remote = cloud();
    const files = stateToVaultFiles(vaultState(), {});
    const laptop = remote.device();
    await laptop.edit(files, {});
    await laptop.sync();
    const phone = remote.device();
    const manifest = await remote.transport.manifest();
    expect(await phone.deferFresh(manifest, new Set())).toBe(true);
    const design = pathOf(files, "design");
    const archive = pathOf(files, "archive");

    remote.downloaded.length = 0;
    const landed = await phone.pull([[design, manifest.files[design]]]);
    expect(remote.downloaded).toEqual([design]);
    expect(landed!.files[design]).toEqual(files[design]);
    expect(landed!.base[design].revision).toBe(manifest.files[design].revision);
    expect(landed!.deferred![design]).toBeUndefined();
    // Already here: nothing downloads again.
    expect(await phone.pull([[design, manifest.files[design]]])).toBeNull();

    // A local file at a cloud path is merged by the next sync, not replaced by a stream.
    const local = { content: "Written on the phone before it arrived", contentType: "text/markdown; charset=utf-8" };
    await phone.edit({ ...(await phone.read()).files, [archive]: local }, (await phone.read()).files);
    expect(await phone.pull([[archive, manifest.files[archive]]])).toBeNull();
    expect((await phone.read()).files[archive]).toEqual(local);
  });

  test("a device that already synchronized never switches to partial loading", async () => {
    const remote = cloud();
    const device = remote.device();
    await device.edit(stateToVaultFiles(vaultState(), {}), {});
    await device.sync();
    expect(await device.deferFresh(await remote.transport.manifest(), new Set())).toBe(false);
  });
});

describe("workspace settings on a partially loaded device", () => {
  test("restores references to cloud-only documents without undoing local changes", () => {
    const stored = { content: JSON.stringify({ workspace: { view: {
      pinnedItemIds: ["local", "cloud"], graphLayouts: { cloud: { x: 1 }, local: { x: 2 } },
      groups: { mixed: { name: "Mixed", conversationIds: ["local", "cloud"] }, remote: { name: "Remote", conversationIds: ["cloud"] },
        removed: { name: "Removed here", conversationIds: ["local", "cloud"] } },
    } } }) };
    const rendered = { content: JSON.stringify({ workspace: { view: {
      pinnedItemIds: [], graphLayouts: { local: { x: 3 } },
      groups: { mixed: { name: "Mixed", conversationIds: ["local"] } },
    } } }) };
    const view = JSON.parse(preserveDeferredWorkspaceReferences(rendered, stored, new Set(["cloud"])).content).workspace.view;
    expect(view.pinnedItemIds).toEqual(["cloud"]);
    expect(view.graphLayouts).toEqual({ local: { x: 3 }, cloud: { x: 1 } });
    expect(view.groups.mixed.conversationIds).toEqual(["local", "cloud"]);
    expect(view.groups.remote.conversationIds).toEqual(["cloud"]);
    expect(view.groups.removed).toBeUndefined();
    expect(preserveDeferredWorkspaceReferences(rendered, stored, new Set())).toBe(rendered);
  });
});

function state0Root(files: Record<string, unknown>) {
  const state = vaultToState(files as never, createEmptyState());
  return Object.values(state.conversations).find((conversation) => conversation.title.startsWith("Research"))!.id;
}
