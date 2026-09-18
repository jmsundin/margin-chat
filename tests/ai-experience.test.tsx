import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { normalizeAISettings, normalizeAIExecution, createWorkspaceDocument, createAppStateFromWorkspaceDocument, createMarkdownWorkspace, parseMarkdownWorkspace } from "@margin-chat/workspace-contracts";
import { createEmptyState, createStandaloneNoteConversation } from "../client/src/initialState";
import { prepareAIContext } from "../client/src/lib/aiContext";
import { ChatExecutions } from "../client/src/lib/chatExecution";
import { normalizeAppState } from "../server/db/validation.mjs";
import { stateToVaultFiles, vaultToState } from "../client/src/lib/vaultWorkspace";
import { exportVault, importVault } from "../client/src/lib/vaultLocal";
import { emptyVault } from "../client/src/lib/vaultTypes";
import AIResponseDetails from "../client/src/components/AIResponseDetails";
import { requestChatReply, requestUploadDocument } from "../client/src/lib/api";

const receipt = () => normalizeAIExecution({ schemaVersion: 1, model: "actual-model", provider: "gemini-api", mode: "balanced", task: "research",
  reason: "Selected for document synthesis.", profileVersion: "heuristic-test", sources: [{ kind: "note", id: "note", title: "Evidence", excerpt: "A saved source." }],
  truncated: true, fallbacks: [{ provider: "openai-api", model: "first-choice", reason: "Unavailable" }], warnings: ["Comparative quality is not yet measured."], durationMs: 800, status: "complete",
})!;

describe("portable AI experience", () => {
  test("saves settings and the actual answer receipt through JSON, Markdown, SQL normalization and ZIP restore", () => {
    const state = createEmptyState();
    const conversation = state.conversations[state.rootId];
    conversation.ai = { mode: "thorough", contextScope: "selected", selectedConversationIds: ["note"], allowedProviders: ["gemini"] };
    conversation.messages = [{ id: "answer", role: "assistant", content: "Supported answer.", createdAt: conversation.createdAt, execution: receipt() }];
    const json = createAppStateFromWorkspaceDocument(createWorkspaceDocument(state))!;
    const markdown = createMarkdownWorkspace(json);
    const parsed = parseMarkdownWorkspace(markdown.manifest, markdown.files)!;
    const validated = normalizeAppState(parsed);
    expect(validated.conversations.find((item: any) => item.id === conversation.id).messages[0].execution).toEqual(receipt());
    const files = stateToVaultFiles(parsed, {});
    const restored = vaultToState(importVault(exportVault({ ...emptyVault(), files })), createEmptyState());
    expect(restored.conversations[conversation.id].ai).toEqual(conversation.ai);
    expect(restored.conversations[conversation.id].messages[0].execution).toEqual(receipt());
  });

  test("keeps private comments out of local retrieval and uses the latest selected note", () => {
    const state = createEmptyState();
    const note = createStandaloneNoteConversation({ id: "note", noteId: "body" });
    note.notes![0].content = "Latest local revision before cloud sync";
    note.notes!.push({ ...note.notes![0], id: "secret", kind: "comment", content: "PRIVATE-MARGIN-SECRET" });
    state.conversations[note.id] = note;
    state.conversations[state.rootId].ai = normalizeAISettings({ contextScope: "selected", selectedConversationIds: ["note"] });
    const context = prepareAIContext(state.conversations, state.conversations[state.rootId], []);
    expect(context.workspaceContext[0].content).toBe(note.notes![0].content);
    expect(JSON.stringify(context)).not.toContain("PRIVATE-MARGIN-SECRET");
    state.conversations[state.rootId].ai!.contextScope = "conversation";
    expect(prepareAIContext(state.conversations, state.conversations[state.rootId], []).workspaceContext).toEqual([]);
  });

  test("preserves explicit provider denial and bounds untrusted imported receipt fields", () => {
    expect(normalizeAISettings({ allowedProviders: [] }).allowedProviders).toEqual([]);
    expect(normalizeAISettings({ allowedProviders: ["openai", "bogus", "openai"] }).allowedProviders).toEqual(["openai"]);
    expect(normalizeAIExecution({ ...receipt(), apiKey: "secret", reason: "x".repeat(5000) })).not.toHaveProperty("apiKey");
    expect(normalizeAIExecution({ ...receipt(), reason: "x".repeat(5000) })!.reason).toHaveLength(2000);
  });

  test("budgets prompt text rather than saved receipts and gives Thorough more room", () => {
    const state = createEmptyState();
    const conversation = state.conversations[state.rootId];
    const note = createStandaloneNoteConversation({ id: "note", noteId: "body" });
    note.notes![0].content = "Selected evidence";
    state.conversations[note.id] = note;
    conversation.ai = normalizeAISettings({ contextScope: "selected", selectedConversationIds: [note.id] });
    const message = { id: "prior", role: "assistant" as const, content: "Short answer", createdAt: conversation.createdAt,
      execution: normalizeAIExecution({ ...receipt(), sources: Array.from({ length: 100 }, (_, i) => ({ kind: "note", id: String(i), title: "Evidence", excerpt: "x".repeat(240) })), warnings: Array(20).fill("x".repeat(1000)) }) };
    expect(prepareAIContext(state.conversations, conversation, [message]).workspaceContext[0].content).toBe("Selected evidence");
    const history = [{ ...message, content: "Long chat".repeat(5500) }];
    expect(prepareAIContext(state.conversations, conversation, history).workspaceContext).toEqual([]);
    conversation.ai.mode = "thorough";
    expect(prepareAIContext(state.conversations, conversation, history).workspaceContext[0].content).toBe("Selected evidence");
  });

  test("discloses omitted context rather than silently sending an unlimited workspace", () => {
    const state = createEmptyState();
    for (let i = 0; i < 20; i++) {
      const note = createStandaloneNoteConversation({ id: `note-${i}`, noteId: `body-${i}` });
      note.notes![0].content = "Long material ".repeat(2000);
      state.conversations[note.id] = note;
    }
    state.conversations[state.rootId].ai = normalizeAISettings({ contextScope: "workspace" });
    const result = prepareAIContext(state.conversations, state.conversations[state.rootId], []);
    expect(result.workspaceContextTruncated).toBe(true);
    expect(JSON.stringify(result.workspaceContext).length).toBeLessThan(34_000);
  });

  test("shows actual model, reasons, source excerpts and fallback details in a saved answer", () => {
    const html = renderToStaticMarkup(<AIResponseDetails execution={receipt()} />);
    for (const text of ["actual-model", "Selected for document synthesis", "Google Gemini", "Evidence", "A saved source", "first-choice", "Unavailable", "Some context was shortened", "0.8 seconds"]) expect(html).toContain(text);
  });

  test("reopened partial answers do not pretend that a stream is still running", () => {
    const html = renderToStaticMarkup(<AIResponseDetails execution={{ ...receipt(), status: "streaming" }} />);
    expect(html).toContain("Partial answer saved; completion not recorded");
    expect(html).not.toContain("Responding with");
  });
});

test("chat transport binds the account and omits persisted receipts from current and ancestor messages", async () => {
  const originalFetch = globalThis.fetch;
  let sent: any;
  let headers: Headers;
  globalThis.fetch = (async (_url: any, options: any) => {
    sent = JSON.parse(options.body);
    headers = new Headers(options.headers);
    return Response.json({ reply: "Answer", metadata: { model: "actual-model", requestedServiceId: "backend-services", resolvedServiceId: "gemini-api", execution: receipt() } });
  }) as typeof fetch;
  try {
    const message = { id: "saved", role: "assistant" as const, content: "Prior text", createdAt: new Date().toISOString(), execution: receipt() };
    await requestChatReply({ expectedUserId: "expected-account", serviceId: "backend-services", modelId: "auto", messages: [message],
      conversation: { id: "chat", title: "Chat", parentId: "parent", branchAnchor: null, documents: [], ancestorContext: [{ id: "parent", title: "Parent", branchAnchor: null, messages: [message] }] } });
    expect(headers!.get("X-Margin-Vault-User")).toBe("expected-account");
    expect(sent).not.toHaveProperty("expectedUserId");
    expect(sent.messages[0]).not.toHaveProperty("execution");
    expect(sent.conversation.ancestorContext[0].messages[0]).not.toHaveProperty("execution");
    expect(sent.messages[0].content).toBe("Prior text");
  } finally { globalThis.fetch = originalFetch; }
});

test("an interrupted stream keeps its model receipt and ignores late completion", async () => {
  const receipts: any[] = [];
  const deltas: string[] = [];
  let finish!: (value: any) => void;
  const executions = new ChatExecutions({ onDelta: (_conversation, _message, delta) => deltas.push(delta), onPending() {}, onExecution: (_conversation, _message, value) => receipts.push(value) });
  executions.start({ conversationId: "chat", messageId: "answer", createdAt: new Date().toISOString(), onError() {}, request: async (onDelta, _signal, onMetadata) => {
    onMetadata({ model: "actual-model", requestedServiceId: "backend-services", resolvedServiceId: "gemini-api", execution: { ...receipt(), status: "streaming" } });
    onDelta("Partial answer");
    return new Promise((resolve) => { finish = resolve; });
  } });
  await Promise.resolve();
  executions.stop("chat");
  expect(deltas).toEqual(["Partial answer"]);
  expect(receipts.at(-1).model).toBe("actual-model");
  expect(receipts.at(-1).status).toBe("stopped");
  finish({ metadata: { execution: receipt() } });
  await Bun.sleep(0);
  expect(receipts.at(-1).status).toBe("stopped");
});

test("attachment uploads carry the same provider policy and account as the conversation", async () => {
  const originalFetch = globalThis.fetch;
  let sent: FormData;
  let headers: Headers;
  globalThis.fetch = (async (_url: any, options: any) => {
    sent = options.body;
    headers = new Headers(options.headers);
    return Response.json({ document: { id: "saved-original" } });
  }) as typeof fetch;
  try {
    const ai = normalizeAISettings({ allowedProviders: ["gemini"] });
    await requestUploadDocument(new File(["Original contents"], "source.txt", { type: "text/plain" }), "expected-account", ai);
    expect(headers!.get("X-Margin-Vault-User")).toBe("expected-account");
    expect(JSON.parse(String(sent!.get("ai")))).toEqual(ai);
    expect(await (sent!.get("file") as File).text()).toBe("Original contents");
  } finally { globalThis.fetch = originalFetch; }
});
