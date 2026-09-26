import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { renderLatexToHtml } from "../lib/latex";
import { useOutsideDismiss } from "../lib/useOutsideDismiss";
import "./MathEquation.css";

export default function MathEquationDialog({ latex: initial, display: initialDisplay, editing, error, onSave, onClose }: {
  latex: string; display: boolean; editing: boolean;
  error?: string | null;
  onSave: (latex: string, display: boolean) => void;
  onClose: () => void;
}) {
  const [latex, setLatex] = useState(initial);
  const [display, setDisplay] = useState(initialDisplay);
  const dialogRef = useRef<HTMLFormElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const preview = useMemo(() => renderLatexToHtml(latex, display), [latex, display]);
  useOutsideDismiss(true, onClose, dialogRef);
  useEffect(() => { inputRef.current?.focus(); }, []);
  return createPortal(<div className="math-equation-backdrop" onWheel={(event) => event.stopPropagation()}>
    <form ref={dialogRef} className="math-equation-dialog" role="dialog" aria-modal="true" aria-label={editing ? "Edit equation" : "Insert equation"}
      onSubmit={(event) => { event.preventDefault(); if (latex.trim()) onSave(latex, display); }}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Escape") { event.preventDefault(); onClose(); }
        if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); if (latex.trim()) onSave(latex, display); }
        if (event.key === "Tab") {
          const items = [...event.currentTarget.querySelectorAll<HTMLElement>("button:not(:disabled), textarea, select")];
          const next = items[(items.indexOf(document.activeElement as HTMLElement) + (event.shiftKey ? items.length - 1 : 1)) % items.length];
          event.preventDefault(); next?.focus();
        }
      }}>
      <header><strong>{editing ? "Edit equation" : "Insert equation"}</strong><button type="button" aria-label="Close equation editor" onClick={onClose}>×</button></header>
      <label>Equation layout<select aria-label="Equation layout" value={display ? "display" : "inline"} onChange={(event) => setDisplay(event.target.value === "display")}>
        <option value="inline">Inline (default)</option><option value="display">Display (separate line)</option>
      </select></label>
      <label>LaTeX equation<textarea ref={inputRef} aria-label="LaTeX equation" value={latex} onChange={(event) => setLatex(event.target.value)} placeholder="E = mc^2" spellCheck={false} rows={4} /></label>
      <div className="math-equation-preview" aria-label="Equation preview" dangerouslySetInnerHTML={{ __html: preview }} />
      {error && <p role="alert">{error}</p>}
      <footer><button type="button" onClick={onClose}>Cancel</button><button type="submit" disabled={!latex.trim()}>{editing ? "Save equation" : "Insert equation"}</button></footer>
    </form>
  </div>, document.body);
}
