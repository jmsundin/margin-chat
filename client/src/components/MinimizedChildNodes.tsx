import { isCompactDocument } from "@margin-chat/workspace-contracts";
import type { Conversation } from "../types";
import { getDocumentPreview } from "../lib/documentSources";
import "./MinimizedChildNodes.css";

/** Width the node column adds beside its document, including the connector space. */
export const MINIMIZED_CHILD_NODES_WIDTH = 248;

interface Props {
  documents: Conversation[];
  onOpen: (documentId: string) => void;
}

/**
 * Minimized side documents and margin notes, drawn as a vertical stack of map nodes in the empty
 * space beside their document, joined to it like Map view's left-to-right tree. Clicking one opens it.
 */
export default function MinimizedChildNodes({ documents, onOpen }: Props) {
  return <nav className="minimized-child-nodes" aria-label="Minimized side documents">
    <ol>
      {documents.map((item) => {
        const note = isCompactDocument(item) || Boolean(item.document?.marginNote);
        const title = item.title || "Untitled document";
        const label = `${note ? "Open margin note" : "Open side document"}: ${title}`;
        const quote = item.branchAnchor?.quote?.trim();
        const preview = note && quote ? "" : getDocumentPreview(item, 90);
        return <li key={item.id} className={note ? "is-margin-note" : "is-side-document"}>
          <button type="button" className="document-side-restore minimized-child-node" aria-label={label} title={label} onClick={() => onOpen(item.id)}>
            <span className="minimized-child-node-kind">
              {note ? <svg viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"><path d="M3 2.5h10v8l-3 3H3z M10 13.5v-3h3 M5.5 6h5 M5.5 8.5h3"/></svg>
                : <svg viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"><path d="M9.5 2H3.5v12h9V5z M9.5 2v3h3 M5.5 8h5 M5.5 10.5h5"/></svg>}
              {note ? "Margin note" : "Side document"}
            </span>
            <strong>{title}</strong>
            {note && quote ? <q>{quote}</q> : preview && preview !== title ? <span className="minimized-child-node-preview">{preview}</span> : null}
          </button>
        </li>;
      })}
    </ol>
  </nav>;
}
