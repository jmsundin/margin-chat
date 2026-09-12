import { useEffect, useRef, useState } from "react";
import { getConversationGroupId } from "../lib/conversationGroups";
import type { ConversationGroup } from "../types";

export function ConversationGroupSelect({
  className = "",
  conversationId,
  groups,
  onAssign,
}: {
  className?: string;
  conversationId: string;
  groups: Record<string, ConversationGroup>;
  onAssign: (conversationId: string, groupId: string | null) => void;
}) {
  const groupId = getConversationGroupId(groups, conversationId) ?? "";

  return (
    <label
      className={["conversation-group-select", className]
        .filter(Boolean)
        .join(" ")}
      onClick={(event) => event.stopPropagation()}
    >
      <span>Group</span>
      <select
        aria-label={`Group for conversation ${conversationId}`}
        onChange={(event) =>
          onAssign(conversationId, event.target.value || null)
        }
        value={groupId}
      >
        <option value="">Ungrouped</option>
        {Object.values(groups).map((group) => (
          <option key={group.id} value={group.id}>
            {group.name}
          </option>
        ))}
      </select>
    </label>
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

  useEffect(() => {
    if (!open || !iconOnly) return;

    function handlePointerDown(event: PointerEvent) {
      if (event.target instanceof Node && !popoverRef.current?.contains(event.target)) {
        setName("");
        setOpen(false);
      }
    }

    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [open, iconOnly]);

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
