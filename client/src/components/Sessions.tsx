import { useEffect, useRef, useState, type DragEvent, type KeyboardEvent as ReactKeyboardEvent } from "react";
import type { Conversation, WorkspaceSession } from "../types";
import { formatRelativeTime } from "../lib/conversationSearch";
import { useOutsideDismiss } from "../lib/useOutsideDismiss";
import "./Sessions.css";

/** Drag type for a session moving from the Sessions panel into, or along, the tab bar. */
export const SESSION_DRAG_TYPE = "application/x-margin-session";

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

interface TabsProps {
  /** Sessions in the tab bar, in tab order. */
  tabs: WorkspaceSession[];
  /** Every session, sorted like the sidebar's documents, for the phone's switcher. */
  allSessions: WorkspaceSession[];
  activeId: string | null;
  compact: boolean;
  onSelect: (id: string) => void;
  onRemoveTab: (id: string) => void;
  onNew: () => void;
  onPlace: (id: string, index: number) => void;
  onRename: (id: string, name: string) => void;
  /** A document dragged from the sidebar onto a tab joins that session. */
  onDropDocument: (sessionId: string, documentId: string) => void;
}

/**
 * The top tab bar: named sessions, like tmux windows. Each keeps its own
 * documents and layout; the rest live in the Sessions panel until dragged here.
 */
export function SessionTabs({ tabs, allSessions, activeId, compact, onSelect, onRemoveTab, onNew, onPlace, onRename, onDropDocument }: TabsProps) {
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const [documentTarget, setDocumentTarget] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const list = useRef<HTMLDivElement>(null);
  const sheet = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useOutsideDismiss(sheetOpen, () => setSheetOpen(false), sheet, trigger);

  function indexAt(clientX: number) {
    const elements = [...list.current?.querySelectorAll<HTMLElement>("[data-session-tab-id]") ?? []];
    const index = elements.findIndex((element) => {
      const box = element.getBoundingClientRect();
      return clientX < box.left + box.width / 2;
    });
    return index < 0 ? elements.length : index;
  }
  function isSessionDrag(event: DragEvent) { return [...event.dataTransfer.types].includes(SESSION_DRAG_TYPE); }
  function isDocumentDrag(event: DragEvent) { return !isSessionDrag(event) && [...event.dataTransfer.types].includes("text/plain"); }

  if (compact) {
    const active = allSessions.find((session) => session.id === activeId);
    return <div className="session-switcher">
      <button ref={trigger} type="button" className="session-switcher-trigger" aria-haspopup="dialog" aria-expanded={sheetOpen}
        onClick={() => setSheetOpen((value) => !value)}>
        <span className="session-dot" style={{ background: active?.color }} aria-hidden="true" />
        <span className="session-switcher-name">{active?.name ?? "Sessions"}</span>
        <svg className="session-icon" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M4 6l4 4 4-4" /></svg>
      </button>
      {sheetOpen ? <div ref={sheet} className="session-sheet" role="dialog" aria-label="Sessions"
        onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); setSheetOpen(false); trigger.current?.focus(); } }}>
        <div className="session-sheet-handle" aria-hidden="true" />
        <div className="session-sheet-heading">Sessions</div>
        <div className="session-sheet-list">
          {allSessions.map((session) => <button key={session.id} type="button" className="session-sheet-row"
            aria-current={session.id === activeId ? "true" : undefined}
            onClick={() => { setSheetOpen(false); onSelect(session.id); }}>
            <span className="session-dot" style={{ background: session.color }} aria-hidden="true" />
            <span className="session-sheet-name">{session.name}</span>
            <span className="session-meta">{countLabel(session.documentIds.length)}</span>
          </button>)}
        </div>
        <button type="button" className="session-sheet-row is-new" onClick={() => { setSheetOpen(false); onNew(); }}>
          <PlusIcon />New session
        </button>
      </div> : null}
    </div>;
  }

  return <div className="session-tabs" role="tablist" aria-label="Sessions" ref={list}
    onDragOver={(event) => {
      if (!isSessionDrag(event)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      setDropIndex(indexAt(event.clientX));
    }}
    onDragLeave={(event) => { if (!list.current?.contains(event.relatedTarget as Node)) setDropIndex(null); }}
    onDrop={(event) => {
      const id = event.dataTransfer.getData(SESSION_DRAG_TYPE);
      if (!id) return;
      event.preventDefault();
      onPlace(id, indexAt(event.clientX));
      setDropIndex(null);
    }}>
    {tabs.map((session, index) => {
      const active = session.id === activeId;
      return <div key={session.id} data-session-tab-id={session.id}
        className={`session-tab${active ? " is-active" : ""}${dropIndex === index ? " is-drop-before" : ""}${documentTarget === session.id ? " is-document-target" : ""}`}
        draggable={renaming !== session.id}
        onDragStart={(event) => { event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData(SESSION_DRAG_TYPE, session.id); }}
        onDragEnd={() => setDropIndex(null)}
        onDragOver={(event) => {
          if (!isDocumentDrag(event)) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = "copy";
          setDocumentTarget(session.id);
        }}
        onDragLeave={() => setDocumentTarget((current) => current === session.id ? null : current)}
        onDrop={(event) => {
          if (isSessionDrag(event)) return;
          const documentId = event.dataTransfer.getData("text/plain");
          setDocumentTarget(null);
          if (!documentId) return;
          event.preventDefault();
          event.stopPropagation();
          onDropDocument(session.id, documentId);
        }}>
        <span className="session-dot" style={{ background: session.color }} aria-hidden="true" />
        {renaming === session.id ? <RenameInput initial={session.nameSource === "user" ? session.name : ""} label={`Rename ${session.name}`}
          onDone={(name) => { setRenaming(null); if (name !== null) onRename(session.id, name); }} />
          : <button type="button" role="tab" aria-selected={active} className="session-tab-title"
            title={`${session.name} · ${countLabel(session.documentIds.length)} · double-click to rename`}
            onClick={() => onSelect(session.id)} onDoubleClick={() => setRenaming(session.id)}
            onKeyDown={(event: ReactKeyboardEvent) => {
              if (event.key === "F2") { event.preventDefault(); setRenaming(session.id); }
              else if ((event.key === "ArrowRight" || event.key === "ArrowLeft")) {
                const buttons = [...list.current?.querySelectorAll<HTMLButtonElement>(".session-tab-title") ?? []];
                const next = buttons[(buttons.indexOf(event.currentTarget as HTMLButtonElement) + (event.key === "ArrowRight" ? 1 : buttons.length - 1)) % buttons.length];
                event.preventDefault();
                next?.focus();
              }
            }}>
            {session.name}
          </button>}
        {tabs.length > 1 ? <button type="button" className="session-tab-close" aria-label={`Take ${session.name} out of the tab bar`}
          title="Take out of the tab bar (stays in Sessions)" onClick={() => onRemoveTab(session.id)}>×</button> : null}
      </div>;
    })}
    {dropIndex === tabs.length ? <span className="session-tab-drop-end" aria-hidden="true" /> : null}
    <button type="button" className="session-tab-new" aria-label="New session" title="New session" onClick={onNew}><PlusIcon /></button>
  </div>;
}

interface PanelProps {
  sessions: WorkspaceSession[];
  tabIds: string[];
  activeId: string | null;
  conversations: Record<string, Conversation>;
  focusedDocumentId: string;
  onOpen: (id: string) => void;
  onToggleTab: (id: string) => void;
  onRename: (id: string, name: string) => void;
  onDuplicate: (id: string) => void;
  onDelete: (id: string) => void;
  onNew: (name: string) => void;
  onOpenDocument: (id: string) => void;
  onRemoveDocument: (sessionId: string, documentId: string) => void;
}

/** The left panel's Sessions view: every session, which ones are tabs, and the active one's documents. */
export function SessionsPanel({ sessions, tabIds, activeId, conversations, focusedDocumentId, onOpen, onToggleTab, onRename, onDuplicate, onDelete, onNew, onOpenDocument, onRemoveDocument }: PanelProps) {
  const [menuId, setMenuId] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const menu = useRef<HTMLDivElement>(null);
  useOutsideDismiss(menuId !== null, () => setMenuId(null), menu);
  const inTabs = sessions.filter((session) => tabIds.includes(session.id));
  const others = sessions.filter((session) => !tabIds.includes(session.id));
  const active = sessions.find((session) => session.id === activeId);
  const deletingSession = sessions.find((session) => session.id === deleting);
  const activeDocuments = active ? [...active.documentIds].reverse().map((id) => conversations[id]).filter(Boolean) : [];

  function row(session: WorkspaceSession) {
    const isActive = session.id === activeId;
    const inTabBar = tabIds.includes(session.id);
    return <li key={session.id} className={`session-row${isActive ? " is-active" : ""}`} data-session-row-id={session.id}
      draggable={renaming !== session.id}
      onDragStart={(event) => { event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData(SESSION_DRAG_TYPE, session.id); }}>
      <span className="session-grip" aria-hidden="true">⋮⋮</span>
      <span className="session-dot" style={{ background: session.color }} aria-hidden="true" />
      {renaming === session.id ? <RenameInput initial={session.nameSource === "user" ? session.name : ""} label={`Rename ${session.name}`}
        onDone={(name) => { setRenaming(null); if (name !== null) onRename(session.id, name); }} />
        : <button type="button" className="session-row-open" aria-current={isActive ? "true" : undefined} onClick={() => onOpen(session.id)}
          title={session.nameSource === "auto" ? `${session.name} (named from its documents)` : session.name}>
          <span className="session-row-name">{session.name}</span>
          <span className="session-meta">{countLabel(session.documentIds.length)}{inTabBar ? "" : ` · ${formatRelativeTime(session.lastOpenedAt)}`}</span>
        </button>}
      <button type="button" className="session-row-menu-trigger" aria-label={`Options for ${session.name}`} aria-haspopup="menu"
        aria-expanded={menuId === session.id} onClick={() => setMenuId((current) => current === session.id ? null : session.id)}>⋯</button>
      {menuId === session.id ? <div ref={menu} className="session-menu" role="menu" aria-label={`Options for ${session.name}`}
        onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); setMenuId(null); } }}>
        <button type="button" role="menuitem" onClick={() => { setMenuId(null); onOpen(session.id); }}>Open</button>
        <button type="button" role="menuitem" disabled={inTabBar && tabIds.length <= 1}
          onClick={() => { setMenuId(null); onToggleTab(session.id); }}>{inTabBar ? "Remove from tab bar" : "Add to tab bar"}</button>
        <button type="button" role="menuitem" onClick={() => { setMenuId(null); setRenaming(session.id); }}>Rename</button>
        <button type="button" role="menuitem" onClick={() => { setMenuId(null); onDuplicate(session.id); }}>Duplicate</button>
        <hr />
        <button type="button" role="menuitem" className="is-danger" onClick={() => { setMenuId(null); setDeleting(session.id); }}>Delete session…</button>
      </div> : null}
    </li>;
  }

  return <div className="sessions-panel">
    <section aria-labelledby="sessions-in-tabs">
      <h3 id="sessions-in-tabs" className="sessions-heading">In the tab bar</h3>
      <ul className="sessions-list">{inTabs.map(row)}</ul>
    </section>
    <section aria-labelledby="sessions-others">
      <h3 id="sessions-others" className="sessions-heading">Other sessions</h3>
      {others.length ? <ul className="sessions-list">{others.map(row)}</ul>
        : <p className="sessions-empty">Sessions you take out of the tab bar wait here. Drag one up to the tab bar to bring it back.</p>}
    </section>
    {creating ? <div className="sessions-new-form">
      <RenameInput initial="" label="New session name" onDone={(name) => { setCreating(false); if (name !== null) onNew(name); }} />
      <p className="sessions-hint">Enter creates it and opens it as a new tab.</p>
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
