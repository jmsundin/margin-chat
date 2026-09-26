import { describe, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import {
  createAppStateFromWorkspaceDocument, createMarkdownWorkspace, createWorkspaceDocument,
  normalizeDocumentDock, parseMarkdownWorkspace,
  type AppState, type DocumentDockLayout, type DocumentDockNode,
} from "@margin-chat/workspace-contracts";
import { createEmptyState, createMainConversation, createSideConversation } from "../client/src/initialState";
import { hydratePersistedState } from "../client/src/lib/appState";
import { createVaultFileRenderer, hasSameAuthoredState, vaultToState } from "../client/src/lib/vaultWorkspace";
import { deleteThread } from "../client/src/lib/workspaceCommands";
import { loadMigrations, migrateDatabase } from "../server/db/migrations.mjs";
import { readState, writeState } from "../server/db/repository.mjs";
import { normalizeAppState } from "../server/db/validation.mjs";

const createdAt = "2026-09-25T12:00:00.000Z";
const pane = (documentId: string): Extract<DocumentDockNode, { type: "pane" }> => ({ type: "pane", documentId });
function fixture(): AppState {
  const state = createEmptyState();
  const root = state.conversations[state.rootId];
  const side = createSideConversation({ id: "side", sourceConversation: root, createdAt });
  root.childIds = [side.id];
  state.conversations = { ...state.conversations, [side.id]: side,
    other: createMainConversation({ id: "other", createdAt }) };
  state.documentDock = { width: .45, tree: { type: "split", id: "across-families", direction: "vertical", ratio: .35,
    first: pane(side.id), second: pane("other") } };
  return state;
}

function roundTrips(state: AppState) {
  const markdown = createMarkdownWorkspace(state);
  return [hydratePersistedState(state), createAppStateFromWorkspaceDocument(createWorkspaceDocument(state)),
    parseMarkdownWorkspace(markdown.manifest, markdown.files), normalizeAppState(state)];
}

describe("global pinned document persistence", () => {
  test("local, workspace, Markdown and server validation retain cross-family panes and proportions", () => {
    const state = fixture();
    if (state.documentDock!.tree!.type === "split") state.documentDock!.tree!.first = { ...pane("side"), scope: "family" };
    for (const restored of roundTrips(state)) expect(restored?.documentDock).toEqual(state.documentDock);
    const { documentDock: _dock, ...legacy } = state;
    for (const restored of roundTrips(legacy)) expect(restored?.documentDock).toBeUndefined();
  });

  test("all readers prune missing and duplicate panes, collapse empty splits and clamp proportions", () => {
    const state = fixture();
    state.documentDock = { width: 2, tree: { type: "split", id: "outer", direction: "horizontal", ratio: -.5,
      first: { type: "split", id: "inner", direction: "vertical", ratio: .5,
        first: pane("missing"), second: pane("side") },
      second: { type: "split", id: "duplicate", direction: "vertical", ratio: .5,
        first: pane("side"), second: pane("other") },
    } };
    const expected = { width: .75, tree: { type: "split", id: "outer", direction: "horizontal", ratio: .2,
      first: pane("side"), second: pane("other") } };
    for (const restored of roundTrips(state)) expect(restored?.documentDock).toEqual(expected);
    expect(normalizeDocumentDock({ tree: pane("side"), width: Number.NaN }, state.conversations)?.width).toBe(.4);
    expect(normalizeDocumentDock({ tree: { ...expected.tree, ratio: Infinity }, width: -.5 }, state.conversations))
      .toEqual({ width: .2, tree: { ...expected.tree, ratio: .5 } });
  });

  test("malformed optional layouts and cyclic or oversized trees cannot prevent content recovery", () => {
    const state = fixture();
    for (const value of [null, [], "bad", {}, { width: .4 }]) {
      state.documentDock = value as unknown as DocumentDockLayout;
      for (const restored of roundTrips(state)) {
        expect(restored).not.toBeNull();
        expect(restored?.documentDock).toBeUndefined();
      }
    }
    const cyclic: any = { type: "split", id: "cycle", direction: "vertical", ratio: .5, second: pane("side") };
    cyclic.first = cyclic;
    expect(normalizeDocumentDock({ tree: cyclic, width: .4 }, state.conversations)?.tree).toEqual(pane("side"));
    let deep: DocumentDockNode = pane("side");
    for (let index = 0; index < 2_000; index++) deep = { type: "split", id: `split-${index}`, direction: "horizontal", ratio: .5,
      first: deep, second: pane("other") };
    expect(normalizeDocumentDock({ tree: deep, width: .4 }, state.conversations)?.tree).toEqual(pane("other"));
    expect(normalizeDocumentDock({ tree: pane("toString"), width: .4 }, state.conversations)?.tree).toBeNull();
  });

  test("split identities remain unique even when malformed data repeats generated fallback IDs", () => {
    const state = fixture();
    const tree = { type: "split", id: "same", direction: "horizontal", ratio: .5,
      first: { type: "split", id: "same", direction: "vertical", ratio: .5,
        first: pane(state.rootId), second: pane("side") }, second: pane("other") };
    const result = normalizeDocumentDock({ tree, width: .4 }, state.conversations)!.tree!;
    expect(result.type).toBe("split");
    if (result.type === "split" && result.first.type === "split") expect(result.id).not.toBe(result.first.id);
  });

  test("pin scope defaults to workspace and retains valid workspace or family choices", () => {
    const state = fixture();
    for (const scope of ["family", "workspace", "unknown", undefined, 42]) {
      state.documentDock = { width: .4, tree: { ...pane("side"), scope } } as DocumentDockLayout;
      const expected = { ...pane("side"), ...(scope === "family" || scope === "workspace" ? { scope } : {}) };
      for (const restored of roundTrips(state)) expect(restored?.documentDock?.tree).toEqual(expected);
    }
  });

  test("dock position round-trips on every side and invalid or legacy positions retain the left default", () => {
    const state = fixture();
    for (const position of ["left", "right", "top", "bottom", "center", undefined, 42, null]) {
      state.documentDock = { ...state.documentDock!, position } as DocumentDockLayout;
      const expected = { width: state.documentDock.width, tree: state.documentDock.tree,
        ...(["left", "right", "top", "bottom"].includes(position as string) ? { position } : {}) };
      for (const restored of roundTrips(state)) expect(restored?.documentDock).toEqual(expected);
    }
  });

  test("moving a dock saves only its workspace manifest and retains the position when panes are deleted", () => {
    const initial = fixture();
    const render = createVaultFileRenderer();
    const first = render(initial, {});
    const moved: AppState = { ...initial, documentDock: { ...initial.documentDock!, position: "bottom" } };
    expect(hasSameAuthoredState(initial, moved)).toBe(false);
    const second = render(moved, first);
    expect(Object.keys(second).filter((path) => second[path].content !== first[path]?.content)).toEqual(["workspace.json"]);
    expect(vaultToState(second, initial).documentDock).toEqual(moved.documentDock);
    const next = deleteThread(moved, initial.rootId, createMainConversation({ id: "replacement", createdAt }));
    expect(next.documentDock).toEqual({ width: .45, position: "bottom", tree: pane("other") });
    expect(deleteThread(next, "other", createMainConversation({ id: "replacement", createdAt })).documentDock)
      .toEqual({ width: .45, position: "bottom", tree: null });
  });

  test("dock-only edits save to the vault and explicit clearing never restores a previous layout", () => {
    const initial = fixture();
    const render = createVaultFileRenderer();
    const first = render(initial, {});
    const resized = { ...initial, documentDock: { ...initial.documentDock!, width: .6 } };
    expect(hasSameAuthoredState(initial, resized)).toBe(false);
    const second = render(resized, first);
    expect(Object.keys(second).filter((path) => second[path].content !== first[path]?.content)).toEqual(["workspace.json"]);
    expect(vaultToState(second, initial).documentDock).toEqual(resized.documentDock);
    const empty = { ...resized, documentDock: { width: .6, tree: null } };
    const third = render(empty, second);
    expect(vaultToState(third, resized).documentDock).toEqual(empty.documentDock);
    const { documentDock: _dock, ...cleared } = resized;
    const fourth = render(cleared, third);
    expect(vaultToState(fourth, initial).documentDock).toBeUndefined();
  });

  test("deleting a family removes its dock panes and preserves unrelated pinned documents", () => {
    const state = fixture();
    const replacement = createMainConversation({ id: "replacement", createdAt });
    const next = deleteThread(state, state.rootId, replacement);
    expect(next.documentDock).toEqual({ width: .45, tree: pane("other") });
    expect(state.documentDock!.tree!.type).toBe("split");
    const empty = deleteThread(next, "other", replacement);
    expect(empty.documentDock).toEqual({ width: .45, tree: null });
  });

  test("additive database migration preserves documents and round-trips or clears pinned grids", async () => {
    const pg = new PGlite({ extensions: { vector } });
    const client = { async query(sql: string, values?: unknown[]) {
      const result = values === undefined && sql.includes(";") ? (await pg.exec(sql)).at(-1)! : await pg.query(sql, values);
      return { ...result, rowCount: result.rows.length || (result as { affectedRows?: number }).affectedRows || 0 };
    } };
    try {
      const migrations = await loadMigrations();
      await migrateDatabase(client, { migrations: migrations.filter((migration) => migration.id < "0009_document_dock") });
      await pg.exec(`insert into marginchat_users (id,email,password_hash,display_name) values ('dock-user','dock@example.test','hash','Dock');
        insert into marginchat_app_sessions (id,user_id) values ('workspace-dock-user','dock-user');
        insert into marginchat_conversations (id,session_id,title,service_id,created_at,updated_at)
          values ('old-document','workspace-dock-user','Preserved document','backend-services',now(),now());`);
      expect((await migrateDatabase(client, { migrations })).executed)
        .toEqual(migrations.filter((migration) => migration.id >= "0009_document_dock").map((migration) => migration.id));
      const legacy = await readState(client, "dock-user");
      expect(legacy.conversations["old-document"].title).toBe("Preserved document");
      expect(legacy.documentDock).toBeUndefined();
      const state = fixture();
      state.documentDock!.position = "right";
      if (state.documentDock!.tree!.type === "split") state.documentDock!.tree!.first = { ...pane("side"), scope: "family" };
      await writeState(client, "dock-user", normalizeAppState(state));
      const restored = await readState(client, "dock-user");
      expect(restored.documentDock).toEqual(state.documentDock);
      delete restored.conversations.side;
      restored.conversations[restored.rootId].childIds = [];
      await writeState(client, "dock-user", normalizeAppState(restored));
      expect((await readState(client, "dock-user")).documentDock).toEqual({ width: .45, position: "right", tree: pane("other") });
      delete restored.documentDock;
      await writeState(client, "dock-user", normalizeAppState(restored));
      expect((await readState(client, "dock-user")).documentDock).toBeUndefined();
    } finally { await pg.close(); }
  }, 30_000);
});
