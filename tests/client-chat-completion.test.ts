import { describe, expect, test } from "bun:test";
import { readChatReplyStream, type ChatReplyResponse } from "../client/src/lib/chatStream";
import { ChatExecutions } from "../client/src/lib/chatExecution";
import { normalizeAIExecution } from "@margin-chat/workspace-contracts";

const metadata: ChatReplyResponse["metadata"] = {
  model: "actual-model",
  requestedServiceId: "backend-services",
  resolvedServiceId: "gemini-api",
  execution: normalizeAIExecution({
    schemaVersion: 1, model: "actual-model", provider: "gemini-api", status: "streaming",
    reason: "Selected for this request", sources: [{ kind: "note", id: "source", title: "Evidence" }],
  }),
};

function response(events: Record<string, unknown>[]) {
  return new Response(events.map((event) => JSON.stringify(event)).join("\n"));
}

describe("assistant completion acknowledgement", () => {
  test("rejects EOF without done while retaining already delivered text and model metadata", async () => {
    const stream = response([{ type: "metadata", metadata }, { type: "delta", delta: "Partial reply" }]);
    const deltas: string[] = [];
    const receipts: ChatReplyResponse["metadata"][] = [];
    await expect(readChatReplyStream(stream.body!, (delta) => deltas.push(delta), (value) => receipts.push(value)))
      .rejects.toThrow("before the reply was complete");
    expect(deltas).toEqual(["Partial reply"]);
    expect(receipts.at(-1)?.execution?.model).toBe("actual-model");
    expect(stream.body!.locked).toBe(false);
  });

  test("a completion event without final metadata still acknowledges the earlier model and text", async () => {
    const stream = response([{ type: "metadata", metadata }, { type: "delta", delta: "Complete reply" }, { type: "done" }]);
    expect(await readChatReplyStream(stream.body!)).toEqual({ metadata, reply: "Complete reply" });
    expect(stream.body!.locked).toBe(false);
  });

  test("premature EOF saves buffered partial output with a failed receipt through the execution owner", async () => {
    const deltas: string[] = [];
    const receipts: any[] = [];
    const errors: unknown[] = [];
    let finish!: () => void;
    const finished = new Promise<void>((resolve) => { finish = resolve; });
    const executions = new ChatExecutions({
      onDelta: (_conversationId, _messageId, delta) => deltas.push(delta),
      onExecution: (_conversationId, _messageId, receipt) => receipts.push(receipt),
      onPending: (_conversationId, pending) => { if (!pending) finish(); },
    });
    executions.start({
      conversationId: "chat", messageId: "answer", createdAt: "2026-09-18T00:00:00Z",
      onError: (error) => errors.push(error),
      request: (onDelta, _signal, onMetadata) => readChatReplyStream(
        response([{ type: "metadata", metadata }, { type: "delta", delta: "Partial reply" }]).body!, onDelta, onMetadata,
      ),
    });
    await finished;
    expect(deltas).toEqual(["Partial reply"]);
    expect(receipts.at(-1)).toMatchObject({ model: "actual-model", status: "failed", sources: metadata.execution!.sources });
    expect(receipts.at(-1).completedAt).toBeUndefined();
    expect(errors).toHaveLength(1);
    expect(executions.has("chat")).toBe(false);
  });
});
