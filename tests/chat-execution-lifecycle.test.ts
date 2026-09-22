import { describe, expect, test } from "bun:test";
import { ChatExecutions, type ChatExecution } from "../client/src/lib/chatExecution";
import { normalizeAIExecution } from "@margin-chat/workspace-contracts";

const metadata = { execution: normalizeAIExecution({ schemaVersion: 1, model: "test-model", provider: "openai-api", status: "streaming", reason: "Selected model", sources: [] }) };

function deferred() {
  let resolve!: (value?: unknown) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<unknown>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fixture() {
  const events: string[] = [];
  const timers = new Map<number, () => void>();
  let timerId = 0;
  const executions = new ChatExecutions({
    onDelta(_conversation, message, delta) { events.push(`delta:${message}:${delta}`); },
    onPending(_conversation, pending) { events.push(`pending:${pending}`); },
    onExecution(_conversation, message, receipt) { events.push(`receipt:${message}:${receipt.status}`); },
  }, {
    schedule(callback) { const id = ++timerId; timers.set(id, callback); return id as unknown as ReturnType<typeof setTimeout>; },
    cancel(id) { timers.delete(id as unknown as number); },
  });
  function request(message = "answer", onFinish?: ChatExecution["onFinish"]) {
    const transport = deferred();
    const completed = deferred();
    let delta!: (text: string) => void;
    let receipt!: Parameters<ChatExecution["request"]>[2];
    let signal!: AbortSignal;
    const accepted = executions.start({
      conversationId: "chat", messageId: message, createdAt: "2026-09-20T00:00:00Z",
      request(onDelta, requestSignal, onMetadata) { delta = onDelta; receipt = onMetadata; signal = requestSignal; return transport.promise; },
      onError(error) { events.push(`error:${message}:${(error as Error).message}`); },
      onFinish(status) { events.push(`finish:${message}:${status}`); onFinish?.(status); completed.resolve(); },
    });
    return { accepted, transport, completed, send(text: string) { delta(text); }, metadata() { receipt(metadata); }, get signal() { return signal; } };
  }
  return { events, timers, executions, request };
}

async function settle() { for (let index = 0; index < 7; index += 1) await Promise.resolve(); }

describe("generation finish lifecycle", () => {
  test("completion saves the final buffered text and receipt before one finish callback", async () => {
    const f = fixture();
    const run = f.request();
    await settle();
    run.metadata(); run.send("First "); run.send("last");
    expect(f.events).toEqual(["pending:true"]);
    run.transport.resolve();
    await run.completed.promise;
    await settle();
    expect(f.events).toEqual(["pending:true", "delta:answer:First last", "receipt:answer:complete", "finish:answer:complete", "pending:false"]);
    expect(f.executions.has("chat")).toBe(false);
    expect(f.timers.size).toBe(0);
    run.send(" late"); run.metadata(); f.executions.stop("chat");
    await settle();
    expect(f.events.filter((event) => event.startsWith("finish:"))).toEqual(["finish:answer:complete"]);
    expect(f.events.some((event) => event.includes("late"))).toBe(false);
  });

  test("Stop flushes a partial reply, finishes once, and ignores the old transport after a restart", async () => {
    const f = fixture();
    const old = f.request("old");
    await settle();
    old.metadata(); old.send("Kept partial");
    const queuedFlush = [...f.timers.values()][0];
    f.executions.stop("chat"); f.executions.stop("chat");
    expect(old.signal.aborted).toBe(true);
    expect(f.events).toEqual(["pending:true", "delta:old:Kept partial", "receipt:old:stopped", "finish:old:stopped", "pending:false"]);
    expect(f.timers.size).toBe(0);
    const next = f.request("new");
    await settle();
    old.send(" stale"); old.metadata(); queuedFlush(); old.transport.reject(new Error("Aborted old transport"));
    await settle();
    expect(f.executions.has("chat")).toBe(true);
    expect(f.events.at(-1)).toBe("pending:true");
    next.send("New output"); next.transport.resolve();
    await next.completed.promise;
    expect(f.events.filter((event) => event.startsWith("finish:"))).toEqual(["finish:old:stopped", "finish:new:complete"]);
    expect(f.events.some((event) => event.includes("stale") || event.startsWith("error:"))).toBe(false);
  });

  test("failure saves buffered text and a failed receipt before error and finish notifications", async () => {
    const f = fixture();
    const run = f.request();
    await settle();
    run.metadata(); run.send("Partial reply"); run.transport.reject(new Error("Connection lost"));
    await run.completed.promise;
    await settle();
    expect(f.events).toEqual(["pending:true", "delta:answer:Partial reply", "receipt:answer:failed", "error:answer:Connection lost", "finish:answer:failed", "pending:false"]);
    f.executions.stop("chat");
    expect(f.events.filter((event) => event.startsWith("finish:"))).toHaveLength(1);
    expect(f.timers.size).toBe(0);
  });

  test("a synchronous request error still calls failed finish once without inventing output", async () => {
    const f = fixture();
    f.executions.start({ conversationId: "chat", messageId: "answer", createdAt: "now",
      request() { throw new Error("Cannot start"); }, onError() { f.events.push("error"); }, onFinish(status) { f.events.push(`finish:${status}`); } });
    await settle();
    expect(f.events).toEqual(["pending:true", "error", "finish:failed", "pending:false"]);
    expect(f.executions.has("chat")).toBe(false);
  });

  for (const ending of ["complete", "stopped", "failed"] as const) {
    test(`a ${ending} callback can start a successor without the old run clearing its pending state`, async () => {
      const f = fixture();
      let successor: ReturnType<typeof f.request> | undefined;
      const first = f.request("old", () => { successor = f.request("new"); });
      await settle();
      first.send("Old output");
      if (ending === "stopped") f.executions.stop("chat");
      else if (ending === "failed") first.transport.reject(new Error("Transport failed"));
      else first.transport.resolve();
      await first.completed.promise;
      await settle();
      expect(successor?.accepted).toBe(true);
      expect(f.executions.has("chat")).toBe(true);
      expect(f.events.filter((event) => event.startsWith("pending:"))).toEqual(["pending:true", "pending:true"]);
      successor!.transport.resolve();
      first.transport.resolve();
      await successor!.completed.promise;
      await settle();
      expect(f.events.filter((event) => event.startsWith("finish:"))).toEqual([`finish:old:${ending}`, "finish:new:complete"]);
      expect(f.events.filter((event) => event.startsWith("pending:"))).toEqual(["pending:true", "pending:true", "pending:false"]);
    });
  }

  test("stopping before dispatch skips the transport but still finishes once", async () => {
    const f = fixture();
    let calls = 0;
    f.executions.start({ conversationId: "chat", messageId: "answer", createdAt: "now",
      request() { calls += 1; return Promise.resolve(); }, onError() { throw new Error("Unexpected error"); }, onFinish(status) { f.events.push(`finish:${status}`); } });
    f.executions.stop("chat");
    await settle();
    expect(calls).toBe(0);
    expect(f.events).toEqual(["pending:true", "finish:stopped", "pending:false"]);
  });

  test("silent teardown discards buffered text and suppresses callbacks after unmount", async () => {
    const f = fixture();
    const run = f.request();
    await settle();
    run.send("Discard during sign-out");
    f.executions.abortAll(false);
    run.transport.reject(new Error("Aborted"));
    await settle();
    expect(f.events).toEqual(["pending:true"]);
    expect(run.signal.aborted).toBe(true);
    expect(f.timers.size).toBe(0);
    expect(f.executions.has("chat")).toBe(false);
  });
});
