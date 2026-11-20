import { useEffect, useState } from "react";
import { STOPPED_LABELS, proposalAction, type AgentInboxItem, type AgentReceipt } from "../lib/agentInbox";
import { formatUsageMicros } from "../lib/aiPresets";
import { describeHold, MAX_HELD_PROMPT, type HeldMessage, type HoldCondition } from "../lib/heldMessages";
import "./AgentInbox.css";

interface Props {
  items: AgentInboxItem[];
  /** Opens the document the item is on, where a question is answered and a draft is shown in full. */
  onOpen: (conversationId: string) => void;
  /** Approves or dismisses a draft; returns why it couldn't, or null. */
  onProposal: (item: Extract<AgentInboxItem, { kind: "proposal" }>, action: "approve" | "dismiss") => string | null;
  /** Clears a stopped-run notice. */
  onClear: (id: string) => void;
  /** Send when…: questions held until a condition is met. Absent where holding isn't offered. */
  held?: {
    messages: HeldMessage[];
    titleOf: (conversationId: string) => string;
    /** The open document, which a new held message is for; null when it can't be asked about. */
    target: { id: string; title: string } | null;
    /** False when this vault doesn't sync, so "when sync finishes" isn't offered. */
    canWaitForSync: boolean;
    onHold: (prompt: string, condition: HoldCondition) => void;
    onCancel: (id: string) => void;
  };
  onClose: () => void;
}

/** A datetime-local value an hour from now, in this device's time zone. */
function inAnHour(): string {
  const date = new Date(Date.now() + 60 * 60 * 1000);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
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
export default function AgentInbox({ items, onOpen, onProposal, onClear, held, onClose }: Props) {
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [prompt, setPrompt] = useState("");
  const [holdKind, setHoldKind] = useState<HoldCondition["kind"]>("idle");
  const [holdAt, setHoldAt] = useState(inAnHour);
  const holdTime = holdKind === "time" ? new Date(holdAt) : null;
  const canHold = Boolean(held?.target && prompt.trim() && (!holdTime || !Number.isNaN(holdTime.getTime())));
  function hold() {
    if (!held || !canHold) return;
    held.onHold(prompt.trim(), holdTime ? { kind: "time", at: holdTime.toISOString() } : { kind: holdKind as "idle" | "synced" });
    setPrompt("");
  }
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
      {held ? <section className="agent-inbox-held" aria-label="Send when">
        <h3>Send when…</h3>
        {held.messages.length ? <ul className="agent-inbox-list">
          {held.messages.map((message) => <li key={message.id} className="agent-inbox-item">
            <div className="agent-inbox-item-head">
              <span className="agent-inbox-kind">Held</span>
              <button type="button" className="agent-inbox-doc" onClick={() => onOpen(message.conversationId)} title="Open this document">{held.titleOf(message.conversationId)}</button>
              <span className="agent-inbox-when">{describeHold(message.condition)}</span>
            </div>
            <p className="agent-inbox-text">{message.prompt}</p>
            <div className="agent-inbox-actions"><button type="button" onClick={() => held.onCancel(message.id)}>Cancel</button></div>
          </li>)}
        </ul> : null}
        {held.target ? <form className="agent-inbox-hold" onSubmit={(event) => { event.preventDefault(); hold(); }}>
          <label htmlFor="agent-inbox-hold-prompt">Ask AI in “{held.target.title}” later</label>
          <textarea id="agent-inbox-hold-prompt" rows={2} maxLength={MAX_HELD_PROMPT} value={prompt} placeholder="What should it be asked?"
            onChange={(event) => setPrompt(event.target.value)} />
          <div className="agent-inbox-hold-row">
            <select aria-label="When to send" value={holdKind} onChange={(event) => setHoldKind(event.target.value as HoldCondition["kind"])}>
              <option value="idle">When AI finishes in this document</option>
              {held.canWaitForSync ? <option value="synced">When sync finishes</option> : null}
              <option value="time">At a time</option>
            </select>
            {holdKind === "time" ? <input type="datetime-local" aria-label="Time to send" value={holdAt} onChange={(event) => setHoldAt(event.target.value)} /> : null}
            <button type="submit" className="is-primary" disabled={!canHold}>Hold</button>
          </div>
          <p className="agent-inbox-receipt">Held messages are kept on this device and sent while Margin Chat is open. The answer opens as a side document.</p>
        </form> : <p className="agent-inbox-receipt">Open a document that AI can read to hold a question for it.</p>}
      </section> : null}
    </section>
  </div>;
}
