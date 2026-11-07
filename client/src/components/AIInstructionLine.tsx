import { useEffect, useId, useRef, useState } from "react";
import "./AIInstructionLine.css";

const MAX_LENGTH = 400;

export interface AIInstructionLineProps {
  /** This document's own instruction. */
  value?: string;
  /** An instruction this document follows from a parent, when it has none of its own. */
  inherited?: { text: string; from: string } | null;
  onChange: (value: string | null) => void;
}

/**
 * One quiet line under the header: what the user wants the AI to keep in mind in this
 * document ("Tell the AI: be blunt about weak evidence"). Ask AI here and in the
 * document's margin notes sends it. Click to edit; Enter saves, Escape cancels.
 */
export default function AIInstructionLine({ value, inherited, onChange }: AIInstructionLineProps) {
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
    return <div className="ai-instruction-line is-editing">
      <label className="ai-instruction-label" htmlFor={`${id}-input`}>Tell the AI</label>
      <input id={`${id}-input`} ref={inputRef} className="ai-instruction-input" value={draft} maxLength={MAX_LENGTH}
        placeholder={inherited ? inherited.text : "e.g. Question my claims and point out what I'm missing"}
        aria-describedby={`${id}-hint`}
        onChange={(event) => setDraft(event.target.value)} onBlur={save}
        onKeyDown={(event) => {
          if (event.key === "Enter") { event.preventDefault(); save(); }
          else if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); cancelled.current = true; setDraft(value ?? ""); setEditing(false); }
        }} />
      <span id={`${id}-hint`} className="ai-instruction-hint">Sent with every Ask AI in this document and its notes. Enter saves.</span>
    </div>;
  }

  const text = value || inherited?.text;
  return <div className={`ai-instruction-line${text ? "" : " is-empty"}`}>
    <button type="button" className="ai-instruction-button" onClick={() => { cancelled.current = false; setEditing(true); }}
      title={text ? "Change what the AI keeps in mind in this document" : "Tell the AI how to think with you in this document"}>
      <span className="ai-instruction-label">Tell the AI</span>
      {text ? <span className="ai-instruction-text">{text}</span> : <span className="ai-instruction-placeholder">how to think with you here…</span>}
      {!value && inherited ? <span className="ai-instruction-from">from {inherited.from}</span> : null}
    </button>
  </div>;
}
