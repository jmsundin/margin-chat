import { describe, expect, test } from "bun:test";
import {
  createAppStateFromWorkspaceDocument,
  createMarkdownWorkspace,
  createWorkspaceDocument,
  normalizeAIExecution,
  parseMarkdownWorkspace,
  type AIExecutionRecord,
} from "@margin-chat/workspace-contracts";
import { createEmptyState } from "../client/src/initialState";
import { hydratePersistedState } from "../client/src/lib/appState";
import { ChatExecutions } from "../client/src/lib/chatExecution";
import { readChatReplyStream, type ChatReplyResponse } from "../client/src/lib/chatStream";
import { exportVault, importVault } from "../client/src/lib/vaultLocal";
import { emptyVault } from "../client/src/lib/vaultTypes";
import { stateToVaultFiles, vaultToState } from "../client/src/lib/vaultWorkspace";
import { normalizeAppState } from "../server/db/validation.mjs";

const methods = ["jev", "jev-task", "rules", "manual"] as const;
const base = {
  schemaVersion: 1,
  model: "actual-fallback-model",
  provider: "gemini-api",
  mode: "balanced",
  task: "research",
  reason: "Selected for this request.",
  profileVersion: "test-profile",
  sources: [],
  truncated: false,
  fallbacks: [{ provider: "openai-api", model: "original-selected-model", reason: "Unavailable" }],
  warnings: [],
};

function receipt(method: typeof methods[number] = "jev", status: AIExecutionRecord["status"] = "complete") {
  return normalizeAIExecution({ ...base, routing: { method, selectedModel: "original-selected-model" }, status })!;
}

function metadata(execution: AIExecutionRecord): ChatReplyResponse["metadata"] {
  return { model: execution.model, requestedServiceId: "backend-services", resolvedServiceId: "gemini-api", execution };
}

function streamedEvents(events: Record<string, unknown>[]) {
  const bytes = new TextEncoder().encode(events.map((event) => JSON.stringify(event)).join("\n"));
  return new ReadableStream<Uint8Array>({
    start(controller) {
      // Split through JSON tokens so the receipt must survive real buffering.
      for (let offset = 0; offset < bytes.length; offset += 17) controller.enqueue(bytes.slice(offset, offset + 17));
      controller.close();
    },
  });
}

describe("routing receipt contract", () => {
  test("preserves supported routing methods without inferring provenance for older records", () => {
    expect(normalizeAIExecution(base)).not.toHaveProperty("routing");
    for (const method of methods) {
      expect(receipt(method).routing).toEqual({ method, selectedModel: "original-selected-model" });
    }
  });

  test("omits malformed routing data without dropping the surrounding receipt", () => {
    for (const routing of [
      undefined, null, [], "jev", {},
      { method: "untrusted", selectedModel: "model" },
      { method: "jev", selectedModel: "" },
      { method: "jev", selectedModel: " \n\t " },
      { method: "jev", selectedModel: 42 },
      { method: { value: "jev" }, selectedModel: "model" },
    ]) {
      const value = normalizeAIExecution({ ...base, routing });
      expect(value?.model).toBe(base.model);
      expect(value).not.toHaveProperty("routing");
    }
  });

  test("bounds selected models and discards arbitrary nested routing fields", () => {
    const value = normalizeAIExecution({ ...base, routing: {
      method: "rules", selectedModel: `  ${"x".repeat(300)}  `,
      apiKey: "private", arguments: { executable: "ignored" }, rationale: "hidden reasoning",
    } })!;
    expect(value.routing).toEqual({ method: "rules", selectedModel: "x".repeat(200) });
    expect(JSON.stringify(value)).not.toContain("private");
    expect(JSON.stringify(value)).not.toContain("hidden reasoning");
    expect(normalizeAIExecution(value)).toEqual(value);
  });

  for (const method of methods) {
    test(`${method} survives JSON, Markdown, SQL validation and vault ZIP restore`, () => {
      const state = createEmptyState();
      const conversation = state.conversations[state.rootId];
      const execution = receipt(method);
      conversation.messages = [{ id: "answer", role: "assistant", content: "Answer.", createdAt: conversation.createdAt, execution }];
      const workspace = createAppStateFromWorkspaceDocument(createWorkspaceDocument(state))!;
      expect(workspace.conversations[conversation.id].messages[0].execution).toEqual(execution);
      const markdown = createMarkdownWorkspace(workspace);
      const parsed = parseMarkdownWorkspace(markdown.manifest, markdown.files)!;
      expect(parsed.conversations[conversation.id].messages[0].execution).toEqual(execution);
      const validated = normalizeAppState(parsed);
      expect(validated.conversations.find((item: any) => item.id === conversation.id).messages[0].execution).toEqual(execution);
      const hydrated = hydratePersistedState(JSON.parse(JSON.stringify(parsed)))!;
      expect(hydrated.conversations[conversation.id].messages[0].execution).toEqual(execution);
      const files = stateToVaultFiles(parsed, {});
      const restored = vaultToState(importVault(exportVault({ ...emptyVault(), files })), createEmptyState());
      expect(restored.conversations[conversation.id].messages[0].execution).toEqual(execution);
    });
  }

  test("streaming callbacks and completion retain selected-model provenance alongside the actual model", async () => {
    const callbacks: ChatReplyResponse["metadata"][] = [];
    const deltas: string[] = [];
    const complete = receipt();
    const result = await readChatReplyStream(streamedEvents([
      { type: "metadata", metadata: metadata(receipt("jev", "streaming")) },
      { type: "delta", delta: "Answer." },
      { type: "done", metadata: metadata(complete) },
    ]), (delta) => deltas.push(delta), (value) => callbacks.push(value));
    expect(deltas).toEqual(["Answer."]);
    expect(callbacks).toHaveLength(2);
    expect(callbacks.map((value) => value.execution?.routing)).toEqual([complete.routing, complete.routing]);
    expect(result.metadata.execution).toEqual(complete);
    expect(result.metadata.execution?.model).not.toBe(result.metadata.execution?.routing?.selectedModel);
  });

  for (const completed of [true, false]) {
    test(`execution owner retains routing when a stream ${completed ? "completes" : "ends early"}`, async () => {
      const receipts: AIExecutionRecord[] = [];
      const errors: unknown[] = [];
      let finish!: () => void;
      const finished = new Promise<void>((resolve) => { finish = resolve; });
      const executions = new ChatExecutions({
        onDelta() {},
        onExecution: (_conversation, _message, value) => receipts.push(value),
        onPending: (_conversation, pending) => { if (!pending) finish(); },
      });
      const events: Record<string, unknown>[] = [
        { type: "metadata", metadata: metadata(receipt("jev-task", "streaming")) },
        { type: "delta", delta: "Response text." },
      ];
      if (completed) events.push({ type: "done", metadata: metadata(receipt("jev-task")) });
      executions.start({
        conversationId: "chat", messageId: "answer", createdAt: "2026-09-19T00:00:00Z",
        onError: (error) => errors.push(error),
        request: (onDelta, _signal, onMetadata) => readChatReplyStream(streamedEvents(events), onDelta, onMetadata),
      });
      await finished;
      expect(receipts.at(-1)).toMatchObject({
        model: base.model,
        routing: { method: "jev-task", selectedModel: "original-selected-model" },
        status: completed ? "complete" : "failed",
      });
      expect(errors).toHaveLength(completed ? 0 : 1);
      expect(executions.has("chat")).toBe(false);
    });
  }
});
