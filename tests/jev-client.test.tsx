import { afterEach, describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createEmptyState, createStandaloneNoteConversation } from "../client/src/initialState";
import { createDefaultGraphNodeLayout } from "../client/src/lib/graphLayout";
import {
  applyJevCategories, buildJevWorkspaceSnapshot, getJevPreferenceKey,
  parseJevWorkspaceResult, requestJevStatus, requestJevWorkspace, withJevConsent,
  jevItemFingerprint,
} from "../client/src/lib/jevAssistance";
import { buildThreadSummaries } from "../client/src/lib/conversationSearch";
import { buildCategoryOrganizedGraphLayouts } from "../client/src/lib/graphCategories";
import AppSettingsModal from "../client/src/components/AppSettingsModal";
import JevRelatedItems from "../client/src/components/JevRelatedItems";
import ConversationGraphView, { calculateFitViewport } from "../client/src/components/ConversationGraphView";
import { buildConversationForestGraphScene } from "../client/src/lib/conversationGraph";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

function fixture() {
  const state = createEmptyState();
  const current = state.conversations[state.rootId];
  current.title = "A short story";
  current.messages = [{ id: "message", role: "user", content: "Help tell this story", createdAt: current.createdAt }];
  const note = createStandaloneNoteConversation({ id: "note", noteId: "body" });
  note.title = "Story outline";
  note.notes![0].content = "The traveler returns home.";
  state.conversations.note = note;
  return { state, current, note };
}

describe("Jev workspace assistance", () => {
  test("whitelists primary content and excludes private notes, receipts and system instructions", () => {
    const { state, current, note } = fixture();
    current.messages.push({ id: "system", role: "system", content: "SYSTEM_SECRET", createdAt: current.createdAt });
    (current.messages[0] as any).execution = { reason: "RECEIPT_SECRET" };
    current.notes = [{ ...note.notes![0], id: "margin", kind: "comment", content: "MARGIN_SECRET" }];
    note.notes!.push({ ...note.notes![0], id: "side", kind: "comment", content: "SIDE_SECRET" });
    note.messages = [{ id: "old", role: "user", content: "OLD_NOTE_BODY", createdAt: note.createdAt }];
    const snapshot = buildJevWorkspaceSnapshot(state.conversations, current.id)!;
    const serialized = JSON.stringify(snapshot);
    for (const secret of ["SYSTEM_SECRET", "RECEIPT_SECRET", "MARGIN_SECRET", "SIDE_SECRET", "OLD_NOTE_BODY"]) expect(serialized).not.toContain(secret);
    expect(serialized).toContain("The traveler returns home.");
    expect(serialized).toContain("Help tell this story");
  });

  test("bounds large workspaces and includes the active item even when it is old", () => {
    const { state, current } = fixture();
    current.updatedAt = "2000-01-01T00:00:00Z";
    for (let index = 0; index < 100; index++) {
      const note = createStandaloneNoteConversation({ id: `note-${index}`, noteId: `body-${index}` });
      note.notes![0].content = "x".repeat(10_000);
      state.conversations[note.id] = note;
    }
    const snapshot = buildJevWorkspaceSnapshot(state.conversations, current.id)!;
    expect(snapshot.items.length).toBe(40);
    expect(snapshot.items.reduce((sum, item) => sum + item.content.length, 0)).toBeLessThanOrEqual(16_000);
    expect(snapshot.items.every((item) => item.content.length <= 400)).toBe(true);
    expect(snapshot.current.id).toBe(current.id);
    expect(buildJevWorkspaceSnapshot(state.conversations, "missing")).toBeNull();
  });

  test("category fingerprints change when the server's effective per-item allowance changes", () => {
    const { state, current, note } = fixture();
    note.notes![0].content = "x".repeat(1600);
    const small = buildJevWorkspaceSnapshot(state.conversations, current.id)!.items.find((item) => item.id === note.id)!;
    for (let i = 0; i < 20; i++) state.conversations[`extra-${i}`] = createStandaloneNoteConversation({ id: `extra-${i}`, noteId: `body-${i}` });
    const large = buildJevWorkspaceSnapshot(state.conversations, current.id)!.items.find((item) => item.id === note.id)!;
    expect(small.content).toHaveLength(1600);
    expect(large.content).toHaveLength(Math.floor(16_000 / 22));
    expect(jevItemFingerprint(small)).not.toBe(jevItemFingerprint(large));
  });

  test("editing another item without changing the excerpt allowance leaves the fingerprint unchanged", () => {
    const { state, current, note } = fixture();
    note.notes![0].content = "x".repeat(1600);
    const before = buildJevWorkspaceSnapshot(state.conversations, current.id)!.items.find((item) => item.id === note.id)!;
    current.messages[0].content = "A different request";
    const after = buildJevWorkspaceSnapshot(state.conversations, current.id)!.items.find((item) => item.id === note.id)!;
    expect(jevItemFingerprint(after)).toBe(jevItemFingerprint(before));
  });

  test("group matching snapshots include bounded member titles and change with meaningful group edits", () => {
    const { state, current, note } = fixture();
    const group = { id: "project", name: "Story project", color: "#4fbf9f", collapsed: false, conversationIds: [note.id] };
    const before = buildJevWorkspaceSnapshot(state.conversations, current.id, { project: group })!;
    expect(before.groups).toEqual([{ id: "project", name: "Story project", memberTitles: ["Story outline"] }]);
    const renamed = buildJevWorkspaceSnapshot(state.conversations, current.id, { project: { ...group, name: "Travel" } })!;
    const reassigned = buildJevWorkspaceSnapshot(state.conversations, current.id, { project: { ...group, conversationIds: [current.id] } })!;
    expect(JSON.stringify(before)).not.toBe(JSON.stringify(renamed));
    expect(JSON.stringify(before)).not.toBe(JSON.stringify(reassigned));
    const groups = Object.fromEntries(Array.from({ length: 30 }, (_, index) => [`g${index}`, { ...group, id: `g${index}`, conversationIds: [current.id, note.id, "missing"] }]));
    const bounded = buildJevWorkspaceSnapshot(state.conversations, current.id, groups)!;
    expect(bounded.groups).toHaveLength(20);
    expect(bounded.groups!.every((candidate) => candidate.memberTitles.length <= 2)).toBe(true);
  });

  test("only accepts confident group suggestions referring to actual snapshot groups and items", () => {
    const { state, current } = fixture();
    const snapshot = buildJevWorkspaceSnapshot(state.conversations, current.id, {
      project: { id: "project", name: "Project", color: "#4fbf9f", collapsed: false, conversationIds: [] },
    })!;
    const result = parseJevWorkspaceResult({ available: true, categories: [], related: [], groupSuggestions: [
      { id: current.id, groupId: "project", confidence: 0.9 },
      { id: "note", groupId: "project", confidence: 0.6 },
      { id: "missing", groupId: "project", confidence: 1 },
      { id: "note", groupId: "invented", confidence: 1 },
    ] }, snapshot);
    expect(result.groupSuggestions).toEqual([{ id: current.id, groupId: "project", confidence: 0.9 }]);
    expect(parseJevWorkspaceResult({ available: false, groupSuggestions: result.groupSuggestions }, snapshot).groupSuggestions).toEqual([]);
  });

  test("local consent overrides imported settings and remains account-specific", () => {
    expect(withJevConsent({ mode: "fast", contextScope: "conversation", selectedConversationIds: [], jevEnabled: true }, false)).not.toHaveProperty("jevEnabled");
    expect(withJevConsent(undefined, true)).toHaveProperty("jevEnabled", true);
    expect(getJevPreferenceKey("account-a")).not.toBe(getJevPreferenceKey("account-b"));
  });

  test("accepts only known categories and IDs, removes current/duplicate items, and limits related suggestions", () => {
    const { state, current } = fixture();
    for (let i = 0; i < 8; i++) state.conversations[`n${i}`] = createStandaloneNoteConversation({ id: `n${i}`, noteId: `b${i}` });
    const snapshot = buildJevWorkspaceSnapshot(state.conversations, current.id)!;
    const result = parseJevWorkspaceResult({ available: true, categories: [
      { id: current.id, categoryId: "writing", confidence: 0.9 },
      { id: "note", categoryId: "invented", confidence: 1 },
      { id: "n1", categoryId: "coding", confidence: 0.2 },
      { id: "missing", categoryId: "writing", confidence: 1 },
    ], related: [
      { id: current.id, score: 1 }, { id: "missing", score: 1 }, { id: "note", score: -1 },
      ...Array.from({ length: 8 }, (_, i) => ({ id: `n${i}`, score: 0.9 - i / 100 })), { id: "n0", score: 0.99 },
    ] }, snapshot);
    expect(result.categories).toEqual([{ id: current.id, categoryId: "writing", confidence: 0.9 }]);
    expect(result.related).toHaveLength(5);
    expect(result.related[0]).toEqual({ id: "n0", score: 0.99 });
    expect(parseJevWorkspaceResult({ available: false, categories: [{ id: current.id, categoryId: "writing", confidence: 1 }], related: [{ id: "note", score: 1 }] }, snapshot).related).toEqual([]);
  });

  test("binds both endpoints to the account and transmits explicit consent", async () => {
    const { state, current } = fixture();
    const snapshot = buildJevWorkspaceSnapshot(state.conversations, current.id)!;
    const calls: Array<{ url: unknown; init: RequestInit | undefined }> = [];
    globalThis.fetch = (async (url, init) => {
      calls.push({ url, init });
      return Response.json(url === "/api/jev/status" ? { configured: false } : { available: false, categories: [], related: [] });
    }) as typeof fetch;
    const signal = new AbortController().signal;
    expect(await requestJevStatus("account", signal)).toBe(false);
    expect((await requestJevWorkspace("account", snapshot, true, signal)).available).toBe(false);
    await requestJevWorkspace("account", snapshot, [current.id], signal);
    await requestJevWorkspace("account", snapshot, [], signal);
    for (const call of calls) {
      expect(new Headers(call.init?.headers).get("X-Margin-Vault-User")).toBe("account");
      expect(call.init?.credentials).toBe("same-origin");
      expect(call.init?.signal).toBe(signal);
    }
    expect(JSON.parse(String(calls[1].init!.body))).toEqual({ enabled: true, ...snapshot, categories: true, related: true });
    expect(JSON.parse(String(calls[2].init!.body))).toEqual({ enabled: true, ...snapshot, categories: true, categoryIds: [current.id], related: true });
    expect(JSON.parse(String(calls[3].init!.body))).toEqual({ enabled: true, ...snapshot, categories: false, categoryIds: [], related: true });
  });

  test("tracks valid uncertain category coverage without accepting unknown or unavailable IDs", () => {
    const { state, current } = fixture();
    const snapshot = buildJevWorkspaceSnapshot(state.conversations, current.id)!;
    const result = parseJevWorkspaceResult({ available: true, categories: [], related: [], evaluatedCategoryIds: [current.id, current.id, "missing", 12] }, snapshot);
    expect(result.categories).toEqual([]);
    expect(result.evaluatedCategoryIds).toEqual([current.id]);
    expect(parseJevWorkspaceResult({ available: false, evaluatedCategoryIds: [current.id] }, snapshot).evaluatedCategoryIds).toBeUndefined();
    expect(() => parseJevWorkspaceResult({ available: true, categories: [], related: [], evaluatedCategoryIds: "bad" }, snapshot)).toThrow("invalid category coverage");
  });

  test("feeds accepted categories into graph labels and explicit topic organization without mutating layouts", () => {
    const { state, current, note } = fixture();
    const original = structuredClone(state.graphLayouts);
    const threads = applyJevCategories(buildThreadSummaries(state.conversations), { [current.id]: "coding", [note.id]: "coding" });
    expect(threads.every((thread) => thread.categoryLabel === "Coding")).toBe(true);
    const arranged = buildCategoryOrganizedGraphLayouts({ conversations: state.conversations, graphLayouts: state.graphLayouts, threads });
    expect(arranged[current.id].x).toBe(arranged[note.id].x);
    expect(state.graphLayouts).toEqual(original);
    const html = renderToStaticMarkup(<ConversationGraphView activeConversationId={current.id} conversations={state.conversations} groups={{}} threads={threads}
      onActivateConversation={() => {}} onAssignGroup={() => {}} onCreateChildConversation={() => null} onOpenConversation={() => {}} onToggleGroup={() => {}} onUpdateGraphNodeLayouts={() => {}} />);
    expect(html).toContain("conversation-graph-node-category");
    expect(html).toContain("Coding");
    expect(html).toContain("Organize graph by topic");
  });

  test("fits both notes after topic organization creates negative positions", () => {
    const notes = Object.fromEntries(["first", "second"].map((id) => [id, createStandaloneNoteConversation({ id, noteId: `body-${id}` })]));
    const layouts = buildCategoryOrganizedGraphLayouts({ conversations: notes, graphLayouts: {}, threads: buildThreadSummaries(notes) });
    expect(layouts.first.x).toBeLessThan(0);
    expect(layouts.first.y).toBeLessThan(0);
    const scene = buildConversationForestGraphScene({ conversations: notes, selectedConversationId: "first", treeLayouts: layouts, semanticLevel: "summary" });
    const viewport = { clientWidth: 1008, clientHeight: 650 };
    const fitted = calculateFitViewport(scene, viewport);
    for (const node of scene.nodes) {
      const x = fitted.x + node.x * fitted.scale;
      const y = fitted.y + node.y * fitted.scale;
      expect(x).toBeGreaterThanOrEqual(28);
      expect(y).toBeGreaterThanOrEqual(23.99);
      expect(x + node.width * fitted.scale).toBeLessThanOrEqual(viewport.clientWidth - 28);
      expect(y + node.height * fitted.scale).toBeLessThanOrEqual(viewport.clientHeight - 23.99);
    }
  });

  test("topic organization moves a saved tree origin with its independently positioned root", () => {
    const { state, current } = fixture();
    state.graphLayouts[current.id] = createDefaultGraphNodeLayout({ x: 250, y: 450, positioned: true, treeOriginX: 100, treeOriginY: 200 });
    const arranged = buildCategoryOrganizedGraphLayouts({ conversations: state.conversations, graphLayouts: state.graphLayouts, threads: buildThreadSummaries(state.conversations) });
    const root = arranged[current.id];
    expect(root.treeOriginX! - root.x).toBe(100 - 250);
    expect(root.treeOriginY! - root.y).toBe(200 - 450);
    expect(root.positioned).toBe(true);
  });

  test("shows consent disclosure, off-by-default switch, related notes, and honest fallback states", () => {
    const { state, current } = fixture();
    const settings = renderToStaticMarkup(<AppSettingsModal isOpen mainViewMode="chat" theme="light" onClose={() => {}} onSetMainViewMode={() => {}} onSetTheme={() => {}} onSetJevEnabled={() => {}} />);
    expect(settings).toContain("TypeSafe analyzes permitted chat context");
    expect(settings).toContain("Private margin and side notes are excluded");
    expect(settings).not.toContain('checked=""');
    const props = { conversations: state.conversations, currentId: current.id, related: [{ id: "note", score: 0.8 }], onSelect() {} };
    expect(renderToStaticMarkup(<JevRelatedItems {...props} status="off" />)).toBe("");
    expect(renderToStaticMarkup(<JevRelatedItems {...props} status="ready" />)).toContain("Story outline");
    const warning = "Some suggestions were unavailable. Existing categories were retained.";
    const partial = renderToStaticMarkup(<JevRelatedItems {...props} status="ready" warning={warning} />);
    expect(partial).toContain("Story outline");
    expect(partial).toContain(`<p role="status">${warning}</p>`);
    for (const status of ["unconfigured", "unavailable", "loading", "paused"] as const) {
      const html = renderToStaticMarkup(<JevRelatedItems {...props} status={status} warning={warning} />);
      expect(html).not.toContain("Story outline");
      expect(html).not.toContain(warning);
      expect(html).toContain('role="status"');
    }
  });
});

test("client Jev hook debounces, caches, cancels stale work, and isolates consent between accounts", async () => {
  const child = Bun.spawn([process.execPath, "tests/helpers/jevAssistanceHarness.tsx"], { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect({ code, stderr: code ? stderr : "" }).toEqual({ code: 0, stderr: "" });
  expect(stdout).toContain('"result":"pass"');
}, 20_000);
