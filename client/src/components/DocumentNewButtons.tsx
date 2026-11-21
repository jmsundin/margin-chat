import { isApplePlatform } from "../lib/workspaceViewShortcuts";
import "./DocumentNewButtons.css";

/** A margin note: a short thought pinned to a passage, in the page's margin. */
export function MarginNoteIcon({ size = 15 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
    <rect x="9.5" y="2.5" width="4" height="11" rx="1" /><path d="M2.5 4.5h5M2.5 8h5M2.5 11.5h3" />
  </svg>;
}

/** A side document: a new page beside this one. */
export function SideDocumentIcon({ size = 15 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
    <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" /><path d="M8 2.5v11" />
  </svg>;
}

/**
 * The document header's Note and Side doc buttons. Both act on the selection, else the caret's paragraph,
 * else the whole page, so the buttons keep the editor's selection and caret when pressed.
 */
export default function DocumentNewButtons({ onNote, onSideDocument, iconsOnly = false }: {
  onNote: () => void; onSideDocument: () => void;
  /** Side panes are narrow: icons only, with the names in the tooltips. */
  iconsOnly?: boolean;
}) {
  const mod = isApplePlatform() ? "⌘⇧" : "Ctrl+Shift+";
  const keep = (event: React.SyntheticEvent) => event.preventDefault();
  return <div className={`document-new-buttons${iconsOnly ? " is-icons-only" : ""}`} role="group" aria-label="Add to this page">
    <button type="button" className="document-new-button is-note" onPointerDown={keep} onMouseDown={keep} onClick={onNote}
      aria-label="New margin note" title={`New margin note: a quick thought beside this passage (${mod}M)`}>
      <MarginNoteIcon /><span>Note</span>
    </button>
    <button type="button" className="document-new-button is-side" onPointerDown={keep} onMouseDown={keep} onClick={onSideDocument}
      aria-label="New side document" title={`New side document: a new page that grows from this one (${mod}D)`}>
      <SideDocumentIcon /><span>Side doc</span>
    </button>
  </div>;
}
