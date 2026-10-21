import { isCompactDocument } from "@margin-chat/workspace-contracts";
import type { CSSProperties } from "react";
import type { Conversation } from "../types";
import { getDocumentPreview } from "../lib/documentSources";
import "./MinimizedChildNodes.css";

export interface MinimizedChildNode {
  document: Conversation;
  /** The node's own side documents and margin notes that aren't on screen, branching off to its right. */
  children: MinimizedChildNode[];
}

const NODE_WIDTH = 204;
const LEVEL_GAP = 56;
const LEADING_GAP = 64;

/** Width the node tree adds beside its document: the curve gap, then one column per level. */
export function getMinimizedChildNodesWidth(nodes: MinimizedChildNode[]): number {
  const depth = (items: MinimizedChildNode[]): number => items.length ? 1 + Math.max(...items.map((item) => depth(item.children))) : 0;
  const levels = depth(nodes);
  return LEADING_GAP + levels * NODE_WIDTH + (levels - 1) * LEVEL_GAP + 12;
}

interface Props {
  nodes: MinimizedChildNode[];
  onOpen: (documentId: string) => void;
}

/**
 * Minimized side documents and margin notes, drawn as map nodes in the empty space beside their
 * document, each joined to its passage by the same curve an open side document gets. A node's own
 * children branch off to its right, like Map view's left-to-right tree. Clicking one opens it.
 */
export default function MinimizedChildNodes({ nodes, onOpen }: Props) {
  function renderLevel(items: MinimizedChildNode[], parentId?: string) {
    return <ol>
      {items.map(({ document: item, children }) => {
        const note = isCompactDocument(item) || Boolean(item.document?.marginNote);
        const title = item.title || "Untitled document";
        const label = `${note ? "Open margin note" : "Open side document"}: ${title}`;
        const quote = item.branchAnchor?.quote?.trim();
        const preview = note && quote ? "" : getDocumentPreview(item, 90);
        return <li key={item.id} className={note ? "is-margin-note" : "is-side-document"}>
          <button type="button" className="document-side-restore minimized-child-node" aria-label={label} title={label}
            data-minimized-node-id={item.id} data-minimized-node-parent={parentId} onClick={() => onOpen(item.id)}>
            <span className="minimized-child-node-kind">
              {note ? <svg viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"><path d="M3 2.5h10v8l-3 3H3z M10 13.5v-3h3 M5.5 6h5 M5.5 8.5h3"/></svg>
                : <svg viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"><path d="M9.5 2H3.5v12h9V5z M9.5 2v3h3 M5.5 8h5 M5.5 10.5h5"/></svg>}
              {note ? "Margin note" : "Side document"}
            </span>
            <strong>{title}</strong>
            {note && quote ? <q>{quote}</q> : preview && preview !== title ? <span className="minimized-child-node-preview">{preview}</span> : null}
          </button>
          {children.length ? renderLevel(children, item.id) : null}
        </li>;
      })}
    </ol>;
  }
  return <nav className="minimized-child-nodes" aria-label="Minimized side documents"
    style={{ "--minimized-node-width": `${NODE_WIDTH}px`, "--minimized-level-gap": `${LEVEL_GAP}px`, "--minimized-leading-gap": `${LEADING_GAP}px` } as CSSProperties}>
    {renderLevel(nodes)}
  </nav>;
}
