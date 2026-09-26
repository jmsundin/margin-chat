import { describe, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import {
  createAppStateFromWorkspaceDocument, createMarkdownWorkspace, createMarkdownWorkspaceRenderer,
  createWorkspaceDocument, normalizeDocumentLayout, parseMarkdownWorkspace,
  type AppState, type DocumentLayout,
} from "@margin-chat/workspace-contracts";
import { createEmptyState, createMainConversation, createSideConversation } from "../client/src/initialState";
import { hydratePersistedState } from "../client/src/lib/appState";
import { createVaultFileRenderer, hasSameAuthoredState, vaultToState } from "../client/src/lib/vaultWorkspace";
import { loadMigrations, migrateDatabase } from "../server/db/migrations.mjs";
import { readState, writeState } from "../server/db/repository.mjs";
import { normalizeAppState } from "../server/db/validation.mjs";

const createdAt = "2026-09-23T12:00:00.000Z";
function fixture(): AppState {
  const state = createEmptyState();
  const root = state.conversations[state.rootId];
  const first = createSideConversation({ id: "side-first", sourceConversation: root, createdAt });
  const second = createSideConversation({ id: "side-second", sourceConversation: root, createdAt });
  const nested = createSideConversation({ id: "side-nested", sourceConversation: first, createdAt });
  first.childIds = [nested.id];
  root.childIds = [first.id, second.id];
  root.documentLayout = { order: [second.id, root.id, first.id, nested.id], minimizedIds: [first.id],
    widthsById: { [root.id]: 680, [first.id]: 420, [nested.id]: 835 } };
  state.conversations = { ...state.conversations, [first.id]: first, [second.id]: second, [nested.id]: nested,
    other: createMainConversation({ id: "other", createdAt }) };
  state.pinnedThreadIds = [nested.id, root.id, first.id];
  return state;
}

function layouts(state: AppState) {
  return Object.fromEntries(Object.values(state.conversations).map((conversation) => [conversation.id, conversation.documentLayout]));
}

describe("document layout persistence", () => {
  test("workspace, local recovery and Markdown retain display order independently of ancestry", () => {
    const state = fixture();
    const markdown = createMarkdownWorkspace(state);
    const restoredStates = [
      createAppStateFromWorkspaceDocument(createWorkspaceDocument(state)),
      hydratePersistedState(state),
      parseMarkdownWorkspace(markdown.manifest, markdown.files),
    ];
    for (const restored of restoredStates) {
      expect(restored).not.toBeNull();
      expect(layouts(restored!)).toEqual(layouts(state));
      expect(restored!.pinnedThreadIds).toEqual(state.pinnedThreadIds);
      expect(restored!.conversations["side-first"].parentId).toBe(state.rootId);
      expect(restored!.conversations["side-nested"].parentId).toBe("side-first");
      expect(restored!.conversations[state.rootId].childIds).toEqual(["side-first", "side-second"]);
    }
    const normalized = normalizeAppState(state);
    expect(normalized.pinnedThreadIds).toEqual(state.pinnedThreadIds);
    expect(normalized.conversations.find((conversation: { id: string }) => conversation.id === state.rootId).documentLayout)
      .toEqual(state.conversations[state.rootId].documentLayout);
  });

  test("all readers discard stale, duplicate, foreign and non-root layout entries without losing documents", () => {
    const state = fixture();
    const root = state.conversations[state.rootId];
    root.documentLayout = { order: ["other", "missing", "side-second", "side-second", root.id, "side-nested", 42],
      minimizedIds: [root.id, "other", "side-first", "missing", "side-first"] } as unknown as DocumentLayout;
    state.conversations["side-first"].documentLayout = { order: ["side-first", "side-nested"], minimizedIds: [] };
    const expected = { order: ["side-second", root.id, "side-nested"], minimizedIds: ["side-first"] };
    const markdown = createMarkdownWorkspace(state);
    for (const restored of [hydratePersistedState(state), createAppStateFromWorkspaceDocument(createWorkspaceDocument(state)),
      parseMarkdownWorkspace(markdown.manifest, markdown.files)]) {
      expect(restored!.conversations[root.id].documentLayout).toEqual(expected);
      expect(restored!.conversations["side-first"].documentLayout).toBeUndefined();
      expect(Object.keys(restored!.conversations)).toHaveLength(5);
    }
    const normalized = normalizeAppState(state);
    expect(normalized.conversations.find((conversation: { id: string }) => conversation.id === root.id).documentLayout).toEqual(expected);
    expect(normalized.conversations.find((conversation: { id: string }) => conversation.id === "side-first").documentLayout).toBeUndefined();
  });

  test("missing or malformed optional layout does not invalidate older workspaces", () => {
    for (const layout of [undefined, null, [], "bad", { order: [] }, { order: "bad", minimizedIds: [] }]) {
      const state = fixture();
      state.conversations[state.rootId].documentLayout = layout as DocumentLayout;
      const markdown = createMarkdownWorkspace(state);
      for (const restored of [hydratePersistedState(state), createAppStateFromWorkspaceDocument(createWorkspaceDocument(state)),
        parseMarkdownWorkspace(markdown.manifest, markdown.files)]) {
        expect(restored).not.toBeNull();
        expect(restored!.conversations[state.rootId].documentLayout).toBeUndefined();
      }
      expect(normalizeAppState(state).conversations[0].documentLayout).toBeUndefined();
    }
  });

  test("normalization safely ignores cyclic and orphaned references without filling missing positions", () => {
    const conversations = { root: { parentId: null }, child: { parentId: "root" }, loop: { parentId: "loop" }, orphan: { parentId: "missing" } };
    expect(normalizeDocumentLayout({ order: ["loop", "orphan", "toString", "child"], minimizedIds: ["child"] }, "root", conversations))
      .toEqual({ order: ["child"], minimizedIds: ["child"] });
  });

  test("readers clamp finite widths and discard malformed, stale and foreign width entries", () => {
    const state = fixture();
    const root = state.conversations[state.rootId];
    root.documentLayout!.widthsById = {
      [root.id]: 80, "side-first": 1700, "side-second": 513.5, "side-nested": "600",
      missing: 700, other: 700, toString: 700,
    } as unknown as Record<string, number>;
    const markdown = createMarkdownWorkspace(state);
    const expected = { [root.id]: 320, "side-first": 980, "side-second": 513.5 };
    for (const restored of [hydratePersistedState(state), createAppStateFromWorkspaceDocument(createWorkspaceDocument(state)),
      parseMarkdownWorkspace(markdown.manifest, markdown.files)]) {
      expect(restored!.conversations[root.id].documentLayout?.widthsById).toEqual(expected);
    }
    expect(normalizeAppState(state).conversations.find((conversation: { id: string }) => conversation.id === root.id)
      .documentLayout.widthsById).toEqual(expected);
    for (const widthsById of [undefined, null, [], "bad", { [root.id]: NaN }, { [root.id]: Infinity }, { missing: 640 }]) {
      expect(normalizeDocumentLayout({ order: [root.id], minimizedIds: [], widthsById }, root.id, state.conversations))
        .toEqual({ order: [root.id], minimizedIds: [] });
    }
  });

  test("width-only edits are written to incremental Markdown and vault files, including reset", () => {
    const initial = fixture();
    const renderMarkdown = createMarkdownWorkspaceRenderer();
    const firstMarkdown = renderMarkdown(initial, createdAt);
    const renderVault = createVaultFileRenderer();
    const firstVault = renderVault(initial, {});
    const changed = structuredClone(initial);
    changed.conversations[changed.rootId].documentLayout!.widthsById!["side-first"] = 740;
    expect(hasSameAuthoredState(initial, changed)).toBe(false);
    const secondMarkdown = renderMarkdown(changed, createdAt, firstMarkdown);
    expect(layouts(parseMarkdownWorkspace(secondMarkdown.manifest, secondMarkdown.files)!)).toEqual(layouts(changed));
    const secondVault = renderVault(changed, firstVault);
    expect(Object.keys(secondVault).filter((path) => secondVault[path].content !== firstVault[path]?.content)).toHaveLength(1);
    expect(layouts(vaultToState(secondVault, initial))).toEqual(layouts(changed));
    const reset = structuredClone(changed);
    delete reset.conversations[reset.rootId].documentLayout!.widthsById;
    const resetMarkdown = renderMarkdown(reset, createdAt, secondMarkdown);
    expect(layouts(parseMarkdownWorkspace(resetMarkdown.manifest, resetMarkdown.files)!)).toEqual(layouts(reset));
    expect(layouts(vaultToState(renderVault(reset, secondVault), changed))).toEqual(layouts(reset));
  });

  test("incremental Markdown saves retain changed positions and minimized panes", () => {
    const initial = fixture();
    const render = createMarkdownWorkspaceRenderer();
    const first = render(initial, createdAt);
    const changed = structuredClone(initial);
    changed.conversations[changed.rootId].documentLayout = { order: ["side-first", "side-second", changed.rootId], minimizedIds: ["side-second", "side-nested"] };
    const second = render(changed, createdAt, first);
    expect(layouts(parseMarkdownWorkspace(second.manifest, second.files)!)).toEqual(layouts(changed));
  });

  test("vault saves layout-only edits with unchanged timestamps and retains pinned side documents on reopen", () => {
    const initial = fixture();
    const render = createVaultFileRenderer();
    const first = render(initial, {});
    const root = initial.conversations[initial.rootId];
    const changed = { ...initial, conversations: { ...initial.conversations, [root.id]: {
      ...root, documentLayout: { order: ["side-first", "side-second", root.id], minimizedIds: ["side-second"] },
    } } };
    expect(changed.conversations[root.id].updatedAt).toBe(root.updatedAt);
    expect(hasSameAuthoredState(initial, changed)).toBe(false);
    const second = render(changed, first);
    expect(Object.keys(second).filter((path) => second[path].content !== first[path]?.content)).toHaveLength(1);
    const reopened = vaultToState(second, initial);
    expect(layouts(reopened)).toEqual(layouts(changed));
    expect(reopened.pinnedThreadIds).toEqual(initial.pinnedThreadIds);
  });

  test("additive migration preserves existing content and database writes retain or clear layouts", async () => {
    const pg = new PGlite({ extensions: { vector } });
    const client = { async query(sql: string, values?: unknown[]) {
      const result = values === undefined && sql.includes(";") ? (await pg.exec(sql)).at(-1)! : await pg.query(sql, values);
      return { ...result, rowCount: result.rows.length || (result as { affectedRows?: number }).affectedRows || 0 };
    } };
    try {
      const migrations = await loadMigrations();
      await migrateDatabase(client, { migrations: migrations.filter((migration) => migration.id < "0008_document_layout") });
      await pg.exec(`insert into marginchat_users (id,email,password_hash,display_name) values ('layout-user','layout@example.test','hash','Layout');
        insert into marginchat_app_sessions (id,user_id) values ('workspace-layout-user','layout-user');
        insert into marginchat_conversations (id,session_id,title,service_id,created_at,updated_at)
          values ('old-document','workspace-layout-user','Retained document','backend-services',now(),now());`);
      expect((await migrateDatabase(client, { migrations })).executed)
        .toEqual(migrations.filter((migration) => migration.id >= "0008_document_layout").map((migration) => migration.id));
      const legacy = await readState(client, "layout-user");
      expect(legacy.conversations["old-document"].title).toBe("Retained document");
      expect(legacy.conversations["old-document"].documentLayout).toBeUndefined();
      const state = fixture();
      await writeState(client, "layout-user", normalizeAppState(state));
      const restored = await readState(client, "layout-user");
      expect(layouts(restored)).toEqual(layouts(state));
      expect(restored.pinnedThreadIds).toEqual(state.pinnedThreadIds);
      expect(restored.conversations["side-nested"].parentId).toBe("side-first");
      delete restored.conversations[restored.rootId].documentLayout;
      await writeState(client, "layout-user", normalizeAppState(restored));
      expect((await readState(client, "layout-user")).conversations[state.rootId].documentLayout).toBeUndefined();
    } finally { await pg.close(); }
  }, 30_000);
});
