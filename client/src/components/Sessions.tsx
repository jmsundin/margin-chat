import { useEffect, useRef, useState } from "react";
import type { Conversation, WorkspaceSession } from "../types";
import { formatRelativeTime } from "../lib/conversationSearch";
import { useOutsideDismiss } from "../lib/useOutsideDismiss";
import ViewIntro from "./ViewIntro";
import "./Sessions.css";

function countLabel(count: number) {
  return `${count} ${count === 1 ? "doc" : "docs"}`;
}

function PlusIcon() {
  return <svg className="session-icon" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"><path d="M8 3v10M3 8h10" /></svg>;
}

function RenameInput({ initial, label, onDone }: { initial: string; label: string; onDone: (name: string | null) => void }) {
  const [value, setValue] = useState(initial);
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  useEffect(() => { ref.current?.focus(); ref.current?.select(); }, []);
  function finish(name: string | null) {
    if (done.current) return;
    done.current = true;
    onDone(name);
  }
  return <input ref={ref} className="session-rename-input" aria-label={label} value={value} maxLength={120}
    placeholder="Name it, or leave empty for an automatic name"
    onChange={(event) => setValue(event.target.value)} onBlur={() => finish(value)}
    onKeyDown={(event) => {
      if (event.key === "Enter") { event.preventDefault(); finish(value); }
      else if (event.key === "Escape") { event.preventDefault(); finish(null); }
      event.stopPropagation();
    }} />;
}

interface ChipsProps {
  /** Every session, sorted like the sidebar's documents. */
  sessions: WorkspaceSession[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  /** Opens the left panel's Sessions view, where sessions are renamed and deleted. */
  onManage?: () => void;
  /** Most chips to show; the active session always gets one. */
  limit?: number;
}

/** Sessions as a row of chips: one tap switches, with no menu to open first. */
export function SessionChips({ sessions, activeId, onSelect, onNew, onManage, limit = Infinity }: ChipsProps) {
  const others = sessions.filter((session) => session.id !== activeId);
  const active = sessions.find((session) => session.id === activeId);
  const shown = active ? [active, ...others.slice(0, Math.max(0, limit - 1))] : others.slice(0, limit);
  const hidden = sessions.length - shown.length;
  const row = useRef<HTMLDivElement>(null);
  useEffect(() => { if (row.current) row.current.scrollLeft = 0; }, [activeId]);
  return <div ref={row} className="session-chips" role="group" aria-label="Sessions">
    {shown.map((session) => <button key={session.id} type="button" className="session-chip"
      aria-pressed={session.id === activeId} title={`${session.name} · ${countLabel(session.documentIds.length)}`}
      onClick={() => { if (session.id !== activeId) onSelect(session.id); }}>
      <span className="session-dot" style={{ background: session.color }} aria-hidden="true" />
      <span className="session-chip-name">{session.name}</span>
    </button>)}
    <button type="button" className="session-chip is-new" aria-label="New session" title="New session" onClick={onNew}><PlusIcon /><span className="session-chip-name">New</span></button>
    {onManage && hidden > 0 ? <button type="button" className="session-chip is-more" title="All sessions" onClick={onManage}>{hidden} more</button> : null}
  </div>;
}

interface PanelProps {
  sessions: WorkspaceSession[];
  activeId: string | null;
  conversations: Record<string, Conversation>;
  focusedDocumentId: string;
  onOpen: (id: string) => void;
  onRename: (id: string, name: string) => void;
  onDuplicate: (id: string) => void;
  onDelete: (id: string) => void;
  onNew: (name: string) => void;
  onOpenDocument: (id: string) => void;
  onRemoveDocument: (sessionId: string, documentId: string) => void;
  /** Explain what a session is, for a nearly empty vault. */
  showIntro?: boolean;
}

/** The left panel's Sessions view: every session, and the active one's documents. */
export function SessionsPanel({ sessions, activeId, conversations, focusedDocumentId, onOpen, onRename, onDuplicate, onDelete, onNew, onOpenDocument, onRemoveDocument, showIntro = false }: PanelProps) {
  const [menuId, setMenuId] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const menu = useRef<HTMLDivElement>(null);
  useOutsideDismiss(menuId !== null, () => setMenuId(null), menu);
  const active = sessions.find((session) => session.id === activeId);
  const deletingSession = sessions.find((session) => session.id === deleting);
  const activeDocuments = active ? [...active.documentIds].reverse().map((id) => conversations[id]).filter(Boolean) : [];

  function row(session: WorkspaceSession) {
    const isActive = session.id === activeId;
    return <li key={session.id} className={`session-row${isActive ? " is-active" : ""}`} data-session-row-id={session.id}>
      <span className="session-dot" style={{ background: session.color }} aria-hidden="true" />
      {renaming === session.id ? <RenameInput initial={session.nameSource === "user" ? session.name : ""} label={`Rename ${session.name}`}
        onDone={(name) => { setRenaming(null); if (name !== null) onRename(session.id, name); }} />
        : <button type="button" className="session-row-open" aria-current={isActive ? "true" : undefined} onClick={() => onOpen(session.id)}
          title={session.nameSource === "auto" ? `${session.name} (named from its documents)` : session.name}>
          <span className="session-row-name">{session.name}</span>
          <span className="session-meta">{countLabel(session.documentIds.length)}{isActive ? "" : ` · ${formatRelativeTime(session.lastOpenedAt)}`}</span>
        </button>}
      <button type="button" className="session-row-menu-trigger" aria-label={`Options for ${session.name}`} aria-haspopup="menu"
        aria-expanded={menuId === session.id} onClick={() => setMenuId((current) => current === session.id ? null : session.id)}>⋯</button>
      {menuId === session.id ? <div ref={menu} className="session-menu" role="menu" aria-label={`Options for ${session.name}`}
        onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); setMenuId(null); } }}>
        <button type="button" role="menuitem" onClick={() => { setMenuId(null); onOpen(session.id); }}>Open</button>
        <button type="button" role="menuitem" onClick={() => { setMenuId(null); setRenaming(session.id); }}>Rename</button>
        <button type="button" role="menuitem" onClick={() => { setMenuId(null); onDuplicate(session.id); }}>Duplicate</button>
        <hr />
        <button type="button" role="menuitem" className="is-danger" onClick={() => { setMenuId(null); setDeleting(session.id); }}>Delete session…</button>
      </div> : null}
    </li>;
  }

  return <div className="sessions-panel">
    {showIntro ? <ViewIntro id="sessions" className="is-sessions" title="What sessions are">
      A session is a set of documents you work on together, like a browser window with its tabs. Start one per project and switch back to pick up where you left off.
    </ViewIntro> : null}
    <section aria-labelledby="sessions-all">
      <h3 id="sessions-all" className="sessions-heading">Sessions</h3>
      <ul className="sessions-list">{sessions.map(row)}</ul>
    </section>
    {creating ? <div className="sessions-new-form">
      <RenameInput initial="" label="New session name" onDone={(name) => { setCreating(false); if (name !== null) onNew(name); }} />
      <p className="sessions-hint">Enter creates it and switches to it.</p>
    </div> : <button type="button" className="sessions-new" onClick={() => setCreating(true)}><PlusIcon />New session</button>}
    {active ? <section aria-labelledby="sessions-active-documents" className="sessions-documents">
      <h3 id="sessions-active-documents" className="sessions-heading">In {active.name}</h3>
      {activeDocuments.length ? <ul className="sessions-list">
        {activeDocuments.map((document) => <li key={document.id} className={`session-document${document.id === focusedDocumentId ? " is-here" : ""}`}>
          <button type="button" className="session-document-open" aria-current={document.id === focusedDocumentId ? "page" : undefined}
            onClick={() => onOpenDocument(document.id)} title={document.title || "Untitled document"}>
            {document.title || "Untitled document"}
          </button>
          <button type="button" className="session-document-remove" aria-label={`Remove ${document.title || "Untitled document"} from ${active.name}`}
            title="Remove from this session (stays in your vault)" onClick={() => onRemoveDocument(active.id, document.id)}>×</button>
        </li>)}
      </ul> : <p className="sessions-empty">Documents you open here join this session.</p>}
    </section> : null}
    {deletingSession ? <div className="sessions-confirm" role="alertdialog" aria-modal="true" aria-labelledby="sessions-confirm-title" aria-describedby="sessions-confirm-body">
      <strong id="sessions-confirm-title">Delete “{deletingSession.name}”?</strong>
      <p id="sessions-confirm-body">Its {countLabel(deletingSession.documentIds.length)} stay in your vault. Only this session's list and layout are removed.</p>
      <div className="sessions-confirm-actions">
        <button type="button" onClick={() => setDeleting(null)}>Cancel</button>
        <button type="button" className="is-danger" onClick={() => { setDeleting(null); onDelete(deletingSession.id); }}>Delete session</button>
      </div>
    </div> : null}
  </div>;
}
