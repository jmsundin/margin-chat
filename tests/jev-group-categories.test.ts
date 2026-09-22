import { expect, test } from "bun:test";
import { createMainConversation, createStandaloneNoteConversation } from "../client/src/initialState";
import { buildJevGroupEvidence, buildJevGroupSnapshot, orderJevGroups } from "../client/src/lib/jevGroupCategories";
import { validateWorkspaceAnalysis } from "../server/semantic/workspaceAnalysis.mjs";

function fixture() {
  const chat = createMainConversation({ id: "a-chat" });
  chat.title = "Debugging an API";
  chat.messages = [{ id: "visible", role: "user", content: "A permitted API question.", createdAt: chat.createdAt },
    { id: "hidden", role: "system", content: "SYSTEM_SECRET", createdAt: chat.createdAt }];
  const note = createStandaloneNoteConversation({ id: "b-note", noteId: "note-body" });
  note.title = "Implementation notes"; note.notes![0].content = "A permitted standalone note.";
  chat.notes = [{ ...note.notes![0], id: "private", kind: "comment", content: "MARGIN_SECRET" }];
  note.notes!.push({ ...note.notes![0], id: "side", kind: "comment", content: "SIDE_SECRET" });
  (chat.messages[0] as any).execution = { reason: "RECEIPT_SECRET" };
  const conversations = { [chat.id]: chat, [note.id]: note };
  const group = { id: "engineering", name: "Engineering", color: "#4fbf9f", collapsed: false, conversationIds: [chat.id, note.id] };
  return { conversations, group, chat, note };
}

test("group classification sends named, bounded permitted evidence without private annotations", () => {
  const { conversations, group } = fixture();
  const evidence = buildJevGroupEvidence({ engineering: group }, conversations);
  const snapshot = buildJevGroupSnapshot(evidence)!;
  const serialized = JSON.stringify(snapshot);
  for (const secret of ["SYSTEM_SECRET", "MARGIN_SECRET", "SIDE_SECRET", "RECEIPT_SECRET"]) expect(serialized).not.toContain(secret);
  for (const permitted of ["Engineering", "Debugging an API", "Implementation notes", "A permitted API question.", "A permitted standalone note."]) expect(serialized).toContain(permitted);
  expect(snapshot.groups).toBeUndefined();
  expect(buildJevGroupSnapshot([])).toBeNull();
});

test("semantic fingerprints change only for meaningful group evidence", () => {
  const { conversations, group, chat, note } = fixture();
  const fingerprint = (candidate = group) => buildJevGroupEvidence({ engineering: candidate }, conversations)[0].fingerprint;
  const original = fingerprint();
  expect(fingerprint({ ...group, color: "#123456", collapsed: true, conversationIds: [...group.conversationIds].reverse() })).toBe(original);
  chat.updatedAt = "2026-09-22"; chat.notes![0].content = "Changed private annotation";
  expect(fingerprint()).toBe(original);
  expect(fingerprint({ ...group, name: "New name" })).not.toBe(original);
  expect(fingerprint({ ...group, conversationIds: [chat.id] })).not.toBe(original);
  note.title = "Different visible title";
  expect(fingerprint()).not.toBe(original);
  const beforeExcerpt = fingerprint();
  note.notes![0].content = "A changed permitted excerpt";
  expect(fingerprint()).not.toBe(beforeExcerpt);
});

test("all member titles invalidate their group while request evidence stays within existing server limits", () => {
  const { conversations, group } = fixture();
  for (let index = 0; index < 40; index++) {
    const note = createStandaloneNoteConversation({ id: `member-${index}`, noteId: `body-${index}` });
    note.title = "Long member title ".repeat(100); note.notes![0].content = "Permitted primary body ".repeat(1000);
    conversations[note.id] = note; group.conversationIds.push(note.id);
  }
  group.name = "Group name ".repeat(100);
  const before = buildJevGroupEvidence({ engineering: group }, conversations)[0];
  conversations["member-39"].title = "Changed title outside the eight sampled titles";
  const after = buildJevGroupEvidence({ engineering: group }, conversations)[0];
  expect(after.item).toEqual(before.item);
  expect(after.fingerprint).not.toBe(before.fingerprint);
  const groups = Object.fromEntries(Array.from({ length: 23 }, (_, index) => [`g-${index}`, { ...group, id: `g-${index}` }]));
  const snapshot = buildJevGroupSnapshot(buildJevGroupEvidence(groups, conversations))!;
  expect(snapshot.items).toHaveLength(10);
  expect(snapshot.items.every((item) => item.content.length <= 1400 && item.title.length <= 200)).toBe(true);
  const validated = validateWorkspaceAnalysis({ enabled: true, ...snapshot, categories: true });
  expect(validated.items).toEqual(snapshot.items);
});

test("known semantic categories keep peers together without guessing labels for uncertain groups", () => {
  const ids = ["unknown-a", "writing-a", "coding-a", "coding-b", "unknown-b", "writing-b"];
  const result = orderJevGroups(ids, { "writing-a": "writing", "writing-b": "writing", "coding-a": "coding", "coding-b": "coding" });
  expect(result.orderedGroupIds).toEqual(["coding-a", "coding-b", "writing-a", "writing-b", "unknown-a", "unknown-b"]);
  expect(result.categoryLabels["coding-a"]).toBe("Coding");
  expect(result.categoryLabels["writing-a"]).toBe("Writing");
  expect(result.categoryLabels).not.toHaveProperty("unknown-a");
  expect(ids[0]).toBe("unknown-a");
});
