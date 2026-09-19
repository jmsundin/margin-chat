import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ConversationGroup } from "../types";
import "./GroupPickerModal.css";

export interface GroupPickerSuggestion {
  name: string;
  groupId?: string | null;
}

interface GroupPickerModalProps {
  isOpen: boolean;
  groups: Record<string, ConversationGroup>;
  currentGroupId: string | null;
  suggestion?: GroupPickerSuggestion | null;
  isSuggesting?: boolean;
  status?: string;
  onSelect: (groupId: string | null) => void;
  onCreate?: (name: string) => void;
  onClose: () => void;
}

type GroupOption = {
  key: string;
  name: string;
  groupId: string | null;
  color?: string;
  create?: boolean;
  suggested?: boolean;
};

function suggestionStatus(status?: string, isSuggesting?: boolean) {
  if (isSuggesting || status === "loading" || status === "checking") return "Finding a suggested group…";
  if (status === "off") return "Suggestions are off. You can choose a group below.";
  if (status === "unconfigured") return "Group suggestions aren’t set up yet. You can choose a group below.";
  if (status === "unavailable") return "Suggestions are unavailable right now. You can still choose a group.";
  if (status === "paused") return "Suggestions will resume after the current reply.";
  return null;
}

export default function GroupPickerModal({
  isOpen, groups, currentGroupId, suggestion, isSuggesting, status, onSelect, onCreate, onClose,
}: GroupPickerModalProps) {
  const [query, setQuery] = useState("");
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const titleId = useId();
  const listId = useId();
  const helpId = useId();

  useEffect(() => {
    if (!isOpen) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    setQuery("");
    setActiveKey(null);
    inputRef.current?.focus();

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        closeRef.current();
      } else if (event.key === "Tab") {
        const items = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>('button:not([disabled]):not([tabindex="-1"]), input:not([disabled])') ?? []);
        const first = items[0], last = items.at(-1);
        if (!first || !last) return;
        const outside = !dialogRef.current?.contains(document.activeElement);
        if (event.shiftKey && (document.activeElement === first || outside)) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && (document.activeElement === last || outside)) {
          event.preventDefault();
          first.focus();
        }
      }
    }
    function keepFocusInside(event: FocusEvent) {
      if (event.target instanceof Node && !dialogRef.current?.contains(event.target)) inputRef.current?.focus();
    }
    document.addEventListener("keydown", handleKeyDown, true);
    document.addEventListener("focusin", keepFocusInside);
    return () => {
      document.removeEventListener("keydown", handleKeyDown, true);
      document.removeEventListener("focusin", keepFocusInside);
      document.body.style.overflow = previousOverflow;
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, [isOpen]);

  const normalizedQuery = query.trim().toLocaleLowerCase();
  const orderedGroups = Object.values(groups).sort((a, b) => a.name.localeCompare(b.name));
  const matches = (name: string) => name.toLocaleLowerCase().includes(normalizedQuery);
  const suggestedName = suggestion?.name.trim() ?? "";
  const suggestedGroup = (suggestion?.groupId ? groups[suggestion.groupId] : undefined)
    ?? orderedGroups.find((group) => group.name.trim().toLocaleLowerCase() === suggestedName.toLocaleLowerCase());
  const suggestedOption: GroupOption | null = suggestedName && (suggestedGroup || onCreate) ? {
    key: suggestedGroup ? `group:${suggestedGroup.id}` : `create:${suggestedName.toLocaleLowerCase()}`,
    name: suggestedGroup?.name ?? suggestedName,
    groupId: suggestedGroup?.id ?? null,
    color: suggestedGroup?.color,
    create: !suggestedGroup,
    suggested: true,
  } : null;
  const showSuggestion = suggestedOption && matches(suggestedOption.name);
  const options: GroupOption[] = [
    ...(showSuggestion ? [suggestedOption] : []),
    ...(matches("Ungrouped") ? [{ key: "ungrouped", name: "Ungrouped", groupId: null }] : []),
    ...orderedGroups.filter((group) => matches(group.name) && (!showSuggestion || group.id !== suggestedGroup?.id)).map((group) => ({ key: `group:${group.id}`, name: group.name, groupId: group.id, color: group.color })),
  ];
  const newName = query.trim().slice(0, 48);
  if (onCreate && newName && !orderedGroups.some((group) => group.name.trim().toLocaleLowerCase() === newName.toLocaleLowerCase()) && !options.some((option) => option.create && option.name.toLocaleLowerCase() === newName.toLocaleLowerCase())) {
    options.push({ key: `create:${newName.toLocaleLowerCase()}`, name: newName, groupId: null, create: true });
  }
  const selectedIndex = options.findIndex((option) => !option.create && option.groupId === currentGroupId);
  const requestedIndex = options.findIndex((option) => option.key === activeKey);
  const activeIndex = requestedIndex >= 0 ? requestedIndex : normalizedQuery ? 0 : Math.max(0, selectedIndex);
  const activeOption = options[activeIndex];
  const statusCopy = suggestionStatus(status, isSuggesting);

  useEffect(() => {
    if (isOpen && activeKey) document.getElementById(`${listId}-option-${activeIndex}`)?.scrollIntoView?.({ block: "nearest" });
  }, [activeIndex, activeKey, isOpen, listId]);

  if (!isOpen) return null;

  function choose(option: GroupOption) {
    if (option.create) onCreate?.(option.name);
    else onSelect(option.groupId);
    onClose();
  }

  const modal = <div className="group-picker-backdrop" role="presentation"
    onPointerDown={(event) => event.stopPropagation()}
    onMouseDown={(event) => event.stopPropagation()}
    onKeyDown={(event) => event.stopPropagation()}
    onWheel={(event) => event.stopPropagation()}
    onClick={(event) => { event.stopPropagation(); if (event.target === event.currentTarget) onClose(); }}>
    <section ref={dialogRef} className="group-picker-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId}>
      <header className="group-picker-header">
        <div><h2 id={titleId}>Choose a group</h2><p>Current: {currentGroupId ? groups[currentGroupId]?.name ?? "Ungrouped" : "Ungrouped"}</p></div>
        <button className="group-picker-close" aria-label="Close group picker" onClick={onClose} type="button">
          <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="m6 6 12 12M6 18 18 6" /></svg>
        </button>
      </header>
      <label className="group-picker-search">
        <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 4 4" /></svg>
        <input ref={inputRef} aria-label="Search groups" role="combobox" aria-autocomplete="list" aria-expanded="true" aria-controls={listId}
          aria-activedescendant={activeOption ? `${listId}-option-${activeIndex}` : undefined} aria-describedby={helpId}
          autoComplete="off" maxLength={48} placeholder={onCreate ? "Search or create a group" : "Search groups"} value={query}
          onChange={(event) => { setQuery(event.target.value); setActiveKey(null); }}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              if (options.length) setActiveKey(options[(activeIndex + (event.key === "ArrowDown" ? 1 : -1) + options.length) % options.length].key);
            } else if (event.key === "Enter" && !event.nativeEvent.isComposing) {
              event.preventDefault();
              if (activeOption) choose(activeOption);
            }
          }} />
      </label>
      {statusCopy && !suggestedOption ? <p className="group-picker-status" role="status">{statusCopy}</p> : null}
      <div id={listId} className="group-picker-options" role="listbox" aria-label="Groups">
        {options.map((option, index) => {
          const selected = !option.create && option.groupId === currentGroupId;
          return <button id={`${listId}-option-${index}`} key={option.key} role="option" aria-selected={selected} tabIndex={-1}
            className={`group-picker-option${index === activeIndex ? " is-active" : ""}${option.suggested ? " is-suggested" : ""}`}
            onMouseDown={(event) => event.preventDefault()} onMouseMove={() => setActiveKey(option.key)} onClick={() => choose(option)} type="button">
            <span className={`group-picker-option-icon${option.color ? " has-color" : ""}`} style={option.color ? { backgroundColor: option.color } : undefined} aria-hidden="true">{option.color ? "" : option.create ? "+" : "−"}</span>
            <span className="group-picker-option-copy"><span className="group-picker-option-name">{option.create ? `Create “${option.name}”` : option.name}</span>{option.suggested ? <span className="group-picker-suggestion-label">Suggested by Jev</span> : null}</span>
            {selected ? <span className="group-picker-selected"><span aria-hidden="true">✓</span> Selected</span> : null}
          </button>;
        })}
      </div>
      {!options.length ? <p className="group-picker-empty" role="status">No matching groups. Try another name.</p> : null}
      <p className="group-picker-help" id={helpId}>↑ ↓ to browse · Enter to choose · Esc to close</p>
    </section>
  </div>;
  return typeof document !== "undefined" ? createPortal(modal, document.body) : modal;
}
