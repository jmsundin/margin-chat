import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { Conversation, DocumentDockNode, DocumentDockPosition } from "../types";
import { filterDocumentDock, getDocumentDockDropEdge, listPinnedDocumentIds, MAX_DOCK_SPLIT_RATIO, MIN_DOCK_SPLIT_RATIO, movePinnedDocument, resizeDocumentDockSplit, type DocumentDockEdge } from "../lib/documentDock";
import { useOutsideDismiss } from "../lib/useOutsideDismiss";
import "./DocumentDock.css";

interface DocumentDockProps {
  tree: DocumentDockNode | null;
  conversations: Record<string, Conversation>;
  activeDocumentId: string;
  visibleDocumentIds?: string[];
  onSelect: (documentId: string) => void;
  onUnpin: (documentId: string) => void;
  onToggleScope?: (documentId: string) => void;
  dockPosition?: DocumentDockPosition;
  onMoveDock?: (position: DocumentDockPosition) => void;
  onChange: (tree: DocumentDockNode | null) => void;
  renderDocument: (conversation: Conversation) => ReactNode;
}

type DropTarget = { kind: "pane"; documentId: string; edge: DocumentDockEdge }
  | { kind: "workspace"; edge: DocumentDockPosition };
type Interaction = {
  kind: "drag";
  pointerId: number;
  documentId: string;
  startX: number;
  startY: number;
  moved: boolean;
  target: DropTarget | null;
} | {
  kind: "resize";
  pointerId: number;
  splitId: string;
  direction: "horizontal" | "vertical";
  bounds: DOMRect;
  ratio: number;
};

const placementLabels: Record<DocumentDockEdge, string> = { left: "left", right: "right", top: "above", bottom: "below" };

function MovePaneControls({ documentId, conversations, ids, trigger, onMove, onClose, dockPosition, onMoveDock }: {
  documentId: string;
  conversations: Record<string, Conversation>;
  ids: string[];
  trigger: HTMLButtonElement | null;
  onMove: (target: string, edge: DocumentDockEdge) => void;
  onClose: () => void;
  dockPosition: DocumentDockPosition;
  onMoveDock?: (position: DocumentDockPosition) => void;
}) {
  const popupRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef(trigger);
  triggerRef.current = trigger;
  const selectRef = useRef<HTMLSelectElement>(null);
  const available = ids.filter((id) => id !== documentId && conversations[id]);
  const [target, setTarget] = useState(available[0] ?? "");
  const currentTarget = available.includes(target) ? target : available[0] ?? "";
  useOutsideDismiss(true, onClose, popupRef, triggerRef);
  useEffect(() => { (selectRef.current ?? popupRef.current?.querySelector<HTMLButtonElement>(".document-dock-move-actions button"))?.focus(); }, []);
  return <div className="document-dock-move" ref={popupRef} role="dialog" aria-label="Move pinned document" onPointerDown={(event) => event.stopPropagation()} onKeyDown={(event) => {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onClose(); }
  }}>
    <div className="document-dock-move-heading"><strong>Move pane</strong><button type="button" aria-label="Close move pane controls" onClick={onClose}>×</button></div>
    {available.length ? <>
      <label>Place beside<select aria-label="Destination pane" ref={selectRef} value={currentTarget} onChange={(event) => setTarget(event.target.value)}>
        {available.map((id) => <option key={id} value={id}>{conversations[id].title || "Untitled document"}</option>)}
      </select></label>
      <div className="document-dock-move-actions">
        {(["left", "right", "top", "bottom"] as DocumentDockEdge[]).map((edge) => <button type="button" key={edge} onClick={() => onMove(currentTarget, edge)}>Move {placementLabels[edge]}</button>)}
      </div>
    </> : onMoveDock ? <>
      <p>Position in workspace</p>
      <div className="document-dock-move-actions">
        {(["left", "right", "top", "bottom"] as const).map((position) => <button type="button" key={position}
          aria-label={`Move pinned document to ${position}`} aria-pressed={dockPosition === position}
          onClick={() => onMoveDock(position)}>{position[0].toUpperCase() + position.slice(1)}</button>)}
      </div>
    </> : <p>Pin another document to arrange panes beside one another.</p>}
  </div>;
}

/** The dock owns pointer previews; only completed gestures persist a new tree. */
export default function DocumentDock(props: DocumentDockProps) {
  const dockRef = useRef<HTMLDivElement>(null);
  const moveButtonsRef = useRef(new Map<string, HTMLButtonElement>());
  const focusAfterMoveRef = useRef<string | null>(null);
  const scrollPositionsRef = useRef(new Map<string, number>());
  const latestProps = useRef(props);
  latestProps.current = props;
  const interactionRef = useRef<Interaction | null>(null);
  const suppressMoveClick = useRef(false);
  const [interaction, setInteraction] = useState<Interaction | null>(null);
  const [moveControls, setMoveControls] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const visibleIds = props.visibleDocumentIds ? new Set(props.visibleDocumentIds) : null;
  const renderTree = filterDocumentDock(props.tree, (id) => Boolean(props.conversations[id]) && (!visibleIds || visibleIds.has(id)));
  const ids = listPinnedDocumentIds(renderTree);
  // Contracts normalization may recreate tree objects while editing. Restore
  // scroll only when the layout changes, so typing can scroll the caret normally.
  const layoutKey = JSON.stringify(renderTree);

  function captureScrollPositions() {
    dockRef.current?.querySelectorAll<HTMLElement>("[data-dock-document-id]").forEach((pane) => {
      const body = pane.querySelector<HTMLElement>(".document-body");
      if (body && pane.dataset.dockDocumentId) scrollPositionsRef.current.set(pane.dataset.dockDocumentId, body.scrollTop);
    });
  }

  function commitTree(next: DocumentDockNode | null) {
    captureScrollPositions();
    latestProps.current.onChange(next);
  }

  useLayoutEffect(() => {
    dockRef.current?.querySelectorAll<HTMLElement>("[data-dock-document-id]").forEach((pane) => {
      const body = pane.querySelector<HTMLElement>(".document-body");
      const position = scrollPositionsRef.current.get(pane.dataset.dockDocumentId ?? "");
      if (body && position !== undefined) body.scrollTop = position;
    });
  }, [layoutKey, props.dockPosition]);

  function updateInteraction(next: Interaction | null) {
    interactionRef.current = next;
    setInteraction(next);
  }

  function move(documentId: string, targetId: string, edge: DocumentDockEdge) {
    const current = latestProps.current;
    const next = movePinnedDocument(current.tree, documentId, targetId, edge);
    if (next !== current.tree) {
      focusAfterMoveRef.current = documentId;
      commitTree(next);
      setAnnouncement(`${current.conversations[documentId]?.title || "Document"} moved ${placementLabels[edge]} ${current.conversations[targetId]?.title || "document"}.`);
    }
    setMoveControls(null);
  }

  function moveDock(position: DocumentDockPosition, documentId: string) {
    captureScrollPositions();
    latestProps.current.onMoveDock?.(position);
    setMoveControls(null);
    moveButtonsRef.current.get(documentId)?.focus({ preventScroll: true });
    setAnnouncement(`Pinned document moved to the ${position} of the workspace.`);
  }

  useEffect(() => {
    const documentId = focusAfterMoveRef.current;
    if (!documentId) return;
    moveButtonsRef.current.get(documentId)?.focus();
    focusAfterMoveRef.current = null;
  }, [props.tree]);

  useEffect(() => {
    function updatePointer(event: PointerEvent) {
      const current = interactionRef.current;
      if (!current || current.pointerId !== event.pointerId) return;
      if (current.kind === "resize") {
        const size = current.direction === "horizontal" ? current.bounds.width : current.bounds.height;
        const offset = current.direction === "horizontal" ? event.clientX - current.bounds.left : event.clientY - current.bounds.top;
        const ratio = Math.min(MAX_DOCK_SPLIT_RATIO, Math.max(MIN_DOCK_SPLIT_RATIO, offset / Math.max(size, 1)));
        updateInteraction({ ...current, ratio });
        event.preventDefault();
        return;
      }
      const moved = current.moved || Math.hypot(event.clientX - current.startX, event.clientY - current.startY) > 5;
      if (!moved) return;
      if (!current.moved) setMoveControls(null);
      const props = latestProps.current;
      const visible = filterDocumentDock(props.tree, (id) => Boolean(props.conversations[id]) && (!props.visibleDocumentIds || props.visibleDocumentIds.includes(id)));
      if (props.onMoveDock && listPinnedDocumentIds(visible).length === 1) {
        const bounds = dockRef.current?.closest(".document-workspace-layout")?.getBoundingClientRect();
        const inside = bounds && bounds.width > 0 && bounds.height > 0 && event.clientX >= bounds.left && event.clientX <= bounds.right && event.clientY >= bounds.top && event.clientY <= bounds.bottom;
        const target: DropTarget | null = inside ? { kind: "workspace", edge: getDocumentDockDropEdge(bounds, event.clientX, event.clientY) } : null;
        suppressMoveClick.current = true;
        updateInteraction({ ...current, moved: true, target });
        event.preventDefault();
        return;
      }
      const element = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>("[data-dock-document-id]");
      const targetId = element?.dataset.dockDocumentId;
      const target: DropTarget | null = element && dockRef.current?.contains(element) && targetId && targetId !== current.documentId
        ? { kind: "pane", documentId: targetId, edge: getDocumentDockDropEdge(element.getBoundingClientRect(), event.clientX, event.clientY) } : null;
      suppressMoveClick.current = true;
      updateInteraction({ ...current, moved: true, target });
      event.preventDefault();
    }
    function finishPointer(event: PointerEvent) {
      updatePointer(event);
      const current = interactionRef.current;
      if (!current || current.pointerId !== event.pointerId) return;
      if (current.kind === "resize") {
        const original = latestProps.current.tree;
        const next = resizeDocumentDockSplit(original, current.splitId, current.ratio);
        if (next !== original) commitTree(next);
      } else if (current.moved && current.target) {
        if (current.target.kind === "workspace") moveDock(current.target.edge, current.documentId);
        else move(current.documentId, current.target.documentId, current.target.edge);
      }
      updateInteraction(null);
    }
    function cancelPointer(event: PointerEvent) {
      if (interactionRef.current?.pointerId === event.pointerId) updateInteraction(null);
    }
    function cancelKey(event: KeyboardEvent) {
      if (event.key !== "Escape" || !interactionRef.current) return;
      updateInteraction(null);
      setAnnouncement("Pane movement canceled.");
      event.preventDefault();
      event.stopPropagation();
    }
    function cancelOnBlur() { if (interactionRef.current) updateInteraction(null); }
    window.addEventListener("pointermove", updatePointer, { passive: false });
    window.addEventListener("pointerup", finishPointer);
    window.addEventListener("pointercancel", cancelPointer);
    window.addEventListener("keydown", cancelKey, true);
    window.addEventListener("blur", cancelOnBlur);
    return () => {
      window.removeEventListener("pointermove", updatePointer);
      window.removeEventListener("pointerup", finishPointer);
      window.removeEventListener("pointercancel", cancelPointer);
      window.removeEventListener("keydown", cancelKey, true);
      window.removeEventListener("blur", cancelOnBlur);
    };
  }, []);

  function beginDrag(event: ReactPointerEvent, documentId: string) {
    if (event.button !== 0 || !event.isPrimary || (ids.length < 2 && !props.onMoveDock)) return;
    suppressMoveClick.current = false;
    updateInteraction({ kind: "drag", pointerId: event.pointerId, documentId, startX: event.clientX, startY: event.clientY, moved: false, target: null });
    try { event.currentTarget.setPointerCapture?.(event.pointerId); } catch { /* Synthetic pointer events may not have an active pointer. */ }
  }

  function beginResize(event: ReactPointerEvent, node: Extract<DocumentDockNode, { type: "split" }>) {
    if (event.button !== 0 || !event.isPrimary) return;
    const bounds = event.currentTarget.parentElement!.getBoundingClientRect();
    setMoveControls(null);
    updateInteraction({ kind: "resize", pointerId: event.pointerId, splitId: node.id, direction: node.direction, bounds, ratio: node.ratio });
    try { event.currentTarget.setPointerCapture?.(event.pointerId); } catch { /* Synthetic pointer events may not have an active pointer. */ }
    event.preventDefault();
  }

  function closeMoveControls() {
    const id = moveControls;
    setMoveControls(null);
    if (id) dockRef.current?.querySelectorAll<HTMLElement>("[data-dock-move-id]").forEach((button) => {
      if (button.dataset.dockMoveId === id) button.focus();
    });
  }

  const viewTree = interaction?.kind === "resize" ? resizeDocumentDockSplit(renderTree, interaction.splitId, interaction.ratio) : renderTree;
  function renderNode(node: DocumentDockNode): ReactNode {
    if (node.type === "split") {
      const horizontal = node.direction === "horizontal";
      return <div className={`document-dock-split is-${node.direction}`} data-dock-split-id={node.id} key={node.id} style={{ "--dock-first": `${node.ratio}fr`, "--dock-second": `${1 - node.ratio}fr` } as CSSProperties}>
        {renderNode(node.first)}
        <div className="document-dock-divider" role="separator" tabIndex={0} aria-label={horizontal ? "Resize pinned pane widths" : "Resize pinned pane heights"} aria-orientation={horizontal ? "vertical" : "horizontal"} aria-valuenow={Math.round(node.ratio * 100)} aria-valuemin={MIN_DOCK_SPLIT_RATIO * 100} aria-valuemax={MAX_DOCK_SPLIT_RATIO * 100} onPointerDown={(event) => beginResize(event, node)} onKeyDown={(event) => {
          const negative = horizontal ? "ArrowLeft" : "ArrowUp";
          const positive = horizontal ? "ArrowRight" : "ArrowDown";
          let ratio = node.ratio;
          if (event.key === negative) ratio -= event.shiftKey ? 0.1 : 0.02;
          else if (event.key === positive) ratio += event.shiftKey ? 0.1 : 0.02;
          else if (event.key === "Home") ratio = MIN_DOCK_SPLIT_RATIO;
          else if (event.key === "End") ratio = MAX_DOCK_SPLIT_RATIO;
          else return;
          event.preventDefault();
          commitTree(resizeDocumentDockSplit(props.tree, node.id, ratio));
        }} />
        {renderNode(node.second)}
      </div>;
    }
    const conversation = props.conversations[node.documentId];
    if (!conversation) return null;
    const title = conversation.title || "Untitled document";
    const target = interaction?.kind === "drag" && interaction.moved ? interaction.target : null;
    const dragging = interaction?.kind === "drag" && interaction.moved && interaction.documentId === node.documentId;
    return <section className={`document-dock-pane${props.activeDocumentId === node.documentId ? " is-active" : ""}${dragging ? " is-dragging" : ""}`} key={node.documentId} data-dock-document-id={node.documentId} aria-label={`Pinned document: ${title}`} onPointerDownCapture={() => props.onSelect(node.documentId)} onFocusCapture={() => props.onSelect(node.documentId)}>
      <header className="document-dock-pane-header" onPointerDown={(event) => {
        if (!(event.target as HTMLElement).closest("button, select, input")) beginDrag(event, node.documentId);
      }}>
        <button type="button" className="document-dock-grip" ref={(element) => { if (element) moveButtonsRef.current.set(node.documentId, element); else moveButtonsRef.current.delete(node.documentId); }} data-dock-move-id={node.documentId} title={ids.length === 1 && props.onMoveDock ? "Drag to a workspace edge, or click to choose a position" : "Drag to arrange panes, or click for placement controls"} aria-label={`Move pinned document: ${title}`} aria-expanded={moveControls === node.documentId} aria-haspopup="dialog" onPointerDown={(event) => beginDrag(event, node.documentId)} onClick={(event) => {
          if (suppressMoveClick.current && event.detail !== 0) { suppressMoveClick.current = false; return; }
          suppressMoveClick.current = false;
          setMoveControls(moveControls === node.documentId ? null : node.documentId);
        }}><svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" fill="currentColor"><circle cx="5" cy="4" r="1.2"/><circle cx="11" cy="4" r="1.2"/><circle cx="5" cy="8" r="1.2"/><circle cx="11" cy="8" r="1.2"/><circle cx="5" cy="12" r="1.2"/><circle cx="11" cy="12" r="1.2"/></svg></button>
        <span className="document-dock-pane-title" title={title}>{title}</span>
        {props.onToggleScope && <button type="button" className="document-dock-scope" aria-label={`Keep ${title} visible across documents`} aria-pressed={node.scope !== "family"} title={node.scope === "family" ? "Pinned within this document family. Click to keep visible across documents." : "Pinned across documents. Click to show only within this document family."} onClick={() => props.onToggleScope?.(node.documentId)}><svg viewBox="0 0 18 18" width="15" height="15" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.5"><circle cx="9" cy="9" r="6.5"/><ellipse cx="9" cy="9" rx="2.7" ry="6.5"/><path d="M3 6.5h12M3 11.5h12"/></svg></button>}
        <button type="button" className="document-dock-unpin" title="Return document to the scrolling workspace" aria-label={`Unpin document: ${title}`} onClick={() => props.onUnpin(node.documentId)}><svg viewBox="0 0 18 18" width="15" height="15" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="m10 2 6 6-2 1-1 4-2 1-7-7 1-2 4-1 1-2Z M7 11l-5 5 M2 2l14 14"/></svg><span>Unpin</span></button>
      </header>
      <div className="document-dock-pane-body">{props.renderDocument(conversation)}</div>
      {moveControls === node.documentId && <MovePaneControls documentId={node.documentId} conversations={props.conversations} ids={ids} trigger={moveButtonsRef.current.get(node.documentId) ?? null} onMove={(targetId, edge) => { move(node.documentId, targetId, edge); }} onClose={closeMoveControls}
        dockPosition={props.dockPosition ?? "left"} onMoveDock={props.onMoveDock ? (position) => moveDock(position, node.documentId) : undefined} />}
      {target?.kind === "pane" && target.documentId === node.documentId && <div className={`document-dock-drop is-${target.edge}`}><span>Place {placementLabels[target.edge]}</span></div>}
    </section>;
  }

  return <div ref={dockRef} className={`document-dock${interaction?.kind === "drag" && interaction.moved ? " is-arranging" : ""}${interaction?.kind === "resize" ? " is-resizing" : ""}`} aria-label="Pinned documents" onScrollCapture={(event) => {
    const body = event.target;
    if (!(body instanceof HTMLElement) || !body.classList.contains("document-body")) return;
    const documentId = body.closest<HTMLElement>("[data-dock-document-id]")?.dataset.dockDocumentId;
    if (documentId) scrollPositionsRef.current.set(documentId, body.scrollTop);
  }}>
    {viewTree && renderNode(viewTree)}
    {interaction?.kind === "drag" && interaction.target?.kind === "workspace" && dockRef.current?.closest(".document-workspace-layout")
      ? createPortal(<div className={`document-workspace-drop is-${interaction.target.edge}`}><span>Place pinned document {interaction.target.edge}</span></div>, dockRef.current.closest(".document-workspace-layout")!) : null}
    <span className="document-dock-announcement" role="status" aria-live="polite">{announcement}</span>
  </div>;
}
