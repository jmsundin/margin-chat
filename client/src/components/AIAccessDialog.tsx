import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { useOutsideDismiss } from "../lib/useOutsideDismiss";
import "./AIAccessDialog.css";

/**
 * Shown the first time an account with no credit, plan or key asks for hosted AI:
 * the three ways to turn it on, instead of an error inside Settings → Billing.
 */
export default function AIAccessDialog({ message, submitting, onUseOwnKey, onAddMoney, onSubscribe, onClose }: {
  message: string | null;
  submitting: boolean;
  onUseOwnKey: () => void;
  onAddMoney: () => void;
  onSubscribe: () => void;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const firstRef = useRef<HTMLButtonElement>(null);
  useOutsideDismiss(true, onClose, dialogRef);
  useEffect(() => { firstRef.current?.focus(); }, []);
  return createPortal(<div className="ai-access-backdrop" onWheel={(event) => event.stopPropagation()}>
    <div ref={dialogRef} className="ai-access-dialog" role="dialog" aria-modal="true" aria-labelledby="ai-access-title"
      onKeyDown={(event) => { event.stopPropagation(); if (event.key === "Escape") { event.preventDefault(); onClose(); } }}>
      <header>
        <strong id="ai-access-title">Turn on AI</strong>
        <button type="button" className="ai-access-close" aria-label="Close" onClick={onClose}>×</button>
      </header>
      <p>Writing, notes, side documents, the Map and Wikipedia search are free. AI answers need one of these:</p>
      <div className="ai-access-options">
        <button ref={firstRef} type="button" className="ai-access-option" onClick={onUseOwnKey}>
          <strong>Use your own API key</strong>
          <span>Free here. Paste a key from OpenAI, Anthropic, Google or another provider, and they bill you directly.</span>
        </button>
        <button type="button" className="ai-access-option" disabled={submitting} onClick={onAddMoney}>
          <strong>Add $5 of credit</strong>
          <span>Pay as you go. A short question usually costs a cent or two.</span>
        </button>
        <button type="button" className="ai-access-option is-featured" disabled={submitting} onClick={onSubscribe}>
          <strong>Plus, $20 a month</strong>
          <span>$20 of AI credit every month, plus the cloud vault on every device.</span>
        </button>
      </div>
      {message ? <p className="ai-access-message" role="status">{message}</p> : null}
    </div>
  </div>, document.body);
}
