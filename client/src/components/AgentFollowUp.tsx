import { useState } from "react";
import { canUndoProposal } from "../lib/agentProposals";
import type { AgentProposal, AgentRunRecord } from "../types";
import "./AgentFollowUp.css";

export type AgentProposalAction = "approve" | "dismiss" | "undo";

const PREVIEW_CHARACTERS = 280;
const preview = (text: string) => {
  const flat = text.trim();
  return flat.length <= PREVIEW_CHARACTERS ? flat : `${flat.slice(0, PREVIEW_CHARACTERS - 1)}…`;
};

/** Answers for the question an agent run stopped with: its suggested answers, or the reader's own. */
function AgentQuestionAnswer({ options, disabled, onAnswer }: { options: string[]; disabled: boolean; onAnswer: (answer: string) => void }) {
  const [answer, setAnswer] = useState("");
  const send = (value: string) => { if (value.trim() && !disabled) { onAnswer(value.trim()); setAnswer(""); } };
  return <form className="agent-question" aria-label="Answer the agent's question" onSubmit={(event) => { event.preventDefault(); send(answer); }}>
    {options.length ? <div className="agent-question-options">{options.map((option) =>
      <button key={option} type="button" disabled={disabled} onClick={() => send(option)}>{option}</button>)}</div> : null}
    <div className="agent-question-reply">
      <input type="text" aria-label="Your answer" placeholder={options.length ? "Or type your own answer" : "Type your answer"}
        value={answer} disabled={disabled} onChange={(event) => setAnswer(event.target.value)}/>
      <button type="submit" disabled={disabled || !answer.trim()}>Answer</button>
    </div>
  </form>;
}

function ProposalBody({ proposal, documentTitle, currentDocumentId, onOpen }: {
  proposal: AgentProposal;
  documentTitle?: (id: string) => string | undefined;
  currentDocumentId: string;
  onOpen?: (id: string) => void;
}) {
  if (proposal.kind === "create") {
    const parent = documentTitle?.(proposal.parentId) || proposal.parentTitle;
    return <>
      <p className="agent-proposal-what">New document <strong>{`“${proposal.title}”`}</strong>{proposal.parentId !== currentDocumentId && parent ? ` under “${parent}”` : ""}</p>
      {proposal.content.trim() ? <p className="agent-proposal-text is-added">{preview(proposal.content)}</p> : null}
    </>;
  }
  const title = documentTitle?.(proposal.documentId) || proposal.documentTitle;
  const where = proposal.documentId === currentDocumentId ? "this document"
    : onOpen ? <button type="button" className="agent-proposal-link" onClick={() => onOpen(proposal.documentId)}>{`“${title || "Untitled document"}”`}</button>
    : `“${title || "Untitled document"}”`;
  return <>
    <p className="agent-proposal-what">{!proposal.find ? "Add to the end of " : !proposal.replace.trim() ? "Delete from " : "Edit "}{where}</p>
    {proposal.find ? <p className="agent-proposal-text is-removed">{preview(proposal.find)}</p> : null}
    {proposal.replace.trim() ? <p className="agent-proposal-text is-added">{preview(proposal.replace)}</p> : null}
  </>;
}

/**
 * Shown under an agent's reply in a document: a way to answer the question the run stopped with, and
 * the changes it proposed, each with Approve and Dismiss. Nothing changes until the reader approves.
 */
export default function AgentFollowUp({ agent, asking, disabled, currentDocumentId, documentTitle, onAnswer, onProposal, onOpen }: {
  agent: AgentRunRecord;
  /** Whether the run's question is still open: it is the document's latest reply. */
  asking: boolean;
  disabled: boolean;
  currentDocumentId: string;
  documentTitle?: (id: string) => string | undefined;
  onAnswer: (answer: string) => void;
  onProposal: (proposalId: string, action: AgentProposalAction) => string | null;
  onOpen?: (id: string) => void;
}) {
  const [errors, setErrors] = useState<Record<string, string>>({});
  const proposals = agent.proposals ?? [];
  const pending = proposals.filter((proposal) => !proposal.status);
  const act = (proposalId: string, action: AgentProposalAction) => {
    const error = onProposal(proposalId, action);
    setErrors((current) => {
      const { [proposalId]: _previous, ...rest } = current;
      return error ? { ...rest, [proposalId]: error } : rest;
    });
  };
  return <div className="agent-follow-up" contentEditable={false}>
    {asking && agent.question ? <AgentQuestionAnswer options={agent.question.options} disabled={disabled} onAnswer={onAnswer}/> : null}
    {proposals.length ? <section className="agent-proposals" aria-label="Changes the agent proposed">
      <header>
        <strong>{proposals.length === 1 ? "Proposed change" : `${proposals.length} proposed changes`}</strong>
        {pending.length > 1 ? <button type="button" disabled={disabled} onClick={() => pending.forEach((proposal) => act(proposal.id, "approve"))}>Approve all</button> : null}
      </header>
      <ol>{proposals.map((proposal) => <li key={proposal.id} className={proposal.status ? `is-${proposal.status}` : undefined}>
        {proposal.summary ? <p className="agent-proposal-summary">{proposal.summary}</p> : null}
        <ProposalBody proposal={proposal} documentTitle={documentTitle} currentDocumentId={currentDocumentId} onOpen={onOpen}/>
        <div className="agent-proposal-actions">
          {!proposal.status ? <>
            <button type="button" disabled={disabled} onClick={() => act(proposal.id, "approve")}>Approve</button>
            <button type="button" disabled={disabled} onClick={() => act(proposal.id, "dismiss")}>Dismiss</button>
          </> : <>
            <span className="agent-proposal-status" role="status">{proposal.status === "approved" ? "Approved" : "Dismissed"}</span>
            {canUndoProposal(proposal) ? <button type="button" disabled={disabled} onClick={() => act(proposal.id, "undo")}>Undo</button> : null}
            {proposal.kind === "create" && proposal.createdId && onOpen ? <button type="button" onClick={() => onOpen(proposal.createdId!)}>Open</button> : null}
          </>}
        </div>
        {errors[proposal.id] ? <p className="agent-proposal-error" role="alert">{errors[proposal.id]}</p> : null}
      </li>)}</ol>
    </section> : null}
  </div>;
}
