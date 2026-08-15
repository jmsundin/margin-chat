import { useState } from "react";
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
  onCreate,
}: {
  compact?: boolean;
  onCreate: (name: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");

  if (!open) {
    return (
      <button
        className={
          compact
            ? "conversation-group-create-trigger is-compact"
            : "conversation-group-create-trigger"
        }
        onClick={() => setOpen(true)}
        type="button"
      >
        <span aria-hidden="true">＋</span>
        <span>New group</span>
      </button>
    );
  }

  return (
    <form
      className={
        compact
          ? "conversation-group-create-form is-compact"
          : "conversation-group-create-form"
      }
      onSubmit={(event) => {
        event.preventDefault();
        const nextName = name.trim();

        if (!nextName) {
          return;
        }

        onCreate(nextName);
        setName("");
        setOpen(false);
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
        onClick={() => {
          setName("");
          setOpen(false);
        }}
        type="button"
      >
        ×
      </button>
    </form>
  );
}
