import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  HELP_CATEGORIES, HELP_GUIDES, POPULAR_GUIDE_IDS, getHelpCategory, getHelpGuide, guidesInCategory, searchHelpGuides,
  type HelpAction, type HelpCategoryId, type HelpGuide,
} from "../lib/helpGuides";
import "./HelpPanel.css";

type HelpView = { kind: "home" } | { kind: "category"; id: HelpCategoryId } | { kind: "guide"; id: string };

interface Props {
  /** Open on this guide instead of the front page. */
  initialGuideId?: string;
  /** Runs a guide's button, such as opening a settings section. The panel stays open so the steps can be followed. */
  onAction: (action: HelpAction) => void;
  /** False hides a guide's button where the workspace can't run it (the tour inside the extension, say). */
  canRun?: (action: HelpAction) => boolean;
  onClose: () => void;
}

/** Guide text marks the names of buttons and menus with **bold**. */
function rich(text: string): ReactNode {
  return text.split(/\*\*(.+?)\*\*/g).map((part, index) => index % 2 ? <strong key={index}>{part}</strong> : <Fragment key={index}>{part}</Fragment>);
}

const ChevronIcon = () => <svg aria-hidden="true" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m9 6 6 6-6 6"/></svg>;

function GuideRow({ guide, onOpen }: { guide: HelpGuide; onOpen: (id: string) => void }) {
  return <li>
    <button type="button" className="help-row" onClick={() => onOpen(guide.id)}>
      <span className="help-row-text"><span className="help-row-title">{guide.title}</span><span className="help-row-summary">{guide.summary}</span></span>
      <ChevronIcon/>
    </button>
  </li>;
}

/**
 * Help: guides to using Margin Chat, in a panel beside the workspace. It is not a modal, so the reader
 * can follow a guide's steps in the app while it stays open.
 */
export default function HelpPanel({ initialGuideId, onAction, canRun, onClose }: Props) {
  const [history, setHistory] = useState<HelpView[]>(() => [initialGuideId && getHelpGuide(initialGuideId) ? { kind: "guide", id: initialGuideId } : { kind: "home" }]);
  const [index, setIndex] = useState(0);
  const [query, setQuery] = useState("");
  const panelRef = useRef<HTMLElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const view = history[index];
  const results = useMemo(() => searchHelpGuides(query), [query]);
  const searching = query.trim().length > 0;

  function go(next: HelpView) {
    setHistory((current) => [...current.slice(0, index + 1), next]);
    setIndex(index + 1);
    setQuery("");
  }
  const openGuide = (id: string) => go({ kind: "guide", id });

  // A new page starts at its top, and its heading takes focus so a screen reader announces it.
  useEffect(() => {
    bodyRef.current?.scrollTo({ top: 0 });
    if (index > 0) bodyRef.current?.querySelector<HTMLElement>("h2, h3")?.focus({ preventScroll: true });
  }, [index, view]);
  useEffect(() => { searchRef.current?.focus({ preventScroll: true }); }, []);

  // Escape closes Help only from inside it: the workspace behind is still in use and has its own Escape.
  function handleKeyDown(event: React.KeyboardEvent) {
    if (event.key !== "Escape") return;
    // A dialog a guide's button opened sits on top while focus is still here; this Escape is the dialog's.
    if (document.querySelector('[aria-modal="true"]')) return;
    event.stopPropagation();
    if (searching) setQuery(""); else onClose();
  }

  function renderHome() {
    const popular = POPULAR_GUIDE_IDS.flatMap((id) => getHelpGuide(id) ?? []);
    return <>
      <h2 className="help-section-title" tabIndex={-1}>Popular</h2>
      <ul className="help-list">{popular.map((guide) => <GuideRow key={guide.id} guide={guide} onOpen={openGuide}/>)}</ul>
      <h2 className="help-section-title">Browse by topic</h2>
      <ul className="help-list">
        {HELP_CATEGORIES.map((category) => {
          const count = guidesInCategory(category.id).length;
          return count ? <li key={category.id}>
            <button type="button" className="help-row" onClick={() => go({ kind: "category", id: category.id })}>
              <span className="help-row-text"><span className="help-row-title">{category.name}</span><span className="help-row-summary">{category.description}</span></span>
              <span className="help-count" aria-label={`${count} guides`}>{count}</span>
            </button>
          </li> : null;
        })}
      </ul>
    </>;
  }

  function renderCategory(id: HelpCategoryId) {
    const category = getHelpCategory(id);
    return <>
      <h2 className="help-title" tabIndex={-1}>{category?.name}</h2>
      <p className="help-lead">{category?.description}</p>
      <ul className="help-list">{guidesInCategory(id).map((guide) => <GuideRow key={guide.id} guide={guide} onOpen={openGuide}/>)}</ul>
    </>;
  }

  function renderGuide(id: string) {
    const guide = getHelpGuide(id);
    if (!guide) return <p className="help-empty">This guide isn't available. <button type="button" className="help-link" onClick={() => go({ kind: "home" })}>See all guides</button></p>;
    const category = getHelpCategory(guide.category);
    const related = (guide.related ?? []).flatMap((relatedId) => getHelpGuide(relatedId) ?? []);
    const action = guide.action && (canRun?.(guide.action) ?? true) ? guide.action : null;
    return <article className="help-guide">
      {category ? <button type="button" className="help-crumb" onClick={() => go({ kind: "category", id: category.id })}>{category.name}</button> : null}
      <h2 className="help-title" tabIndex={-1}>{guide.title}</h2>
      <p className="help-lead">{guide.summary}</p>
      {action ? <button type="button" className="help-action" onClick={() => onAction(action)}>{action.label}</button> : null}
      {guide.before?.length ? <>
        <h3>Before you start</h3>
        <ul className="help-bullets">{guide.before.map((item) => <li key={item}>{rich(item)}</li>)}</ul>
      </> : null}
      <h3>Steps</h3>
      <ol className="help-steps">
        {guide.steps.map((step) => <li key={step.title}><strong className="help-step-title">{step.title}</strong><span>{rich(step.body)}</span></li>)}
      </ol>
      {guide.notes?.length ? <>
        <h3>Good to know</h3>
        <ul className="help-bullets">{guide.notes.map((item) => <li key={item}>{rich(item)}</li>)}</ul>
      </> : null}
      {related.length ? <>
        <h3>Related guides</h3>
        <ul className="help-related">{related.map((item) => <li key={item.id}><button type="button" className="help-link" onClick={() => openGuide(item.id)}>{item.title}</button></li>)}</ul>
      </> : null}
    </article>;
  }

  return <aside className="help-panel" aria-label="Help" ref={panelRef} onKeyDown={handleKeyDown}>
    <header className="help-head">
      <span className="help-head-title">Help</span>
      <button type="button" className="help-icon-button" aria-label="Close help" title="Close (F1)" onClick={onClose}>
        <svg aria-hidden="true" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>
      </button>
    </header>
    <div className="help-toolbar">
      <button type="button" className="help-icon-button" aria-label="Back" disabled={index === 0 && !searching}
        onClick={() => { if (searching) setQuery(""); else setIndex(index - 1); }}>
        <svg aria-hidden="true" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m15 6-6 6 6 6"/></svg>
      </button>
      <button type="button" className="help-icon-button" aria-label="Forward" disabled={searching || index >= history.length - 1} onClick={() => setIndex(index + 1)}>
        <ChevronIcon/>
      </button>
      <input ref={searchRef} className="help-search" type="search" value={query} onChange={(event) => setQuery(event.target.value)}
        placeholder={`Search ${HELP_GUIDES.length} guides`} aria-label="Search guides" autoComplete="off" spellCheck={false}/>
      <button type="button" className="help-icon-button" aria-label="All guides" title="All guides" disabled={view.kind === "home" && !searching}
        onClick={() => { if (view.kind === "home") setQuery(""); else go({ kind: "home" }); }}>
        <svg aria-hidden="true" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01"/></svg>
      </button>
    </div>
    <div className="help-body" ref={bodyRef}>
      {searching ? <>
        <p className="help-result-count" role="status">{results.length ? `${results.length} guide${results.length === 1 ? "" : "s"}` : "No guides match that."}</p>
        {results.length ? <ul className="help-list">{results.map((guide) => <GuideRow key={guide.id} guide={guide} onOpen={openGuide}/>)}</ul>
          : <p className="help-empty">Try fewer or different words, or <button type="button" className="help-link" onClick={() => setQuery("")}>browse by topic</button>.</p>}
      </> : view.kind === "home" ? renderHome() : view.kind === "category" ? renderCategory(view.id) : renderGuide(view.id)}
    </div>
  </aside>;
}
