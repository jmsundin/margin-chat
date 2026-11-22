import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { WorkspaceSession } from "../types";
import { usePickerDialog } from "../lib/usePickerDialog";
import "./GroupPickerModal.css";

interface SpacePickerModalProps {
  isOpen: boolean;
  documentTitle: string;
  /** Every space, in its fixed order. */
  spaces: WorkspaceSession[];
  isIn: (spaceId: string) => boolean;
  onToggle: (spaceId: string) => void;
  /** Makes a new space holding this document; an empty name gets an automatic one. */
  onCreate: (name?: string) => void;
  onClose: () => void;
}

type SpaceOption = { key: string; name: string; spaceId: string | null; color?: string; create?: boolean };

/**
 * Pick the spaces a document belongs to. A document can be in several spaces, so a click ticks or
 * unticks one and the dialog stays open; making a new space closes it.
 */
export default function SpacePickerModal({ isOpen, documentTitle, spaces, isIn, onToggle, onCreate, onClose }: SpacePickerModalProps) {
  const [query, setQuery] = useState("");
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const titleId = useId();
  const listId = useId();
  const helpId = useId();
  usePickerDialog(isOpen, dialogRef, inputRef, onClose, () => { setQuery(""); setActiveKey(null); });

  const normalizedQuery = query.trim().toLocaleLowerCase();
  const options: SpaceOption[] = spaces
    .filter((space) => space.name.toLocaleLowerCase().includes(normalizedQuery))
    .map((space) => ({ key: `space:${space.id}`, name: space.name, spaceId: space.id, color: space.color }));
  const newName = query.trim().slice(0, 120);
  if (newName && !spaces.some((space) => space.name.trim().toLocaleLowerCase() === newName.toLocaleLowerCase())) {
    options.push({ key: "create", name: newName, spaceId: null, create: true });
  } else if (!newName) {
    options.push({ key: "create", name: "", spaceId: null, create: true });
  }
  const requestedIndex = options.findIndex((option) => option.key === activeKey);
  const activeIndex = requestedIndex >= 0 ? requestedIndex : 0;
  const activeOption = options[activeIndex];
  const current = spaces.filter((space) => isIn(space.id)).map((space) => space.name);

  useEffect(() => {
    if (isOpen && activeKey) document.getElementById(`${listId}-option-${activeIndex}`)?.scrollIntoView?.({ block: "nearest" });
  }, [activeIndex, activeKey, isOpen, listId]);

  if (!isOpen) return null;

  function choose(option: SpaceOption) {
    if (option.create) {
      onCreate(option.name || undefined);
      onClose();
    } else if (option.spaceId) onToggle(option.spaceId);
  }

  const modal = <div className="group-picker-backdrop" role="presentation"
    onPointerDown={(event) => event.stopPropagation()}
    onMouseDown={(event) => event.stopPropagation()}
    onKeyDown={(event) => event.stopPropagation()}
    onWheel={(event) => event.stopPropagation()}
    onClick={(event) => { event.stopPropagation(); if (event.target === event.currentTarget) onClose(); }}>
    <section ref={dialogRef} className="group-picker-dialog space-picker-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId}>
      <header className="group-picker-header">
        <div>
          <h2 id={titleId}>Add to spaces</h2>
          <p title={documentTitle}>{current.length ? `“${documentTitle}” is in ${current.join(", ")}` : `“${documentTitle}” isn’t in a space yet`}</p>
        </div>
        <button className="group-picker-close" aria-label="Close space picker" onClick={onClose} type="button">
          <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="m6 6 12 12M6 18 18 6" /></svg>
        </button>
      </header>
      <label className="group-picker-search">
        <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 4 4" /></svg>
        <input ref={inputRef} aria-label="Search spaces" role="combobox" aria-autocomplete="list" aria-expanded="true" aria-controls={listId}
          aria-activedescendant={activeOption ? `${listId}-option-${activeIndex}` : undefined} aria-describedby={helpId}
          autoComplete="off" maxLength={120} placeholder="Search or name a new space" value={query}
          onChange={(event) => { setQuery(event.target.value); setActiveKey(null); }}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              if (options.length) setActiveKey(options[(activeIndex + (event.key === "ArrowDown" ? 1 : -1) + options.length) % options.length].key);
            } else if (event.key === "Enter" && !event.nativeEvent.isComposing) {
              event.preventDefault();
              if (activeOption) { setActiveKey(activeOption.key); choose(activeOption); }
            }
          }} />
      </label>
      <div id={listId} className="group-picker-options" role="listbox" aria-label="Spaces" aria-multiselectable="true">
        {options.map((option, index) => {
          const selected = !option.create && !!option.spaceId && isIn(option.spaceId);
          return <button id={`${listId}-option-${index}`} key={option.key} role="option" aria-selected={selected} tabIndex={-1}
            className={`group-picker-option${index === activeIndex ? " is-active" : ""}${option.create ? " is-create" : ""}`}
            onMouseDown={(event) => event.preventDefault()} onMouseMove={() => setActiveKey(option.key)} onClick={() => { setActiveKey(option.key); choose(option); }} type="button">
            <span className={`group-picker-option-icon${option.color ? " has-color" : ""}`} style={option.color ? { backgroundColor: option.color } : undefined} aria-hidden="true">{option.create ? "+" : ""}</span>
            <span className="group-picker-option-copy"><span className="group-picker-option-name">{option.create ? option.name ? `New space “${option.name}”` : "New space with this" : option.name}</span></span>
            {selected ? <span className="group-picker-selected"><span aria-hidden="true">✓</span> Added</span> : null}
          </button>;
        })}
      </div>
      <p className="group-picker-help" id={helpId}>Click a space to add or remove · A document can be in several</p>
    </section>
  </div>;
  return typeof document !== "undefined" ? createPortal(modal, document.body) : modal;
}
