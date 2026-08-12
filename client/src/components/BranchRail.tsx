import { useEffect } from "react";
import type { Conversation } from "../types";
import { excerpt, getConversationPath } from "../lib/tree";

interface BranchRailProps {
  activeConversationId: string;
  conversations: Record<string, Conversation>;
  onClose: () => void;
  onSelectConversation: (conversationId: string) => void;
  open: boolean;
  registerTabRef: (
    conversationId: string,
    element: HTMLButtonElement | null,
  ) => void;
  rootId: string;
}

function CloseIcon() {
  return (
    <svg
      aria-hidden="true"
      className="branch-map-close-icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.8"
    >
      <path d="m7 7 10 10" />
      <path d="m17 7-10 10" />
    </svg>
  );
}

function BranchMapNode({
  activeConversationId,
  activePathIds,
  conversation,
  conversations,
  lineage,
  onSelectConversation,
  registerTabRef,
}: {
  activeConversationId: string;
  activePathIds: Set<string>;
  conversation: Conversation;
  conversations: Record<string, Conversation>;
  lineage: Set<string>;
  onSelectConversation: BranchRailProps["onSelectConversation"];
  registerTabRef: BranchRailProps["registerTabRef"];
}) {
  if (lineage.has(conversation.id)) {
    return null;
  }

  const nextLineage = new Set(lineage).add(conversation.id);
  const children = conversation.childIds
    .map((conversationId) => conversations[conversationId])
    .filter((child): child is Conversation => Boolean(child))
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  const isActive = conversation.id === activeConversationId;
  const isOnActivePath = activePathIds.has(conversation.id);
  const sourceQuote = conversation.branchAnchor?.quote;

  return (
    <li className={isOnActivePath ? "branch-map-item is-on-path" : "branch-map-item"}>
      <button
        aria-current={isActive ? "page" : undefined}
        className={isActive ? "branch-map-node is-active" : "branch-map-node"}
        onClick={() => onSelectConversation(conversation.id)}
        ref={(element) => registerTabRef(conversation.id, element)}
        type="button"
      >
        <span aria-hidden="true" className="branch-map-node-dot" />
        <span className="branch-map-node-copy">
          <strong>{conversation.title}</strong>
          {sourceQuote ? <span>“{excerpt(sourceQuote, 52)}”</span> : <span>Main chat</span>}
        </span>
      </button>

      {children.length ? (
        <ol className="branch-map-children">
          {children.map((child) => (
            <BranchMapNode
              activeConversationId={activeConversationId}
              activePathIds={activePathIds}
              conversation={child}
              conversations={conversations}
              key={child.id}
              lineage={nextLineage}
              onSelectConversation={onSelectConversation}
              registerTabRef={registerTabRef}
            />
          ))}
        </ol>
      ) : null}
    </li>
  );
}

export default function BranchRail({
  activeConversationId,
  conversations,
  onClose,
  onSelectConversation,
  open,
  registerTabRef,
  rootId,
}: BranchRailProps) {
  const rootConversation = conversations[rootId];
  const activePathIds = new Set(
    getConversationPath(conversations, activeConversationId).map(
      (conversation) => conversation.id,
    ),
  );
  const conversationCount = rootConversation
    ? Object.values(conversations).filter(
        (conversation) =>
          getConversationPath(conversations, conversation.id)[0]?.id === rootId,
      ).length
    : 0;

  useEffect(() => {
    if (!open) {
      return undefined;
    }

    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onClose();
      }
    }

    document.addEventListener("keydown", closeOnEscape);

    return () => {
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [onClose, open]);

  if (!open || !rootConversation) {
    return null;
  }

  return (
    <>
      <button
        aria-label="Close conversation map"
        className="branch-map-backdrop"
        onClick={onClose}
        type="button"
      />
      <aside
        aria-label="Conversation map"
        className="branch-map"
        data-testid="branch-rail"
        id="branch-navigation-map"
      >
        <div className="branch-map-head">
          <div>
            <p className="eyebrow">Overview</p>
            <h2>Conversation map</h2>
          </div>
          <button
            aria-label="Hide conversation map"
            className="branch-map-close"
            onClick={onClose}
            type="button"
          >
            <CloseIcon />
          </button>
        </div>
        <p className="branch-map-count">
          {conversationCount} chat{conversationCount === 1 ? "" : "s"} in this discussion
        </p>
        <nav aria-label="Chats in this discussion" className="branch-map-tree">
          <ol>
            <BranchMapNode
              activeConversationId={activeConversationId}
              activePathIds={activePathIds}
              conversation={rootConversation}
              conversations={conversations}
              lineage={new Set()}
              onSelectConversation={onSelectConversation}
              registerTabRef={registerTabRef}
            />
          </ol>
        </nav>
      </aside>
    </>
  );
}
