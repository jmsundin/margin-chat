import { useState } from "react";
import type { Conversation } from "../types";
import { getDocumentPreview } from "../lib/documentSources";
import "./DocumentChildTabs.css";

interface Props {
  parent: Conversation;
  documents: Conversation[];
  currentDocumentId: string;
  minimizedDocumentIds: string[];
  openDocumentIds?: string[];
  onSelect: (id: string) => void;
}

const COLLAPSED_KEY = "margin-chat:child-tabs-collapsed";

/** An explicit choice wins; otherwise phones start collapsed so the document keeps its width. */
function readCollapsed(): boolean {
  let saved: string | null = null;
  try { saved = window.localStorage.getItem(COLLAPSED_KEY); } catch { /* Fall back to the screen width. */ }
  return saved === null ? window.innerWidth < 640 : saved === "1";
}

/** Vertical tabs on the right of a document's body: one tab per child, in saved order. */
export default function DocumentChildTabs({ parent, documents, currentDocumentId, minimizedDocumentIds, openDocumentIds = [], onSelect }: Props) {
  const [collapsed, setCollapsed] = useState(readCollapsed);
  if (!documents.length) return null;
  const parentTitle = parent.title || "Untitled document";

  function toggle() {
    const next = !collapsed;
    setCollapsed(next);
    try { window.localStorage.setItem(COLLAPSED_KEY, next ? "1" : "0"); } catch { /* Collapsing still works for this session. */ }
  }

  return <nav className={`document-child-tabs${collapsed ? " is-collapsed" : ""}`} aria-label={`Child documents of ${parentTitle}`}>
    <button type="button" className="document-child-tabs-toggle" aria-expanded={!collapsed}
      aria-label={`${collapsed ? "Show" : "Hide"} children of ${parentTitle} (${documents.length})`}
      title={collapsed ? "Show child documents" : "Hide child documents"} onClick={toggle}>
      {collapsed ? null : <span className="document-child-tabs-label">Children</span>}
      <span className="document-child-count">{documents.length}</span>
      <span aria-hidden="true" className="document-child-tabs-chevron">{collapsed ? "‹" : "›"}</span>
    </button>
    {collapsed ? null : <div className="document-child-tabs-list" onKeyDown={(event) => {
      if (!["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
      const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button")];
      const index = buttons.indexOf(window.document.activeElement as HTMLButtonElement);
      if (index < 0) return;
      event.preventDefault(); event.stopPropagation();
      const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1
        : (index + (event.key === "ArrowDown" ? 1 : buttons.length - 1)) % buttons.length;
      buttons[next]?.focus(); buttons[next]?.scrollIntoView?.({ block: "nearest" });
    }}>
      {documents.map((document) => {
        const status = openDocumentIds.includes(document.id) ? "open" : minimizedDocumentIds.includes(document.id) ? "minimized" : "closed";
        const title = document.title || "Untitled document";
        return <button type="button" key={document.id} className={`document-child-tab is-${status}`}
          aria-current={document.id === currentDocumentId ? "page" : undefined}
          title={`${title}\n${getDocumentPreview(document)}`}
          onClick={() => onSelect(document.id)}>
          <span className="document-child-title">{title}</span>
          <small>{status === "open" ? "Open" : status === "minimized" ? "Minimized" : "Not open"}</small>
        </button>;
      })}
    </div>}
  </nav>;
}
