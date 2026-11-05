import { useEffect, useRef } from "react";
import type { WikiLinkSuggestion } from "../lib/wikiLinkSuggestions";
import "./WikiLinkMenu.css";

export interface WikiLinkMenuState {
  /** Where the `[[` starts and the caret is, in the editor's own positions. */
  from: number;
  to: number;
  query: string;
  items: WikiLinkSuggestion[];
  index: number;
  top: number;
  left: number;
  /** Shown above the line when there's no room below it, as with a phone keyboard open. */
  above: boolean;
  /** False until its place under the `[[` is measured. */
  placed: boolean;
}

/** The list that opens after `[[`: document titles, best match first. */
export default function WikiLinkMenu({ menu, onPick, onHover }: {
  menu: WikiLinkMenuState;
  onPick: (item: WikiLinkSuggestion) => void;
  onHover: (index: number) => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [menu.index, menu.items]);
  return <div ref={listRef} className={`wiki-link-menu${menu.above ? " is-above" : ""}`} role="listbox" aria-label="Link to a document"
    style={{ top: menu.top, left: menu.left, visibility: menu.placed ? undefined : "hidden" }}
    // Keeps the caret, and a phone's keyboard, in the document while you pick.
    onPointerDown={(event) => event.preventDefault()} onMouseDown={(event) => event.preventDefault()}>
    {menu.items.length ? menu.items.map((item, index) => <div key={item.id} role="option" aria-selected={index === menu.index}
      className="wiki-link-option" data-wiki-link-option={item.id}
      onPointerMove={() => { if (index !== menu.index) onHover(index); }}
      onClick={() => onPick(item)}>
      <span className="wiki-link-option-title">{item.title}</span>
      {item.detail ? <span className="wiki-link-option-detail">in {item.detail}</span> : null}
    </div>) : <div className="wiki-link-empty">{menu.query.trim() ? "No matching documents" : "Type to search your vault"}</div>}
  </div>;
}
