import { useLayoutEffect, useRef } from "react";
import type { Conversation } from "../types";
import "./DocumentChildren.css";

interface Props {
  parent: Conversation;
  documents: Conversation[];
  currentDocumentId: string;
  onSelect: (id: string) => void;
}

/** Horizontal tabs above an opened child: its parent's children, with this one selected. */
export default function DocumentSiblingTabs({ parent, documents, currentDocumentId, onSelect }: Props) {
  const strip = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    strip.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [currentDocumentId]);
  if (!documents.length) return null;
  const parentTitle = parent.title || "Untitled document";
  return <div ref={strip} className="document-sibling-tabs" role="tablist" aria-label={`Children of ${parentTitle}`}
    onKeyDown={(event) => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      const tabs = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
      const index = tabs.indexOf(window.document.activeElement as HTMLButtonElement);
      if (index < 0) return;
      event.preventDefault(); event.stopPropagation();
      const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1
        : (index + (event.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length;
      tabs[next]?.focus();
    }}>
    {documents.map((document) => {
      const selected = document.id === currentDocumentId;
      const title = document.title || "Untitled document";
      return <button type="button" role="tab" key={document.id} aria-selected={selected} tabIndex={selected ? 0 : -1}
        className={`document-sibling-tab${selected ? " is-active" : ""}`} title={title}
        onClick={() => { if (!selected) onSelect(document.id); }}>
        <span className="document-sibling-tab-title">{title}</span>
      </button>;
    })}
  </div>;
}
