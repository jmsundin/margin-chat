import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import mermaid from "mermaid";
import { MermaidWysiwyg } from "@visimer/react";
import type { DiagramAIRequest } from "../lib/documentAI";
import { getDocumentMermaidTheme, getMermaidConfig } from "../lib/mermaidDiagrams";
import "./MermaidDiagramDialog.css";

const QUICK_ASKS = [
  { label: "Simplify", prompt: "Simplify this diagram: fewer, clearer steps, same meaning." },
  { label: "Match the document", prompt: "Update this diagram so it matches what the document says now." },
];

type TextRange = { from: number; to: number };
type Ask = { range: TextRange | null; prompt: string; running: boolean; error: string | null };

/** The 1-based first and last line a range of `text` covers. */
function lineSpan(text: string, range: TextRange) {
  const first = text.slice(0, range.from).split("\n").length;
  const last = first + (text.slice(range.from, range.to).replace(/\n$/, "").match(/\n/g)?.length ?? 0);
  return { first, last };
}

/**
 * Edits a Mermaid diagram by hand on the drawing (Visimer) or as text beside it.
 * Both stay in sync: each change on the drawing rewrites only the lines it touches.
 * With `onAsk`, selecting text offers Ask AI, which rewrites the diagram in the dialog before it is saved.
 */
export function MermaidDiagramDialog({ source, error, onSave, onClose, onAsk }: {
  source: string; error?: string; onSave: (source: string) => void; onClose: () => void;
  onAsk?: (request: DiagramAIRequest) => Promise<string>;
}) {
  const [code, setCode] = useState(source);
  const [view, setView] = useState<"both" | "drawing" | "text">("both");
  const [selection, setSelection] = useState<TextRange | null>(null);
  const [ask, setAsk] = useState<Ask | null>(null);
  const [undo, setUndo] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const running = useRef<AbortController | null>(null);
  const config = useMemo(() => {
    const { deterministicIds: _ids, deterministicIDSeed: _seed, ...rest } = getMermaidConfig(getDocumentMermaidTheme());
    return rest as Record<string, unknown>;
  }, []);
  const accent = useMemo(() => getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || undefined, []);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialogRef.current?.querySelector<HTMLElement>(".mermaid-diagram-canvas")?.focus({ preventScroll: true });
    return () => { running.current?.abort(); if (previous?.isConnected) previous.focus({ preventScroll: true }); };
  }, []);
  useEffect(() => { if (ask && !ask.running) promptRef.current?.focus({ preventScroll: true }); }, [ask?.range, ask?.running, Boolean(ask)]);
  const changed = code !== source;

  function readSelection() {
    const text = textRef.current;
    if (!text) return;
    setSelection(text.selectionStart < text.selectionEnd ? { from: text.selectionStart, to: text.selectionEnd } : null);
  }
  function editCode(next: string) {
    setCode(next);
    setUndo(null);
  }
  function openAsk(range: TextRange | null) {
    setAsk({ range, prompt: "", running: false, error: null });
  }
  function closeAsk() {
    running.current?.abort();
    setAsk(null);
    textRef.current?.focus({ preventScroll: true });
  }
  async function sendAsk(prompt = ask?.prompt ?? "") {
    if (!ask || !onAsk || ask.running || !prompt.trim()) return;
    const controller = new AbortController();
    running.current = controller;
    const before = code;
    setAsk({ ...ask, prompt, running: true, error: null });
    try {
      const next = await onAsk({ prompt, diagram: before, selection: ask.range ? before.slice(ask.range.from, ask.range.to) : undefined, signal: controller.signal });
      if (controller.signal.aborted) return;
      if (next.trim() === before.trim()) {
        setAsk((current) => current && { ...current, running: false, error: "The AI sent back the same diagram. Try describing the change another way." });
        return;
      }
      setCode(next);
      setUndo(before);
      setSelection(null);
      setAsk(null);
    } catch (reason) {
      if (controller.signal.aborted) return;
      setAsk((current) => current && { ...current, running: false, error: reason instanceof Error && reason.message ? reason.message : "AI could not change the diagram. Try again." });
    } finally {
      if (running.current === controller) running.current = null;
    }
  }

  /** Where the selection bar and the prompt sit: just under the selection's last line, inside the text pane. */
  function anchorTop(range: TextRange | null) {
    const text = textRef.current;
    if (!text || !range) return undefined;
    const style = getComputedStyle(text);
    const lineHeight = parseFloat(style.lineHeight) || 20;
    const { last } = lineSpan(code, range);
    const top = text.offsetTop + parseFloat(style.paddingTop) + last * lineHeight - text.scrollTop + 6;
    return Math.max(8, Math.min(top, text.offsetTop + text.clientHeight - 56));
  }
  const span = ask?.range ? lineSpan(code, ask.range) : null;

  return createPortal(<div className="mermaid-diagram-backdrop">
    <div ref={dialogRef} className="mermaid-diagram-dialog" role="dialog" aria-modal="true" aria-label="Edit diagram" data-view={view} onKeyDown={(event) => {
      event.stopPropagation();
      if (event.key === "Escape" && !(event.target instanceof Element && event.target.closest(".mermaid-diagram-canvas"))) { event.preventDefault(); onClose(); return; }
      if (event.key !== "Tab") return;
      const items = [...event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), textarea, [tabindex="0"]')].filter((item) => item.getClientRects().length);
      const first = items[0], last = items.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }}>
      <header>
        <strong>Diagram</strong>
        <div className="mermaid-diagram-views" role="group" aria-label="Show">
          {(["drawing", "both", "text"] as const).map((candidate) => <button key={candidate} type="button" aria-pressed={view === candidate} onClick={() => setView(candidate)}>
            {candidate === "drawing" ? "Drawing" : candidate === "text" ? "Text" : "Both"}
          </button>)}
        </div>
        <div>
          {onAsk && <button type="button" className="mermaid-diagram-ask-button" aria-pressed={Boolean(ask)} onClick={() => {
            if (ask) { closeAsk(); return; }
            if (view === "drawing") setView("both");
            openAsk(selection);
          }}>✦ Ask AI</button>}
          <button type="button" onClick={onClose}>Cancel</button>
          <button type="button" className="mermaid-diagram-save" disabled={!changed} onClick={() => onSave(code)}>Save diagram</button>
        </div>
      </header>
      {error && <p className="mermaid-diagram-error" role="alert">{error}</p>}
      <div className="mermaid-diagram-body">
        <section className="mermaid-diagram-drawing" aria-label="Drawing">
          <MermaidWysiwyg className="mermaid-diagram-canvas" code={code} onCodeChange={editCode} mermaid={mermaid} mermaidConfig={config} panZoom accentColor={accent} />
          <p className="mermaid-diagram-hint">Double-click a label to rename it. Click a shape for more. Select and press Delete to remove.</p>
        </section>
        <section className="mermaid-diagram-text-pane" aria-label="Text">
          <textarea ref={textRef} className="mermaid-diagram-text" aria-label="Mermaid text" spellCheck={false} value={code}
            onChange={(event) => editCode(event.target.value)} onSelect={readSelection} onScroll={() => setSelection((current) => current && { ...current })} />
          {undo !== null && !ask && <div className="mermaid-diagram-ai-status" role="status">
            <span>✦ AI changed the diagram</span>
            <button type="button" onClick={() => { setCode(undo); setUndo(null); }}>Undo</button>
          </div>}
          {onAsk && selection && !ask && <div className="mermaid-diagram-selection-bar" role="toolbar" aria-label="Selected text" style={{ top: anchorTop(selection) }}>
            <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => openAsk(selection)}>✦ Ask AI</button>
          </div>}
          {ask && <form className="mermaid-diagram-ask" style={{ top: anchorTop(ask.range) }} aria-label="Ask AI to change the diagram"
            onSubmit={(event) => { event.preventDefault(); void sendAsk(); }}
            onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); closeAsk(); } }}>
            <label htmlFor="mermaid-diagram-ask-prompt">{span ? `✦ Change ${span.first === span.last ? `line ${span.first}` : `lines ${span.first}–${span.last}`}` : "✦ Change the diagram"}</label>
            <textarea id="mermaid-diagram-ask-prompt" ref={promptRef} rows={2} value={ask.prompt} disabled={ask.running}
              placeholder="Describe the change, like “add a step after Pack”"
              onChange={(event) => setAsk({ ...ask, prompt: event.target.value, error: null })}
              onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void sendAsk(); } }} />
            {!ask.running && <div className="mermaid-diagram-ask-chips">
              {QUICK_ASKS.map((quick) => <button key={quick.label} type="button" onClick={() => void sendAsk(quick.prompt)}>{quick.label}</button>)}
            </div>}
            {ask.error && <p role="alert">{ask.error}</p>}
            <div className="mermaid-diagram-ask-actions">
              {ask.running ? <span role="status">Changing the diagram…</span> : <span />}
              <button type="button" onClick={closeAsk}>{ask.running ? "Stop" : "Cancel"}</button>
              {!ask.running && <button type="submit" className="mermaid-diagram-save" disabled={!ask.prompt.trim()}>Change diagram</button>}
            </div>
          </form>}
        </section>
      </div>
    </div>
  </div>, document.body);
}

export default MermaidDiagramDialog;
