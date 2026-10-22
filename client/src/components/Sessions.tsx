import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
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

interface SwitcherProps {
  /** Every session, sorted like the sidebar's documents. */
  sessions: WorkspaceSession[];
  activeId: string | null;
  /** Phones get a bottom sheet instead of a dropdown. */
  compact: boolean;
  onSelect: (id: string) => void;
  onNew: () => void;
  /** Opens the left panel's Sessions view, where sessions are renamed and deleted. */
  onManage?: () => void;
}

function ChevronIcon() {
  return <svg className="session-icon" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M4 6l4 4 4-4" /></svg>;
}

/**
 * The session switcher at the top left of Document view: the active session's
 * name, and a list to pick up another one where it was left, like tmux sessions.
 */
export function SessionSwitcher({ sessions, activeId, compact, onSelect, onNew, onManage }: SwitcherProps) {
  const [open, setOpen] = useState(false);
  const popup = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useOutsideDismiss(open, () => setOpen(false), popup, trigger);
  const active = sessions.find((session) => session.id === activeId);
  useEffect(() => {
    if (!open) return;
    (popup.current?.querySelector<HTMLButtonElement>("[aria-current='true']") ?? popup.current?.querySelector<HTMLButtonElement>("button"))?.focus();
  }, [open]);

  function close(refocus: boolean) {
    setOpen(false);
    if (refocus) trigger.current?.focus();
  }
  function choose(action: () => void) {
    setOpen(false);
    action();
  }
  function handleKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") { event.preventDefault(); close(true); return; }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const buttons = [...popup.current?.querySelectorAll<HTMLButtonElement>("button") ?? []];
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    event.preventDefault();
    buttons[(index + (event.key === "ArrowDown" ? 1 : buttons.length - 1)) % buttons.length]?.focus();
  }

  return <div className={`session-switcher${compact ? " is-compact" : ""}`}>
    <button ref={trigger} type="button" className="session-switcher-trigger" aria-haspopup="dialog" aria-expanded={open}
      aria-label={`Session: ${active?.name ?? "none"}. Switch session`}
      title={active ? `${active.name} · ${countLabel(active.documentIds.length)} · switch session` : "Switch session"}
      onClick={() => setOpen((value) => !value)}>
      <span className="session-dot" style={{ background: active?.color }} aria-hidden="true" />
      <span className="session-switcher-name">{active?.name ?? "Sessions"}</span>
      <ChevronIcon />
    </button>
    {open ? <div ref={popup} className={compact ? "session-sheet" : "session-popover"} role="dialog" aria-label="Sessions" onKeyDown={handleKeyDown}>
      {compact ? <div className="session-sheet-handle" aria-hidden="true" /> : null}
      <div className="session-sheet-heading">Sessions</div>
      <div className="session-sheet-list">
        {sessions.map((session) => <button key={session.id} type="button" className="session-sheet-row"
          aria-current={session.id === activeId ? "true" : undefined}
          onClick={() => choose(() => onSelect(session.id))}>
          <span className="session-dot" style={{ background: session.color }} aria-hidden="true" />
          <span className="session-sheet-name">{session.name}</span>
          <span className="session-meta">{countLabel(session.documentIds.length)}</span>
        </button>)}
      </div>
      <button type="button" className="session-sheet-row is-new" onClick={() => choose(onNew)}><PlusIcon />New session</button>
      {onManage ? <button type="button" className="session-sheet-row is-manage" onClick={() => choose(onManage)}>Manage sessions…</button> : null}
    </div> : null}
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
