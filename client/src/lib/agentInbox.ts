import type { AgentProposal, Conversation } from "../types";

/**
 * The agent inbox: everything an agent run is waiting on the person for, gathered from the runs already
 * saved on each document's replies. Nothing new is stored, so the inbox is right on every device and
 * empties itself as questions are answered and drafts decided.
 */
export type AgentInboxItem =
  /** A run stopped to ask something; replying in the document answers it. */
  | { kind: "question"; id: string; conversationId: string; messageId: string; title: string; at: string; text: string; options: string[]; receipt: AgentReceipt }
  /** A drafted change that changes nothing until approved. */
  | { kind: "proposal"; id: string; conversationId: string; messageId: string; title: string; at: string; proposal: AgentProposal; receipt: AgentReceipt }
  /** A run that ended before it finished: its budget, its rounds or its time ran out. */
  | { kind: "stopped"; id: string; conversationId: string; messageId: string; title: string; at: string; reason: "budget" | "round-limit" | "time-limit"; receipt: AgentReceipt };

/** What the run cost, for the receipt under each item. */
export interface AgentReceipt {
  model: string;
  steps: number;
  modelCalls?: number;
  spentMicros?: number;
  budgetMicros?: number;
}

const STOPPED = new Set(["budget", "round-limit", "time-limit"]);
/** A run that stopped early stays listed this long; after that it is old news. */
const STOPPED_FOR_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Items newest first. `dismissed` holds the ids of stopped-run notices the person has cleared; questions and
 * drafts can't be cleared, only answered or decided, because they are still open on the document.
 */
export function collectAgentInbox(conversations: Record<string, Conversation>, dismissed: ReadonlySet<string> = new Set(), now = Date.now()): AgentInboxItem[] {
  const items: AgentInboxItem[] = [];
  for (const conversation of Object.values(conversations)) {
    const messages = conversation.messages ?? [];
    const title = conversation.title || "Untitled";
    messages.forEach((message, index) => {
      const run = message.execution?.agent;
      if (message.role !== "assistant" || !run) return;
      const base = { conversationId: conversation.id, messageId: message.id, title, at: message.createdAt };
      const receipt: AgentReceipt = { model: message.execution!.model, steps: run.steps.length,
        ...(run.modelCalls === undefined ? {} : { modelCalls: run.modelCalls }),
        ...(run.spentMicros === undefined ? {} : { spentMicros: run.spentMicros }),
        ...(run.budgetMicros === undefined ? {} : { budgetMicros: run.budgetMicros }) };
      for (const proposal of run.proposals ?? []) {
        if (!proposal.status) items.push({ kind: "proposal", id: `${message.id}:${proposal.id}`, ...base, proposal, receipt });
      }
      // Only the document's last word can still be waiting: anything after it was the answer, or moved on.
      const last = !messages.slice(index + 1).some((later) => later.role === "user" || later.role === "assistant");
      if (!last) return;
      if (run.stopReason === "question" && run.question?.text) {
        items.push({ kind: "question", id: `${message.id}:question`, ...base, text: run.question.text, options: run.question.options ?? [], receipt });
      } else if (STOPPED.has(run.stopReason)) {
        const id = `${message.id}:stopped`;
        const age = now - Date.parse(message.createdAt);
        if (!dismissed.has(id) && !(age > STOPPED_FOR_MS)) items.push({ kind: "stopped", id, ...base, reason: run.stopReason as "budget" | "round-limit" | "time-limit", receipt });
      }
    });
  }
  return items.sort((left, right) => right.at.localeCompare(left.at) || left.id.localeCompare(right.id));
}

const DISMISSED_KEY = "margin-chat:agent-inbox-dismissed";
const MAX_DISMISSED = 200;

export function readDismissedAgentItems(): Set<string> {
  try {
    const value = JSON.parse(localStorage.getItem(DISMISSED_KEY) ?? "[]");
    return new Set(Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []);
  } catch { return new Set(); }
}

export function saveDismissedAgentItems(ids: ReadonlySet<string>) {
  try { localStorage.setItem(DISMISSED_KEY, JSON.stringify([...ids].slice(-MAX_DISMISSED))); }
  catch { /* Without storage a cleared notice returns on the next visit. */ }
}

export const STOPPED_LABELS = {
  budget: "Stopped at its spending limit",
  "round-limit": "Stopped at its step limit",
  "time-limit": "Stopped at its time limit",
} as const;

export function proposalAction(proposal: AgentProposal): string {
  return proposal.kind === "edit" ? `Edit “${proposal.documentTitle || "a document"}”`
    : proposal.kind === "create" ? `New document “${proposal.title || "Untitled"}”`
    : "New roadmap";
}
