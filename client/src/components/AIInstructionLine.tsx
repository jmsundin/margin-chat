import { useEffect, useId, useRef, useState } from "react";
import "./AIInstructionLine.css";

const MAX_LENGTH = 400;

export interface AIInstructionLineProps {
  /** This document's own instruction. */
  value?: string;
  /** An instruction this document follows from a parent, when it has none of its own. */
  inherited?: { text: string; from: string } | null;
  onChange: (value: string | null) => void;
  /** On the quiet page's row above the text: just "Tell the AI" until there's something to show. */
  compact?: boolean;
}

/** Ways people often steer the AI in a note; picking one puts it in the box to keep or change. */
export const AI_INSTRUCTION_SUGGESTIONS = [
  "Question my claims and point out what I'm missing",
  "Be a sharp sceptic: disagree with my premise",
  "Only give hints, never the full answer",
  "Explain things as if I'm new to this",
  "Keep it short and say where the evidence is thin",
];

/**
 * One quiet line under the header: what the user wants the AI to keep in mind in this
 * document ("Tell the AI: be blunt about weak evidence"). Ask AI here and in the
 * document's margin notes sends it. Click to edit; Enter saves, Escape cancels.
 */
export default function AIInstructionLine({ value, inherited, onChange, compact = false }: AIInstructionLineProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value ?? "");
  const inputRef = useRef<HTMLInputElement>(null);
  const id = useId();
  /** Escape closes without saving, even if the input's blur fires as it goes. */
  const cancelled = useRef(false);
  useEffect(() => { if (!editing) setDraft(value ?? ""); }, [value, editing]);
  useEffect(() => { if (editing) inputRef.current?.focus(); }, [editing]);

  function save() {
    setEditing(false);
    if (cancelled.current) { cancelled.current = false; return; }
    const text = draft.replace(/\s+/gu, " ").trim();
    if (text !== (value ?? "")) onChange(text || null);
  }

  if (editing) {
    return <div className={`ai-instruction-line is-editing${compact ? " is-compact" : ""}`}>
      <label className="ai-instruction-label" htmlFor={`${id}-input`}>Tell the AI</label>
      <input id={`${id}-input`} ref={inputRef} className="ai-instruction-input" value={draft} maxLength={MAX_LENGTH}
        placeholder={inherited ? inherited.text : "e.g. Question my claims and point out what I'm missing"}
        aria-describedby={`${id}-hint`}
        onChange={(event) => setDraft(event.target.value)} onBlur={save}
        onKeyDown={(event) => {
          if (event.key === "Enter") { event.preventDefault(); save(); }
          else if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); cancelled.current = true; setDraft(value ?? ""); setEditing(false); }
        }} />
      <div className="ai-instruction-suggestions" role="group" aria-label="Suggestions" onMouseDown={(event) => event.preventDefault()}>
        {AI_INSTRUCTION_SUGGESTIONS.map((suggestion) => <button key={suggestion} type="button" className="ai-instruction-suggestion"
          aria-pressed={draft === suggestion} title="Put this in the box; Enter saves it"
          onClick={() => { setDraft(suggestion); requestAnimationFrame(() => { inputRef.current?.focus(); inputRef.current?.setSelectionRange(suggestion.length, suggestion.length); }); }}>
          {suggestion}
        </button>)}
      </div>
      <span id={`${id}-hint`} className="ai-instruction-hint">Sent with every Ask AI in this document and its notes. Enter saves.</span>
    </div>;
  }

  const text = value || inherited?.text;
  return <div className={`ai-instruction-line${text ? "" : " is-empty"}${compact ? " is-compact" : ""}`}>
    <button type="button" className="ai-instruction-button" onClick={() => { cancelled.current = false; setEditing(true); }}
      title={text ? "Change what the AI keeps in mind in this document" : "Tell the AI how to think with you in this document"}>
      {compact ? <PenIcon /> : null}<span className="ai-instruction-label">Tell the AI</span>
      {text ? <span className="ai-instruction-text">{text}</span> : compact ? null : <span className="ai-instruction-placeholder">how to think with you here…</span>}
      {!value && inherited ? <span className="ai-instruction-from">from {inherited.from}</span> : null}
    </button>
  </div>;
}

function PenIcon() {
  return <svg className="ai-instruction-pen" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M2.5 13.5l.8-3 7.4-7.4 2.2 2.2-7.4 7.4z" /><path d="M9.5 4.3l2.2 2.2" />
  </svg>;
}
