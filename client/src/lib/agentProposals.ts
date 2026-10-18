import type { AgentProposal, AIExecutionRecord, Conversation } from "../types";
import { getDocumentBlockAuthorship, getEditableDocument, splitDocumentMarkdown, type DocumentBlock } from "./editableDocument";

/** Why an edit couldn't be applied: its text is gone, or now appears more than once. */
export type TextEditFailure = "missing" | "ambiguous";

const SEPARATOR = "\n\n";

/**
 * Replaces `find` with `replace` in a document's text, the blocks joined as the editor and the agent see
 * them. An empty `find` adds `replace` at the end. Changed blocks keep their position and first ID, are
 * re-split into whole Markdown units, and carry AI authorship, so the edit shows the AI line. Block IDs
 * are derived from the blocks they replace, so the same edit always yields the same document.
 */
export function applyTextEdit(conversation: Conversation, find: string, replace: string, updatedAt = new Date().toISOString()): Conversation | TextEditFailure {
  const document = getEditableDocument(conversation);
  const blocks = document.blocks;
  const ids = new Set(blocks.map((block) => block.id));
  const freshId = (base: string) => {
    let candidate = base;
    for (let index = 2; ids.has(candidate); index += 1) candidate = `${base}:${index}`;
    ids.add(candidate);
    return candidate;
  };
  // Parts lose trailing blank lines, which the joined text adds back, so the new text reads exactly as proposed.
  const toBlocks = (content: string, template: DocumentBlock | null, authorship: DocumentBlock["authorship"]) => content.trim()
    ? splitDocumentMarkdown(content).map((part) => part.replace(/\s+$/u, "")).filter(Boolean).map((part, index): DocumentBlock => ({
      ...(template ?? { createdAt: updatedAt, kind: "markdown" as const }),
      id: index === 0 && template ? template.id : freshId(`${(template?.id ?? `agent-edit:${conversation.id}`).slice(0, 200)}:edit:${index}`),
      kind: "markdown", content: part, updatedAt, authorship,
    })) : [];
  const save = (next: DocumentBlock[]): Conversation => ({ ...conversation, updatedAt,
    document: { ...document, blocks: next.length ? next : [{ id: freshId(`empty:${conversation.id}`), kind: "markdown", content: "", createdAt: updatedAt, updatedAt, authorship: "user" }] } });

  if (!find) {
    const kept = blocks.filter((block, index) => block.content.trim() || index < blocks.length - 1);
    return save([...kept, ...toBlocks(replace.trim(), null, "ai")]);
  }
  const text = blocks.map((block) => block.content).join(SEPARATOR);
  const at = text.indexOf(find);
  if (at < 0) return "missing";
  if (text.indexOf(find, at + 1) >= 0) return "ambiguous";
  const end = at + find.length;
  const starts: number[] = [];
  let offset = 0;
  for (const block of blocks) { starts.push(offset); offset += block.content.length + SEPARATOR.length; }
  // The last block starting at or before each end of the match.
  const blockAt = (position: number) => { let index = 0; while (index + 1 < starts.length && starts[index + 1] <= position) index += 1; return index; };
  const first = blockAt(at);
  const last = Math.max(first, blockAt(end - 1));
  const prefix = blocks[first].content.slice(0, Math.min(at - starts[first], blocks[first].content.length));
  const suffix = blocks[last].content.slice(Math.max(0, end - starts[last]));
  const affected = blocks.slice(first, last + 1);
  const allAI = affected.every((block) => getDocumentBlockAuthorship(block, conversation.messages) === "ai");
  const changed = toBlocks(`${prefix}${replace}${suffix}`, blocks[first], allAI ? "ai" : "mixed");
  return save([...blocks.slice(0, first), ...changed, ...blocks.slice(last + 1)]);
}

/** A proposal can be undone only by finding its new text again, so a deletion or an empty append can't be. */
export function canUndoProposal(proposal: AgentProposal) {
  return proposal.kind === "edit" && proposal.status === "approved" && proposal.replace.trim() !== "";
}

/** The reverse of an approved edit: its new text back to the old (an append is removed). */
export function undoEditArguments(proposal: Extract<AgentProposal, { kind: "edit" }>): [string, string] {
  return proposal.find ? [proposal.replace, proposal.find] : [proposal.replace.trim(), ""];
}

/** The execution record with one proposal's decision changed; `status: undefined` makes it pending again. */
export function withProposalUpdate(execution: AIExecutionRecord, proposalId: string, update: { status?: "approved" | "dismissed"; createdId?: string }): AIExecutionRecord {
  const agent = execution.agent;
  if (!agent?.proposals) return execution;
  return { ...execution, agent: { ...agent, proposals: agent.proposals.map((proposal) => {
    if (proposal.id !== proposalId) return proposal;
    const { status: _status, ...rest } = proposal;
    return { ...rest, ...(update.status ? { status: update.status } : {}),
      ...(proposal.kind === "create" && update.createdId ? { createdId: update.createdId } : {}) } as AgentProposal;
  }) } };
}
