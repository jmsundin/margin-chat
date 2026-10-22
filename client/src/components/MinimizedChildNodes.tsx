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

const SIZES = {
  full: { node: 204, level: 56, leading: 64 },
  // While one of the document's children is open, the rest shrink to one-line pills.
  compact: { node: 168, level: 36, leading: 48 },
};

/** Width the node tree adds beside its document: the curve gap, then one column per level. */
export function getMinimizedChildNodesWidth(nodes: MinimizedChildNode[], compact = false): number {
  const size = SIZES[compact ? "compact" : "full"];
  const depth = (items: MinimizedChildNode[]): number => items.length ? 1 + Math.max(...items.map((item) => depth(item.children))) : 0;
  const levels = depth(nodes);
  return size.leading + levels * size.node + (levels - 1) * size.level + 12;
}

interface Props {
  nodes: MinimizedChildNode[];
  /** Another child is open, so nodes show as one-line pills that reveal the full card on hover. */
  compact?: boolean;
  onOpen: (documentId: string) => void;
}

/**
 * Minimized side documents and margin notes, drawn as map nodes in the empty space beside their
 * document, each joined to its passage by the same curve an open side document gets. A node's own
 * children branch off to its right, like Map view's left-to-right tree. While another child is open
 * they shrink to one-line pills. Clicking one opens it.
 */
export default function MinimizedChildNodes({ nodes, compact = false, onOpen }: Props) {
  const size = SIZES[compact ? "compact" : "full"];
  function renderLevel(items: MinimizedChildNode[], parentId?: string) {
    return <ol>
      {items.map(({ document: item, children }) => {
        const note = isCompactDocument(item) || Boolean(item.document?.marginNote);
        const title = item.title || "Untitled document";
        const label = `${note ? "Open margin note" : "Open side document"}: ${title}`;
        const quote = item.branchAnchor?.quote?.trim();
        const preview = note && quote ? "" : getDocumentPreview(item, 90);
        const icon = note ? <svg viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"><path d="M3 2.5h10v8l-3 3H3z M10 13.5v-3h3 M5.5 6h5 M5.5 8.5h3"/></svg>
          : <svg viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"><path d="M9.5 2H3.5v12h9V5z M9.5 2v3h3 M5.5 8h5 M5.5 10.5h5"/></svg>;
        const card = <>
          <span className="minimized-child-node-kind">{icon}{note ? "Margin note" : "Side document"}</span>
          <strong>{title}</strong>
          {note && quote ? <q>{quote}</q> : preview && preview !== title ? <span className="minimized-child-node-preview">{preview}</span> : null}
        </>;
        return <li key={item.id} className={note ? "is-margin-note" : "is-side-document"}>
          <button type="button" className="document-side-restore minimized-child-node" aria-label={label} title={label}
            data-minimized-node-id={item.id} data-minimized-node-parent={parentId} onClick={() => onOpen(item.id)}>
            {compact ? <>
              {icon}
              <strong>{title}</strong>
              <span className="minimized-child-node-card" aria-hidden="true">{card}</span>
            </> : card}
          </button>
          {children.length ? renderLevel(children, item.id) : null}
        </li>;
      })}
    </ol>;
  }
  return <nav className={`minimized-child-nodes${compact ? " is-compact" : ""}`} aria-label="Minimized side documents"
    style={{ "--minimized-node-width": `${size.node}px`, "--minimized-level-gap": `${size.level}px`, "--minimized-leading-gap": `${size.leading}px` } as CSSProperties}>
    {renderLevel(nodes)}
  </nav>;
}
