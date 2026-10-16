import type { ChatOutlineItem } from "../lib/chatOutline";
import { usePdfNavigation } from "../lib/pdfNavigation";
import { PdfContents } from "./PdfSidebar";
import "./ChatOutline.css";

interface ChatOutlineProps {
  items: ChatOutlineItem[];
  activeItemId: string | null;
  onSelect: (itemId: string) => void;
  /** The document shown, so an open PDF's own contents can be listed. */
  conversationId?: string;
  /** After jumping to a place in a PDF. */
  onNavigated?: () => void;
}

export default function ChatOutline({ items, activeItemId, onSelect, conversationId, onNavigated }: ChatOutlineProps) {
  const pdf = usePdfNavigation(conversationId);
  const headings = items.filter((item) => item.kind === "heading");
  // The reader also reports paragraph and prompt targets. Keep the preceding
  // content heading active when those internal navigation targets are visible.
  const activeIndex = items.findIndex((item) => item.id === activeItemId);
  const activeHeadingId = items.slice(0, activeIndex + 1).reverse().find((item) => item.kind === "heading")?.id;

  const pdfContents = pdf?.outline?.length ? pdf.outline : null;
  if (!headings.length && !pdfContents) return <p className="chat-outline-empty">{pdf?.outline
    ? "This PDF has no table of contents. Add headings to its notes to see them here."
    : pdf ? "Reading contents…" : "Add headings to your document to see its outline."}</p>;

  const notes = headings.length ? <div className="document-content-outline">
    <ol className="outline-headings">
      {headings.map((item) => <li className={`outline-heading-level-${item.level}`} key={item.id}>
        <button aria-current={item.id === activeHeadingId ? "location" : undefined}
          className={`outline-heading-link${item.id === activeHeadingId ? " is-active" : ""}`}
          onClick={() => onSelect(item.id)} title={item.label} type="button">
          <span className="outline-heading-dot" aria-hidden="true" /><span>{item.label}</span>
        </button>
      </li>)}
    </ol>
  </div> : null;
  if (!pdfContents) return notes;
  return <>
    <PdfContents outline={pdfContents} currentPage={pdf!.currentPage} labels={pdf!.labels} onJump={(page, top) => { pdf!.jump(page, top); onNavigated?.(); }} />
    {notes ? <><p className="vault-pdf-outline-label">Notes</p>{notes}</> : null}
  </>;
}
