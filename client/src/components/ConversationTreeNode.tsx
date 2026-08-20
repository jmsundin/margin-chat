import type { Conversation } from "../types";
import { excerpt } from "../lib/tree";

interface ConversationTreeNodeProps {
  conversation: Conversation;
  onExpand: (conversationId: string) => void;
  registerNodeRef: (
    conversationId: string,
    element: HTMLButtonElement | null,
  ) => void;
}

function BranchIcon() {
  return (
    <svg
      aria-hidden="true"
      className="conversation-tree-node-icon"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.8"
      viewBox="0 0 24 24"
    >
      <circle cx="6" cy="5" r="2" />
      <circle cx="18" cy="7" r="2" />
      <circle cx="18" cy="17" r="2" />
      <path d="M8 5h2a4 4 0 0 1 4 4v4a4 4 0 0 0 4 4" />
      <path d="M14 10a4 4 0 0 1 4-3" />
    </svg>
  );
}

export default function ConversationTreeNode({
  conversation,
  onExpand,
  registerNodeRef,
}: ConversationTreeNodeProps) {
  const sourceQuote = conversation.branchAnchor?.quote;
  const messageLabel = `${conversation.messages.length} message${
    conversation.messages.length === 1 ? "" : "s"
  }`;
  const childLabel = conversation.childIds.length
    ? `${conversation.childIds.length} child${
        conversation.childIds.length === 1 ? "" : "ren"
      }`
    : "No children";

  return (
    <button
      aria-label={`Expand ${conversation.title}`}
      className="conversation-tree-node"
      data-conversation-tree-node={conversation.id}
      onClick={() => onExpand(conversation.id)}
      ref={(element) => registerNodeRef(conversation.id, element)}
      type="button"
    >
      <span aria-hidden="true" className="conversation-tree-node-anchor" />
      <span className="conversation-tree-node-head">
        <span className="conversation-tree-node-kicker">
          <BranchIcon />
          Margin Chat
        </span>
        <span aria-hidden="true" className="conversation-tree-node-expand">
          Expand ↗
        </span>
      </span>
      <strong>{conversation.title}</strong>
      <span className="conversation-tree-node-origin">
        {sourceQuote ? `“${excerpt(sourceQuote, 88)}”` : "Started from this chat"}
      </span>
      <span className="conversation-tree-node-meta">
        <span>{messageLabel}</span>
        <span aria-hidden="true">·</span>
        <span>{childLabel}</span>
      </span>
    </button>
  );
}
