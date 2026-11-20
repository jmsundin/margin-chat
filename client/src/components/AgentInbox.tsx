import { useEffect, useState } from "react";
import { STOPPED_LABELS, proposalAction, type AgentInboxItem, type AgentReceipt } from "../lib/agentInbox";
import { formatUsageMicros } from "../lib/aiPresets";
import "./AgentInbox.css";

interface Props {
  items: AgentInboxItem[];
  /** Opens the document the item is on, where a question is answered and a draft is shown in full. */
  onOpen: (conversationId: string) => void;
  /** Approves or dismisses a draft; returns why it couldn't, or null. */
  onProposal: (item: Extract<AgentInboxItem, { kind: "proposal" }>, action: "approve" | "dismiss") => string | null;
  /** Clears a stopped-run notice. */
  onClear: (id: string) => void;
  onClose: () => void;
}

function receiptLine(receipt: AgentReceipt): string {
  const parts = [receipt.model, `${receipt.steps} step${receipt.steps === 1 ? "" : "s"}`];
  if (receipt.spentMicros !== undefined) parts.push(receipt.budgetMicros ? `${formatUsageMicros(receipt.spentMicros)} of ${formatUsageMicros(receipt.budgetMicros)}` : formatUsageMicros(receipt.spentMicros));
  return parts.join(" · ");
}

function when(at: string): string {
  const date = new Date(at);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

/** Everything an agent is waiting on the person for, across all documents. */
export default function AgentInbox({ items, onOpen, onProposal, onClear, onClose }: Props) {
  const [errors, setErrors] = useState<Record<string, string>>({});
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); onClose(); } };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  function decide(item: Extract<AgentInboxItem, { kind: "proposal" }>, action: "approve" | "dismiss") {
    const error = onProposal(item, action);
    setErrors((current) => { const { [item.id]: _removed, ...rest } = current; return error ? { ...rest, [item.id]: error } : rest; });
  }

  return <div className="agent-inbox-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="agent-inbox" role="dialog" aria-modal="true" aria-labelledby="agent-inbox-title">
      <header className="agent-inbox-head">
        <h2 id="agent-inbox-title">Agent inbox</h2>
        <span className="agent-inbox-count">{items.length ? `${items.length} waiting for you` : ""}</span>
        <button type="button" className="agent-inbox-close" aria-label="Close agent inbox" onClick={onClose}>×</button>
      </header>
      {items.length ? <ol className="agent-inbox-list">
        {items.map((item) => <li key={item.id} className="agent-inbox-item">
          <div className="agent-inbox-item-head">
            <span className={`agent-inbox-kind is-${item.kind}`}>{item.kind === "question" ? "Question" : item.kind === "proposal" ? "Draft to approve" : "Stopped early"}</span>
            <button type="button" className="agent-inbox-doc" onClick={() => onOpen(item.conversationId)} title="Open this document">{item.title}</button>
            <time dateTime={item.at}>{when(item.at)}</time>
          </div>
          {item.kind === "question" ? <>
            <p className="agent-inbox-text">{item.text}</p>
            {item.options.length ? <p className="agent-inbox-options">Suggested answers: {item.options.join(" · ")}</p> : null}
            <div className="agent-inbox-actions"><button type="button" className="is-primary" onClick={() => onOpen(item.conversationId)}>Open to answer</button></div>
          </> : item.kind === "proposal" ? <>
            <p className="agent-inbox-text"><strong>{proposalAction(item.proposal)}</strong>{item.proposal.summary ? `: ${item.proposal.summary}` : ""}</p>
            <div className="agent-inbox-actions">
              <button type="button" className="is-primary" onClick={() => decide(item, "approve")}>Approve</button>
              <button type="button" onClick={() => decide(item, "dismiss")}>Dismiss</button>
              <button type="button" onClick={() => onOpen(item.conversationId)}>See the draft</button>
            </div>
            {errors[item.id] ? <p className="agent-inbox-error" role="alert">{errors[item.id]}</p> : null}
          </> : <>
            <p className="agent-inbox-text">{STOPPED_LABELS[item.reason]}. What it found so far is in the document.</p>
            <div className="agent-inbox-actions">
              <button type="button" className="is-primary" onClick={() => onOpen(item.conversationId)}>Open</button>
              <button type="button" onClick={() => onClear(item.id)}>Clear</button>
            </div>
          </>}
          <p className="agent-inbox-receipt">{receiptLine(item.receipt)}</p>
        </li>)}
      </ol> : <p className="agent-inbox-empty">Nothing is waiting for you. Questions an agent asks, changes it drafts for your approval, and runs that stop early are listed here.</p>}
    </section>
  </div>;
}
