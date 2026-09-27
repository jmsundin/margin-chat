import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Excalidraw, exportToSvg, serializeAsJSON } from "@excalidraw/excalidraw";
import type { ExcalidrawInitialDataState } from "@excalidraw/excalidraw/types";
import { drawingMarkdown, readDrawing } from "../lib/documentDrawing";
import "@excalidraw/excalidraw/index.css";
import "./DocumentDrawing.css";

Object.assign(window, { EXCALIDRAW_ASSET_PATH: "/excalidraw/" });

export function DrawingDialog({ markdown, error, onSave, onClose }: {
  markdown: string; error?: string; onSave: (markdown: string) => void; onClose: () => void;
}) {
  const initial = useMemo(() => ({ ...readDrawing(markdown), scrollToContent: true }), [markdown]);
  const pending = useRef(markdown);
  const dialogRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialogRef.current?.querySelector<HTMLButtonElement>(".document-drawing-save")?.focus();
    return () => { if (previous?.isConnected) previous.focus({ preventScroll: true }); };
  }, []);
  return createPortal(<div className="document-drawing-backdrop">
    <div ref={dialogRef} className="document-drawing-dialog" role="dialog" aria-modal="true" aria-label="Edit drawing" onKeyDown={(event) => {
      event.stopPropagation();
      if (event.key !== "Tab") return;
      const items = [...event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea, select, [tabindex="0"]')].filter((item) => item.getClientRects().length);
      const first = items[0], last = items.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }}>
      <header><strong>Drawing</strong><div><button type="button" onClick={onClose}>Cancel</button><button type="button" className="document-drawing-save" onClick={() => onSave(pending.current)}>Save drawing</button></div></header>
      {error && <p role="alert">{error}</p>}
      <div className="document-drawing-canvas"><Excalidraw initialData={initial} handleKeyboardGlobally={false}
        onChange={(elements, appState, files) => { pending.current = drawingMarkdown(serializeAsJSON(elements, appState, files, "local")); }}
        UIOptions={{ canvasActions: { loadScene: true, saveToActiveFile: false, export: false, toggleTheme: true } }}
      /></div>
    </div>
  </div>, document.body);
}

export default function DocumentDrawing({ markdown, readOnly, onEdit }: { markdown: string; readOnly: boolean; onEdit: () => void }) {
  const [preview, setPreview] = useState("");
  const [error, setError] = useState("");
  const [empty, setEmpty] = useState(false);
  useEffect(() => {
    let active = true;
    let drawing: ExcalidrawInitialDataState;
    setError("");
    try { drawing = readDrawing(markdown); }
    catch (error) { setError(error instanceof Error ? error.message : "The drawing could not be opened."); return; }
    const elements = (drawing.elements ?? []).filter((element) => !element.isDeleted);
    setEmpty(!elements.length);
    if (!elements.length) { setPreview(""); return; }
    void exportToSvg({ elements, appState: { ...drawing.appState, exportBackground: true }, files: drawing.files ?? {} })
      .then((svg: SVGSVGElement) => { if (active) setPreview(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg.outerHTML)}`); })
      .catch(() => { if (active) setError("The drawing preview could not be rendered. Open the drawing to edit it."); });
    return () => { active = false; };
  }, [markdown]);
  return <figure className="document-drawing" aria-label="Excalidraw drawing">
    {preview && !error ? <img src={preview} alt="Document drawing" onDoubleClick={readOnly ? undefined : onEdit} /> : <p>{error || (empty ? "Empty drawing" : "Loading drawing…")}</p>}
    <figcaption><span>Excalidraw</span><button type="button" disabled={readOnly} onClick={onEdit}>Edit drawing</button></figcaption>
  </figure>;
}
