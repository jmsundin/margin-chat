import { normalizeAISettings } from "@margin-chat/workspace-contracts";
import type { Conversation, Message } from "../types";
import { getStandaloneNote } from "./standaloneNotes";

export interface WorkspaceContextItem {
  id: string;
  title: string;
  updatedAt: string;
  content?: string;
  messages: Array<Pick<Message, "id" | "role" | "content">>;
}

/** Retrieval starts on the device so newly authored, unsynced text can be used. */
export function prepareAIContext(conversations: Record<string, Conversation>, conversation: Conversation, messages: Message[]) {
  const ai = normalizeAISettings(conversation.ai);
  if (ai.contextScope === "conversation") return { ai, workspaceContext: [] as WorkspaceContextItem[], workspaceContextTruncated: false };
  const query = [...messages].reverse().find((message) => message.role === "user")?.content ?? "";
  const terms = [...new Set(query.toLowerCase().match(/[\p{L}\p{N}_-]{3,}/gu) ?? [])];
  const selected = new Set(ai.selectedConversationIds);
  // Only primary standalone notes are AI-visible. Comments and side notes never enter ranking.
  const candidates = Object.values(conversations)
    .filter((candidate) => candidate.id !== conversation.id && (ai.contextScope === "workspace" || selected.has(candidate.id)))
    .map((candidate) => {
      const content = candidate.kind === "note" ? getStandaloneNote(candidate)?.content ?? "" : undefined;
      const visibleMessages = candidate.messages.filter((message) => message.role !== "system");
      const haystack = `${candidate.title}\n${content ?? ""}\n${visibleMessages.map((message) => message.content).join("\n")}`.toLowerCase();
      const score = terms.reduce((sum, term) => sum + (candidate.title.toLowerCase().includes(term) ? 4 : 0) + (haystack.includes(term) ? 1 : 0), 0);
      return { candidate, content, visibleMessages, score };
    }).sort((a, b) => b.score - a.score || b.candidate.updatedAt.localeCompare(a.candidate.updatedAt));
  const modeBudget = { fast: 24_000, balanced: 48_000, thorough: 96_000 }[ai.mode];
  // Saved answer details are for the user, not model input. Counting them here
  // would make a detailed receipt crowd out the user's selected material.
  const promptSize = messages.reduce((sum, { role, content }) => sum + JSON.stringify({ role, content }).length + 32, 0);
  let remaining = Math.max(0, Math.min(Math.floor(modeBudget * 2 / 3), modeBudget - 4_000 - promptSize));
  let truncated = false;
  const workspaceContext: WorkspaceContextItem[] = [];
  for (const { candidate, content, visibleMessages } of candidates) {
    if (remaining < 400 || workspaceContext.length >= 12) { truncated = true; continue; }
    const item: WorkspaceContextItem = { id: candidate.id, title: candidate.title, updatedAt: candidate.updatedAt, messages: [] };
    remaining -= candidate.id.length + candidate.title.length + 100;
    if (content !== undefined) {
      item.content = content.slice(0, Math.max(0, Math.min(16_000, remaining)));
      truncated ||= item.content.length !== content.length;
      remaining -= item.content.length;
    }
    // Keep recent exchanges in their original order. Any omission is disclosed.
    for (const message of [...visibleMessages].reverse()) {
      if (remaining < 100) { truncated = true; continue; }
      const body = message.content.slice(0, Math.max(0, Math.min(12_000, remaining - 100)));
      truncated ||= body.length !== message.content.length;
      item.messages.unshift({ id: message.id, role: message.role, content: body });
      remaining -= body.length + 100;
    }
    workspaceContext.push(item);
  }
  return { ai, workspaceContext, workspaceContextTruncated: truncated };
}
