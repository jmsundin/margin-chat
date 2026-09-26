import { createContext, useContext, useRef, useState } from "react";
import { useOutsideDismiss } from "../lib/useOutsideDismiss";
import GroupPickerModal, { type GroupPickerSuggestion } from "./GroupPickerModal";
import { getConversationGroupId } from "../lib/conversationGroups";
import type { ConversationGroup } from "../types";

export interface ConversationGroupPickerContextValue {
  getSuggestion?: (conversationId: string) => GroupPickerSuggestion | null;
  isSuggesting?: boolean;
  status?: string;
  onCreateAndAssign?: (conversationId: string, name: string) => void;
}

export const ConversationGroupPickerContext = createContext<ConversationGroupPickerContextValue>({});

export function ConversationGroupSelect({
  className = "",
  conversationId,
  groups,
  onAssign,
  getSuggestion,
  isSuggesting,
  status,
  onCreateAndAssign,
}: {
  className?: string;
  conversationId: string;
  groups: Record<string, ConversationGroup>;
  onAssign: (conversationId: string, groupId: string | null) => void;
} & ConversationGroupPickerContextValue) {
  const [open, setOpen] = useState(false);
  const context = useContext(ConversationGroupPickerContext);
  const groupId = getConversationGroupId(groups, conversationId);
  const groupName = groupId ? groups[groupId].name : "Ungrouped";
  const suggestion = (getSuggestion ?? context.getSuggestion)?.(conversationId) ?? null;
  const createAndAssign = onCreateAndAssign ?? context.onCreateAndAssign;

  return (
    <div className={["conversation-group-select", className].filter(Boolean).join(" ")}
      onPointerDown={(event) => event.stopPropagation()}
      onMouseDown={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}>
      <span>Group</span>
      <button className="conversation-group-trigger" aria-label={`Group for conversation ${conversationId}: ${groupName}`}
        aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(true)} title={`Group: ${groupName}`} type="button">
        <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><path d="M3 7V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" /></svg>
        <span>{groupName}</span>
        <svg aria-hidden="true" className="conversation-group-trigger-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="m6 9 6 6 6-6" /></svg>
      </button>
      <GroupPickerModal isOpen={open} groups={groups} currentGroupId={groupId} suggestion={suggestion}
        isSuggesting={isSuggesting ?? context.isSuggesting} status={status ?? context.status}
        onSelect={(nextGroupId) => onAssign(conversationId, nextGroupId)}
        onCreate={createAndAssign ? (name) => createAndAssign(conversationId, name) : undefined}
        onClose={() => setOpen(false)} />
    </div>
  );
}

export function NewConversationGroupForm({
  compact = false,
  iconOnly = false,
  onCreate,
}: {
  compact?: boolean;
  iconOnly?: boolean;
  onCreate: (name: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const popoverRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  function closeForm() {
    setName("");
    setOpen(false);
    triggerRef.current?.focus();
  }

  useOutsideDismiss(open && iconOnly, () => {
    setName("");
    setOpen(false);
  }, popoverRef);

  const trigger = (
    <button
      aria-expanded={open}
      aria-label="New group"
      className={
        iconOnly
          ? "sidebar-tool-button"
          : compact
            ? "conversation-group-create-trigger is-compact"
            : "conversation-group-create-trigger"
      }
      onClick={() => (open ? closeForm() : setOpen(true))}
      ref={triggerRef}
      title="New group"
      type="button"
    >
      {iconOnly ? (
        <svg
          aria-hidden="true"
          className="sidebar-icon"
          fill="none"
          stroke="currentColor"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="1.7"
          viewBox="0 0 24 24"
        >
          <path d="M3 7V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" />
          <path d="M9 13h6m-3-3v6" />
        </svg>
      ) : (
        <>
          <span aria-hidden="true">＋</span>
          <span>New group</span>
        </>
      )}
    </button>
  );

  const form = (
    <form
      aria-label="Create a new group"
      className={
        compact
          ? "conversation-group-create-form is-compact"
          : "conversation-group-create-form"
      }
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          closeForm();
        }
      }}
      onSubmit={(event) => {
        event.preventDefault();
        const nextName = name.trim();

        if (!nextName) {
          return;
        }

        onCreate(nextName);
        closeForm();
      }}
    >
      <input
        aria-label="Group name"
        autoFocus
        maxLength={48}
        onChange={(event) => setName(event.target.value)}
        placeholder="Group name"
        value={name}
      />
      <button disabled={!name.trim()} type="submit">
        Add
      </button>
      <button
        aria-label="Cancel creating group"
        onClick={closeForm}
        type="button"
      >
        ×
      </button>
    </form>
  );

  if (iconOnly) {
    return (
      <div className="conversation-group-create-popover" ref={popoverRef}>
        {trigger}
        {open ? form : null}
      </div>
    );
  }

  return open ? form : trigger;
}
