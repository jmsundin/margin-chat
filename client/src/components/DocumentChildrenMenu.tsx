import { useRef, useState } from "react";
import type { Conversation } from "../types";
import { getDocumentPreview } from "../lib/documentSources";
import { useOutsideDismiss } from "../lib/useOutsideDismiss";
import "./DocumentChildren.css";

interface Props {
  parent: Conversation;
  documents: Conversation[];
  currentDocumentId: string;
  minimizedDocumentIds: string[];
  openDocumentIds?: string[];
  /** Children shown as notes in this document's margin; listed first, marked ✦. */
  marginNoteIds?: string[];
  onSelect: (id: string) => void;
}

/** A header menu listing every child of a document: margin notes first, then the rest, in saved order. */
export default function DocumentChildrenMenu({ parent, documents, currentDocumentId, minimizedDocumentIds, openDocumentIds = [], marginNoteIds = [], onSelect }: Props) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  useOutsideDismiss(open, () => setOpen(false), menuRef, triggerRef);
  if (!documents.length) return null;
  const parentTitle = parent.title || "Untitled document";
  const notes = documents.filter((document) => marginNoteIds.includes(document.id));
  const others = documents.filter((document) => !marginNoteIds.includes(document.id));

  function renderItem(document: Conversation) {
    const note = marginNoteIds.includes(document.id);
    const status = note ? "margin" : openDocumentIds.includes(document.id) ? "open" : minimizedDocumentIds.includes(document.id) ? "minimized" : "closed";
    const title = document.title || "Untitled document";
    const quote = note ? document.branchAnchor?.quote : undefined;
    return <button type="button" key={document.id} className={`document-child-item is-${status}${note ? " is-margin-note" : ""}`}
      aria-current={document.id === currentDocumentId ? "page" : undefined}
      title={`${title}\n${getDocumentPreview(document)}`}
      onClick={() => { setOpen(false); onSelect(document.id); }}>
      <span className="document-child-title">{title}</span>
      <small>{note ? quote ? `“${quote.length > 48 ? `${quote.slice(0, 47)}…` : quote}”` : "About this document"
        : status === "open" ? "Open" : status === "minimized" ? "Minimized" : "Not open"}</small>
    </button>;
  }

  return <div className="document-children-menu">
    <button type="button" ref={triggerRef} className="document-children-trigger" aria-haspopup="true" aria-expanded={open}
      aria-label={`Children of ${parentTitle} (${documents.length})`} title="Child documents"
      onClick={() => setOpen((current) => !current)}
      onKeyDown={(event) => { if (event.key === "Escape" && open) { event.stopPropagation(); setOpen(false); } }}>
      Children <span className="document-children-count">{documents.length}</span><span aria-hidden="true" className="document-children-chevron">▾</span>
    </button>
    {open ? <div className="document-children-list" ref={menuRef} role="group" aria-label={`Child documents of ${parentTitle}`}
      onKeyDown={(event) => {
        if (event.key === "Escape") { event.stopPropagation(); setOpen(false); triggerRef.current?.focus(); return; }
        if (!["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
        const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button")];
        const index = buttons.indexOf(window.document.activeElement as HTMLButtonElement);
        event.preventDefault(); event.stopPropagation();
        const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1
          : index < 0 ? 0 : (index + (event.key === "ArrowDown" ? 1 : buttons.length - 1)) % buttons.length;
        buttons[next]?.focus(); buttons[next]?.scrollIntoView?.({ block: "nearest" });
      }}>
      {notes.length ? <>
        <div className="document-children-heading">Margin notes</div>
        {notes.map(renderItem)}
      </> : null}
      {others.length ? <>
        {notes.length ? <div className="document-children-heading">Documents</div> : null}
        {others.map(renderItem)}
      </> : null}
    </div> : null}
  </div>;
}
