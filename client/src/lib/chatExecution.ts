import { normalizeAIExecution } from "@margin-chat/workspace-contracts";
import type { AIExecutionRecord } from "../types";
import type { ChatReplyResponse } from "./chatStream";

export interface ChatExecution {
  conversationId: string;
  messageId: string;
  createdAt: string;
  request: (onDelta: (delta: string) => void, signal: AbortSignal, onMetadata: (metadata: ChatReplyResponse["metadata"]) => void) => Promise<unknown>;
  onError: (error: unknown) => void;
  /** Runs once after final buffered output/receipt delivery; silent teardown suppresses it. */
  onFinish?: (status: "complete" | "stopped" | "failed") => void;
}

interface ActiveExecution {
  controller: AbortController;
  flush: () => void;
  discard: () => void;
  mark: (status: AIExecutionRecord["status"]) => void;
  finish: (status: "complete" | "stopped" | "failed") => void;
}

/** Owns buffered output and ensures a retired request cannot affect its successor. */
export class ChatExecutions {
  private active = new Map<string, ActiveExecution>();

  constructor(private readonly events: {
    onDelta: (conversationId: string, messageId: string, delta: string, createdAt: string) => void;
    onPending: (conversationId: string, pending: boolean) => void;
    onExecution?: (conversationId: string, messageId: string, execution: AIExecutionRecord) => void;
  }, private readonly scheduler = {
    schedule: (callback: () => void) => setTimeout(callback, 32),
    cancel: (timer: ReturnType<typeof setTimeout>) => clearTimeout(timer),
  }) {}

  has(conversationId: string) { return this.active.has(conversationId); }

  start(args: ChatExecution): boolean {
    if (this.has(args.conversationId)) return false;
    let buffer = "";
    let receipt: AIExecutionRecord | undefined;
    let receiptChanged = false;
    let hasOutput = false;
    let failed = false;
    let finished = false;
    const startedAt = Date.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cancelTimer = () => {
      if (timer !== undefined) this.scheduler.cancel(timer);
      timer = undefined;
    };
    const execution: ActiveExecution = {
      controller: new AbortController(),
      flush: () => {
        cancelTimer();
        const delta = buffer;
        buffer = "";
        if (delta) {
          this.events.onDelta(args.conversationId, args.messageId, delta, args.createdAt);
          hasOutput = true;
        }
        if (hasOutput && receipt && receiptChanged) {
          this.events.onExecution?.(args.conversationId, args.messageId, receipt);
          receiptChanged = false;
        }
      },
      discard: () => { cancelTimer(); buffer = ""; },
      mark: (status) => {
        if (!receipt) return;
        receipt = { ...receipt, status, durationMs: receipt.durationMs ?? Date.now() - startedAt,
          ...(status === "complete" ? { completedAt: receipt.completedAt ?? new Date().toISOString() } : {}) };
        receiptChanged = true;
      },
      finish: (status) => {
        if (finished) return;
        finished = true;
        args.onFinish?.(status);
      },
    };
    const isCurrent = () => this.active.get(args.conversationId) === execution;
    this.active.set(args.conversationId, execution);
    this.events.onPending(args.conversationId, true);
    const onDelta = (delta: string) => {
      if (!isCurrent() || !delta) return;
      buffer += delta;
      timer ??= this.scheduler.schedule(() => {
        if (isCurrent()) execution.flush();
        else execution.discard();
      });
    };
    const onMetadata = (metadata: ChatReplyResponse["metadata"]) => {
      if (!isCurrent()) return;
      const next = normalizeAIExecution(metadata?.execution);
      if (!next) return;
      receipt = { ...next, status: next.status ?? "streaming" };
      receiptChanged = true;
      if (hasOutput) execution.flush();
    };
    // A synchronous transport failure follows the same cleanup path as a rejection.
    void Promise.resolve().then(() => {
      if (isCurrent()) return args.request(onDelta, execution.controller.signal, onMetadata);
    }).then((result) => {
      if (isCurrent()) {
        if (result && typeof result === "object" && "metadata" in result) onMetadata(result.metadata as ChatReplyResponse["metadata"]);
        execution.mark("complete");
        execution.flush();
      }
      else execution.discard();
    }).catch((error: unknown) => {
      if (!isCurrent()) { execution.discard(); return; }
      failed = true;
      execution.mark("failed");
      execution.flush();
      if (!execution.controller.signal.aborted) args.onError(error);
    }).finally(() => {
      if (!isCurrent()) return;
      this.active.delete(args.conversationId);
      execution.finish(failed ? "failed" : "complete");
      // onFinish may synchronously start another generation in this conversation.
      if (!this.active.has(args.conversationId)) this.events.onPending(args.conversationId, false);
    });
    return true;
  }

  stop(conversationId: string, preserveOutput = true, notify = true) {
    const execution = this.active.get(conversationId);
    if (!execution) return;
    if (preserveOutput) { execution.mark("stopped"); execution.flush(); }
    else execution.discard();
    this.active.delete(conversationId);
    if (notify) execution.finish("stopped");
    execution.controller.abort();
    if (notify && !this.active.has(conversationId)) this.events.onPending(conversationId, false);
  }

  abort(conversationIds: Iterable<string>, notify = true) {
    for (const id of conversationIds) this.stop(id, false, notify);
  }

  abortAll(notify = true) { this.abort([...this.active.keys()], notify); }
}
