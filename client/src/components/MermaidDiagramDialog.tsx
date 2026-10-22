import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import mermaid from "mermaid";
import { MermaidWysiwyg } from "@visimer/react";
import { getDocumentMermaidTheme, getMermaidConfig } from "../lib/mermaidDiagrams";
import "./MermaidDiagramDialog.css";

/**
 * Edits a Mermaid diagram by hand on the drawing (Visimer) or as text beside it.
 * Both stay in sync: each change on the drawing rewrites only the lines it touches.
 */
export function MermaidDiagramDialog({ source, error, onSave, onClose }: {
  source: string; error?: string; onSave: (source: string) => void; onClose: () => void;
}) {
  const [code, setCode] = useState(source);
  const [view, setView] = useState<"both" | "drawing" | "text">("both");
  const dialogRef = useRef<HTMLDivElement>(null);
  const config = useMemo(() => {
    const { deterministicIds: _ids, deterministicIDSeed: _seed, ...rest } = getMermaidConfig(getDocumentMermaidTheme());
    return rest as Record<string, unknown>;
  }, []);
  const accent = useMemo(() => getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || undefined, []);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialogRef.current?.querySelector<HTMLElement>(".mermaid-diagram-canvas")?.focus({ preventScroll: true });
    return () => { if (previous?.isConnected) previous.focus({ preventScroll: true }); };
  }, []);
  const changed = code !== source;
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
          <button type="button" onClick={onClose}>Cancel</button>
          <button type="button" className="mermaid-diagram-save" disabled={!changed} onClick={() => onSave(code)}>Save diagram</button>
        </div>
      </header>
      {error && <p className="mermaid-diagram-error" role="alert">{error}</p>}
      <div className="mermaid-diagram-body">
        <section className="mermaid-diagram-drawing" aria-label="Drawing">
          <MermaidWysiwyg className="mermaid-diagram-canvas" code={code} onCodeChange={setCode} mermaid={mermaid} mermaidConfig={config} panZoom accentColor={accent} />
          <p className="mermaid-diagram-hint">Double-click a label to rename it. Click a shape for more. Select and press Delete to remove.</p>
        </section>
        <textarea className="mermaid-diagram-text" aria-label="Mermaid text" spellCheck={false} value={code} onChange={(event) => setCode(event.target.value)} />
      </div>
    </div>
  </div>, document.body);
}

export default MermaidDiagramDialog;
