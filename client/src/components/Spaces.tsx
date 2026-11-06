import { createContext, useEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent } from "react";
import type { Conversation, WorkspaceSession } from "../types";
import { formatRelativeTime } from "../lib/conversationSearch";
import { useOutsideDismiss } from "../lib/useOutsideDismiss";
import { getSessionRootDocuments } from "../lib/workspaceSessions";
import ViewIntro from "./ViewIntro";
import "./Spaces.css";

/** What a document's menu needs to add it to spaces or take it out. */
export interface SpaceMenuActions {
  spaces: WorkspaceSession[];
  isIn: (spaceId: string, documentId: string) => boolean;
  onToggle: (spaceId: string, documentId: string) => void;
  onCreateWith: (documentId: string) => void;
}
export const SpaceMenuContext = createContext<SpaceMenuActions | null>(null);

const DOCUMENT_DRAG_TYPE = "application/x-margin-document";

function countLabel(count: number) {
  return `${count} ${count === 1 ? "doc" : "docs"}`;
}

function PlusIcon() {
  return <svg className="space-icon" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"><path d="M8 3v10M3 8h10" /></svg>;
}

function RenameInput({ initial, label, placeholder = "Name it, or leave empty for an automatic name", onDone }: { initial: string; label: string; placeholder?: string; onDone: (name: string | null) => void }) {
  const [value, setValue] = useState(initial);
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  useEffect(() => { ref.current?.focus(); ref.current?.select(); }, []);
  function finish(name: string | null) {
    if (done.current) return;
    done.current = true;
    onDone(name);
  }
  return <input ref={ref} className="space-rename-input" aria-label={label} value={value} maxLength={120}
    placeholder={placeholder}
    onChange={(event) => setValue(event.target.value)} onBlur={() => finish(value)}
    onKeyDown={(event) => {
      if (event.key === "Enter") { event.preventDefault(); finish(value); }
      else if (event.key === "Escape") { event.preventDefault(); finish(null); }
      event.stopPropagation();
    }} />;
}

/** Shortcut hint for the nth space; ⌃1 to ⌃9 cover the first nine. */
function shortcutLabel(index: number) {
  return index < 9 ? `⌃${index + 1}` : "";
}

interface SwitcherProps {
  /** Every space, in its fixed order. */
  spaces: WorkspaceSession[];
  activeId: string | null;
  conversations: Record<string, Conversation>;
  /** How many tabs are open, for "New space from these tabs". */
  openTabCount: number;
  onSwitch: (id: string | null) => void;
  onNew: (name: string) => void;
  onNewFromTabs: () => void;
  /** Opens the left panel's Spaces view, where spaces are renamed and deleted. */
  onManage: () => void;
  /** A document dropped on the button joins the space you're in. */
  onDropDocument?: (documentId: string) => void;
  /** A list in the phone's drop-down instead of a button with a pop-up. */
  inline?: boolean;
}

/** The space you're in, named on a solid pill at the left of the tabs. It opens every space, and No space. */
export function SpaceSwitcher({ spaces, activeId, conversations, openTabCount, onSwitch, onNew, onNewFromTabs, onManage, onDropDocument, inline = false }: SwitcherProps) {
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [previewId, setPreviewId] = useState<string | null>(activeId);
  const [dropping, setDropping] = useState(false);
  const panel = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const active = spaces.find((space) => space.id === activeId) ?? null;
  useOutsideDismiss(open && !inline, () => { setOpen(false); setCreating(false); }, panel, trigger);
  useEffect(() => { if (open) setPreviewId(activeId ?? spaces[0]?.id ?? null); }, [open, activeId]);
  useEffect(() => {
    if (!open || inline) return;
    panel.current?.querySelector<HTMLButtonElement>('[aria-current="true"], .space-option')?.focus();
  }, [open, inline]);
  const preview = spaces.find((space) => space.id === previewId) ?? null;
  const previewDocuments = useMemo(() => preview ? getSessionRootDocuments(preview, conversations) : [], [preview, conversations]);

  function pick(id: string | null) {
    setOpen(false);
    setCreating(false);
    if (id !== activeId) onSwitch(id);
  }

  const list = <>
    <div className="space-options" role="group" aria-label="Spaces">
      <button type="button" className={`space-option${activeId === null ? " is-active" : ""}`} aria-current={activeId === null ? "true" : undefined}
        title="Just browsing: documents you open here aren't kept anywhere" onClick={() => pick(null)}
        onPointerEnter={() => setPreviewId(null)} onFocus={() => setPreviewId(null)}>
        <span className="space-ring" aria-hidden="true" />
        <span className="space-option-name">No space</span>
        <span className="space-meta">⌃0</span>
      </button>
      {spaces.length ? <hr /> : null}
      {spaces.map((space, index) => <button key={space.id} type="button"
        className={`space-option${space.id === activeId ? " is-active" : ""}${space.id === previewId ? " is-previewed" : ""}`}
        aria-current={space.id === activeId ? "true" : undefined} title={space.name}
        onPointerEnter={() => setPreviewId(space.id)} onFocus={() => setPreviewId(space.id)}
        onClick={() => pick(space.id)}>
        <span className="space-dot" style={{ background: space.color }} aria-hidden="true" />
        <span className="space-option-name">{space.name}</span>
        <span className="space-meta">{inline ? countLabel(getSessionRootDocuments(space, conversations).length) : shortcutLabel(index)}</span>
      </button>)}
    </div>
    <hr />
    {creating ? <div className="space-new-form">
      <RenameInput initial="" label="New space name" placeholder="Name the new space"
        onDone={(name) => { setCreating(false); if (name !== null) { setOpen(false); onNew(name); } }} />
      <p className="spaces-hint">Enter makes it and takes you there.</p>
    </div> : <>
      {openTabCount > 0 ? <button type="button" className="space-action" onClick={() => { setOpen(false); onNewFromTabs(); }}>
        <PlusIcon />New space from {openTabCount === 1 ? "this tab" : `these ${openTabCount} tabs`}
      </button> : null}
      <button type="button" className="space-action" onClick={() => setCreating(true)}><PlusIcon />New empty space</button>
      {spaces.length ? <button type="button" className="space-action is-quiet" onClick={() => { setOpen(false); onManage(); }}>Rename or delete spaces…</button> : null}
    </>}
  </>;

  if (inline) return <div className="space-switcher is-inline">{list}</div>;

  function acceptsDrop(event: DragEvent) {
    return Boolean(active && onDropDocument && event.dataTransfer.types.includes(DOCUMENT_DRAG_TYPE));
  }

  return <div className="space-switcher">
    <button ref={trigger} type="button" className={`space-pill${active ? "" : " is-none"}${dropping ? " is-drop-target" : ""}`}
      aria-haspopup="dialog" aria-expanded={open}
      style={active ? { "--space-color": active.color } as CSSProperties : undefined}
      title={active ? `${active.name}: switch space (⌃1–⌃9, ⌃0 for No space). Drop a document here to add it.` : "No space: switch space (⌃1–⌃9)"}
      onClick={() => setOpen((value) => !value)}
      onDragOver={(event) => { if (!acceptsDrop(event)) return; event.preventDefault(); event.dataTransfer.dropEffect = "move"; setDropping(true); }}
      onDragLeave={() => setDropping(false)}
      onDrop={(event) => {
        setDropping(false);
        if (!acceptsDrop(event)) return;
        event.preventDefault();
        const id = event.dataTransfer.getData(DOCUMENT_DRAG_TYPE);
        if (id) onDropDocument?.(id);
      }}>
      {active ? <span className="space-pill-mark" aria-hidden="true" /> : <span className="space-ring" aria-hidden="true" />}
      <span className="space-pill-name">{active ? active.name : "No space"}</span>
      <svg className="space-pill-chevron" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d={open ? "m4 10 4-4 4 4" : "m4 6 4 4 4-4"} /></svg>
    </button>
    {open ? <div ref={panel} className="space-popover" role="dialog" aria-label="Spaces"
      onKeyDown={(event) => {
        if (event.key === "Escape") { event.preventDefault(); setOpen(false); setCreating(false); trigger.current?.focus(); }
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          const items = [...(panel.current?.querySelectorAll<HTMLButtonElement>(".space-options button, .space-action") ?? [])];
          const index = items.findIndex((item) => item === document.activeElement);
          items[(index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus();
        }
      }}>
      <div className="space-popover-list">{list}</div>
      <div className="space-popover-preview" aria-live="polite">
        {preview ? <>
          <div className="space-preview-title"><span className="space-dot" style={{ background: preview.color }} aria-hidden="true" />{preview.name}</div>
          <p className="space-preview-meta">{countLabel(previewDocuments.length)}{preview.id === activeId ? " · you're here" : ` · last used ${formatRelativeTime(preview.lastOpenedAt)}`}</p>
          {previewDocuments.length ? <ul>{previewDocuments.slice(0, 12).map((document) => <li key={document.id}>{document.title || "Untitled document"}</li>)}</ul>
            : <p className="spaces-hint">Nothing here yet. Open it to add documents.</p>}
        </> : <>
          <div className="space-preview-title"><span className="space-ring" aria-hidden="true" />No space</div>
          <p className="spaces-hint">Read and wander. Documents you open here aren't kept in any space.</p>
        </>}
      </div>
    </div> : null}
  </div>;
}

interface StartPanelProps {
  space: WorkspaceSession;
  conversations: Record<string, Conversation>;
  onOpen: (documentIds: string[]) => void;
  onNewDocument: () => void;
}

/** What an empty space shows: pick documents to bring in, or start a new one. Nothing joins without a click. */
export function SpaceStartPanel({ space, conversations, onOpen, onNewDocument }: StartPanelProps) {
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const roots = useMemo(() => Object.values(conversations)
    .filter((conversation) => conversation.parentId === null)
    .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt)), [conversations]);
  const words = query.trim().toLowerCase();
  const shown = (words ? roots.filter((root) => (root.title || "Untitled document").toLowerCase().includes(words)) : roots).slice(0, 8);
  return <section className="space-start" aria-labelledby="space-start-title" style={{ "--space-color": space.color } as CSSProperties}>
    <h2 id="space-start-title"><span className="space-dot" style={{ background: space.color }} aria-hidden="true" />What goes in {space.name}?</h2>
    <p className="spaces-hint">Pick documents to keep here. Anything else you open while you're in this space is only visiting.</p>
    <input className="space-start-search" type="search" aria-label="Search documents" placeholder="Search documents…" value={query}
      onChange={(event) => setQuery(event.target.value)} />
    <ul className="space-start-list">
      {shown.map((root) => <li key={root.id}>
        <label><input type="checkbox" checked={picked.includes(root.id)}
          onChange={(event) => setPicked((current) => event.target.checked ? [...current, root.id] : current.filter((id) => id !== root.id))} />
          <span>{root.title || "Untitled document"}</span></label>
      </li>)}
      {!shown.length ? <li className="spaces-hint">No documents match.</li> : null}
    </ul>
    <div className="space-start-actions">
      <button type="button" className="is-primary" disabled={!picked.length} onClick={() => onOpen(picked)}>
        {picked.length ? `Add ${picked.length} ${picked.length === 1 ? "document" : "documents"}` : "Add documents"}
      </button>
      <button type="button" onClick={onNewDocument}>New document</button>
    </div>
  </section>;
}

interface PanelProps {
  spaces: WorkspaceSession[];
  activeId: string | null;
  conversations: Record<string, Conversation>;
  focusedDocumentId: string;
  onOpen: (id: string | null) => void;
  onRename: (id: string, name: string) => void;
  onDuplicate: (id: string) => void;
  onDelete: (id: string) => void;
  onNew: (name: string) => void;
  onOpenDocument: (id: string) => void;
  onRemoveDocument: (spaceId: string, documentId: string) => void;
  /** Explain what a space is, for a nearly empty vault. */
  showIntro?: boolean;
}

/** The left panel's Spaces view: every space, and the documents kept in the one you're in. */
export function SpacesPanel({ spaces, activeId, conversations, focusedDocumentId, onOpen, onRename, onDuplicate, onDelete, onNew, onOpenDocument, onRemoveDocument, showIntro = false }: PanelProps) {
  const [menuId, setMenuId] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const menu = useRef<HTMLDivElement>(null);
  useOutsideDismiss(menuId !== null, () => setMenuId(null), menu);
  const active = spaces.find((space) => space.id === activeId);
  const deletingSpace = spaces.find((space) => space.id === deleting);
  const activeDocuments = active ? getSessionRootDocuments(active, conversations) : [];

  function row(space: WorkspaceSession) {
    const isActive = space.id === activeId;
    const count = getSessionRootDocuments(space, conversations).length;
    return <li key={space.id} className={`space-row${isActive ? " is-active" : ""}`} data-space-row-id={space.id}>
      <span className="space-dot" style={{ background: space.color }} aria-hidden="true" />
      {renaming === space.id ? <RenameInput initial={space.nameSource === "user" ? space.name : ""} label={`Rename ${space.name}`}
        onDone={(name) => { setRenaming(null); if (name !== null) onRename(space.id, name); }} />
        : <button type="button" className="space-row-open" aria-current={isActive ? "true" : undefined} onClick={() => onOpen(space.id)}
          title={space.nameSource === "auto" ? `${space.name} (named from its documents)` : space.name}>
          <span className="space-row-name">{space.name}</span>
          <span className="space-meta">{countLabel(count)}{isActive ? "" : ` · ${formatRelativeTime(space.lastOpenedAt)}`}</span>
        </button>}
      <button type="button" className="space-row-menu-trigger" aria-label={`Options for ${space.name}`} aria-haspopup="menu"
        aria-expanded={menuId === space.id} onClick={() => setMenuId((current) => current === space.id ? null : space.id)}>⋯</button>
      {menuId === space.id ? <div ref={menu} className="space-menu" role="menu" aria-label={`Options for ${space.name}`}
        onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); setMenuId(null); } }}>
        <button type="button" role="menuitem" onClick={() => { setMenuId(null); onOpen(space.id); }}>Open</button>
        <button type="button" role="menuitem" onClick={() => { setMenuId(null); setRenaming(space.id); }}>Rename</button>
        <button type="button" role="menuitem" onClick={() => { setMenuId(null); onDuplicate(space.id); }}>Duplicate</button>
        <hr />
        <button type="button" role="menuitem" className="is-danger" onClick={() => { setMenuId(null); setDeleting(space.id); }}>Delete space…</button>
      </div> : null}
    </li>;
  }

  return <div className="spaces-panel">
    {showIntro ? <ViewIntro id="sessions" className="is-sessions" title="What spaces are">
      A space keeps the documents for one project together, so you can come back to them. Documents join only when you add them; anything else you open there is just visiting.
    </ViewIntro> : null}
    <section aria-labelledby="spaces-all">
      <h3 id="spaces-all" className="spaces-heading">Spaces</h3>
      <ul className="spaces-list">
        <li className={`space-row${activeId === null ? " is-active" : ""}`}>
          <span className="space-ring" aria-hidden="true" />
          <button type="button" className="space-row-open" aria-current={activeId === null ? "true" : undefined} onClick={() => onOpen(null)}>
            <span className="space-row-name">No space</span><span className="space-meta">just browsing</span>
          </button>
        </li>
        {spaces.map(row)}
      </ul>
    </section>
    {creating ? <div className="spaces-new-form">
      <RenameInput initial="" label="New space name" placeholder="Name the new space" onDone={(name) => { setCreating(false); if (name !== null) onNew(name); }} />
      <p className="spaces-hint">Enter makes it and takes you there.</p>
    </div> : <button type="button" className="spaces-new" onClick={() => setCreating(true)}><PlusIcon />New space</button>}
    {active ? <section aria-labelledby="spaces-active-documents" className="spaces-documents">
      <h3 id="spaces-active-documents" className="spaces-heading">In {active.name}</h3>
      {activeDocuments.length ? <ul className="spaces-list">
        {activeDocuments.map((document) => <li key={document.id} className={`space-document${document.id === focusedDocumentId ? " is-here" : ""}`}>
          <button type="button" className="space-document-open" aria-current={document.id === focusedDocumentId ? "page" : undefined}
            onClick={() => onOpenDocument(document.id)} title={document.title || "Untitled document"}>
            {document.title || "Untitled document"}
          </button>
          <button type="button" className="space-document-remove" aria-label={`Remove ${document.title || "Untitled document"} from ${active.name}`}
            title="Remove from this space (stays in your vault)" onClick={() => onRemoveDocument(active.id, document.id)}>×</button>
        </li>)}
      </ul> : <p className="spaces-empty">Nothing kept here yet. Use Keep on a tab, ⌘D, or a document's menu to add one.</p>}
    </section> : null}
    {deletingSpace ? <div className="spaces-confirm" role="alertdialog" aria-modal="true" aria-labelledby="spaces-confirm-title" aria-describedby="spaces-confirm-body">
      <strong id="spaces-confirm-title">Delete “{deletingSpace.name}”?</strong>
      <p id="spaces-confirm-body">Its {countLabel(getSessionRootDocuments(deletingSpace, conversations).length)} stay in your vault. Only this space's list and layout are removed.</p>
      <div className="spaces-confirm-actions">
        <button type="button" onClick={() => setDeleting(null)}>Cancel</button>
        <button type="button" className="is-danger" onClick={() => { setDeleting(null); onDelete(deletingSpace.id); }}>Delete space</button>
      </div>
    </div> : null}
  </div>;
}
