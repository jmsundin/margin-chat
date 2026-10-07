import { describe, expect, test } from "bun:test";
import { createEmptyState, createMainConversation } from "../client/src/initialState";
import { openThreadAsChat, type BrowserThread } from "../client/src/lib/browserWorkspace";
import { addRootConversation } from "../client/src/lib/workspaceCommands";

const thread = (overrides: Partial<BrowserThread> = {}): BrowserThread => ({
  id: "thread-0001", createdAt: "2026-10-06T10:00:00.000Z", title: "Explain: a useful passage",
  userContent: "> a useful passage\n\nSource: [Article](https://example.com/a)\n\nExplain this passage clearly and briefly.",
  answer: "It means **something**.", ...overrides,
});

describe("page conversations in the workspace", () => {
  test("become an ordinary root chat holding the question and the answer, with no AI request", () => {
    const state = openThreadAsChat(createEmptyState(), thread(), true);
    const chat = state.conversations["web-thread-thread-0001"];
    expect(chat).toMatchObject({ kind: "chat", parentId: null, title: "Explain: a useful passage", createdAt: "2026-10-06T10:00:00.000Z" });
    expect(chat.messages.map((message) => [message.id, message.role])).toEqual([["web-thread-thread-0001:user", "user"], ["web-thread-thread-0001:assistant", "assistant"]]);
    expect(chat.messages[0].content).toContain("> a useful passage");
    expect(chat.messages[1].content).toBe("It means **something**.");
    expect(chat.messages[1].execution).toBeUndefined();
    expect(state.activeConversationId).toBe(chat.id);
    expect(state.rootId).toBe(chat.id);
    expect(chat.serviceId).toBe(state.defaultServiceId);
  });
  test("are added once, however many times they are delivered", () => {
    const once = openThreadAsChat(createEmptyState(), thread(), false);
    const twice = openThreadAsChat(once, thread({ answer: "Changed upstream." }), false);
    expect(twice).toBe(once);
    expect(Object.keys(twice.conversations).filter((id) => id.startsWith("web-thread-"))).toHaveLength(1);
    expect(twice.conversations["web-thread-thread-0001"].messages[1].content).toBe("It means **something**.");
  });
  test("a quiet import keeps the reader where they were", () => {
    const base = addRootConversation(createEmptyState(), createMainConversation({ id: "mine", createdAt: "2026-10-01T00:00:00.000Z" }));
    expect(base.activeConversationId).toBe("mine");
    const imported = openThreadAsChat(base, thread(), false);
    expect(imported.activeConversationId).toBe("mine");
    expect(imported.rootId).toBe("mine");
    expect(imported.conversations["web-thread-thread-0001"]).toBeDefined();
    expect(imported.conversations.mine).toBe(base.conversations.mine);
  });
  test("opening an already-imported conversation focuses it and keeps later edits", () => {
    const base = addRootConversation(createEmptyState(), createMainConversation({ id: "mine", createdAt: "2026-10-01T00:00:00.000Z" }));
    const imported = openThreadAsChat(base, thread(), false);
    imported.conversations["web-thread-thread-0001"].messages.push({ id: "follow-up", role: "user", content: "And then?", createdAt: "2026-10-06T11:00:00.000Z" });
    const focused = openThreadAsChat(imported, thread(), true);
    expect(focused.activeConversationId).toBe("web-thread-thread-0001");
    expect(focused.conversations["web-thread-thread-0001"].messages).toHaveLength(3);
  });
  test("bound an unreasonable title", () => {
    const state = openThreadAsChat(createEmptyState(), thread({ title: "t".repeat(500) }), false);
    expect(state.conversations["web-thread-thread-0001"].title).toHaveLength(120);
  });
});

test("the import hook waits for the vault, delivers each request once, and acknowledges it", async () => {
  const child = Bun.spawn([process.execPath, "tests/helpers/browserThreadHarness.tsx"], { cwd: new URL("..", import.meta.url).pathname, stdout: "pipe", stderr: "pipe" });
  const timeout = setTimeout(() => child.kill(), 15000);
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  clearTimeout(timeout);
  if (code !== 0) throw new Error(`Browser thread import harness failed:\n${stdout}\n${stderr}`);
  expect(JSON.parse(stdout.trim().split("\n").at(-1)!).checks).toHaveLength(4);
}, 20000);
