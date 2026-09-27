import { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Conversation } from "../types";
import { summarizeAnnotationText } from "../lib/annotationPreview";
import { getEditableDocumentText } from "../lib/editableDocument";
import "./PinnedDocumentPreview.css";

interface PinnedDocumentPreviewProps {
  id: string;
  conversation: Conversation;
  anchor: HTMLElement;
  familyPinned: boolean;
  onPointerEnter: () => void;
  onPointerLeave: () => void;
}

/** A preview of the current document, including edits made after AI generation. */
export default function PinnedDocumentPreview({ id, conversation, anchor, familyPinned, onPointerEnter, onPointerLeave }: PinnedDocumentPreviewProps) {
  const card = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: 8, top: 8 });
  const content = summarizeAnnotationText(getEditableDocumentText(conversation), 280);

  useLayoutEffect(() => {
    function reposition() {
      const bounds = anchor.getBoundingClientRect();
      const width = card.current?.offsetWidth || 300;
      const height = card.current?.offsetHeight || 180;
      setPosition({
        left: Math.max(8, Math.min(bounds.left, window.innerWidth - width - 8)),
        top: bounds.bottom + height + 8 <= window.innerHeight
          ? bounds.bottom + 6 : Math.max(8, bounds.top - height - 6),
      });
    }
    reposition();
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);
    return () => {
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);
    };
  }, [anchor, content, conversation.title]);

  return createPortal(<div ref={card} id={id} role="tooltip" className="pinned-document-preview"
    data-preview-document-id={conversation.id} style={position}
    onPointerEnter={onPointerEnter} onPointerLeave={onPointerLeave}>
    <strong className="pinned-document-preview-title">{conversation.title || "Untitled document"}</strong>
    <span className="pinned-document-preview-scope">{familyPinned ? "Pinned with this document family" : "Pinned across documents"}</span>
    <p className="pinned-document-preview-content">{content || "Empty document"}</p>
    <span className="pinned-document-preview-hint">Right-click for document options</span>
  </div>, document.body);
}
