import { useState } from "react";
import {
  getMainThreadDragData,
  setMainThreadDragData,
} from "../lib/pinnedThreads";
import type { ThreadSummary } from "../types";

type DropIndicator =
  | {
      position: "before" | "after";
      threadId: string;
    }
  | {
      position: "end";
      threadId: null;
    };

interface PinnedThreadTabsProps {
  activeThreadId: string;
  onOpenThread: (conversationId: string) => void;
  onPinThread: (conversationId: string, index: number | null) => void;
  onUnpinThread: (conversationId: string) => void;
  pinnedThreads: ThreadSummary[];
}

function CloseIcon() {
  return (
    <svg
      aria-hidden="true"
      className="pinned-thread-tab-close-icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="2"
    >
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </svg>
  );
}

export default function PinnedThreadTabs({
  activeThreadId,
  onOpenThread,
  onPinThread,
  onUnpinThread,
  pinnedThreads,
}: PinnedThreadTabsProps) {
  const [dropIndicator, setDropIndicator] = useState<DropIndicator | null>(null);

  function handleDragStart(
    event: React.DragEvent<HTMLDivElement>,
    threadId: string,
  ) {
    setMainThreadDragData(event.dataTransfer, threadId);
  }

  function handleStripDragLeave(event: React.DragEvent<HTMLDivElement>) {
    const nextTarget = event.relatedTarget as Node | null;

    if (nextTarget && event.currentTarget.contains(nextTarget)) {
      return;
    }

    setDropIndicator(null);
  }

  function handleStripDragOver(event: React.DragEvent<HTMLDivElement>) {
    const threadId = getMainThreadDragData(event.dataTransfer);

    if (!threadId) {
      return;
    }

    const target = event.target as HTMLElement;

    if (target.closest("[data-pinned-thread-tab='true']")) {
      return;
    }

    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    setDropIndicator({
      position: "end",
      threadId: null,
    });
  }

  function handleStripDrop(event: React.DragEvent<HTMLDivElement>) {
    const threadId = getMainThreadDragData(event.dataTransfer);

    if (!threadId) {
      return;
    }

    const target = event.target as HTMLElement;

    if (target.closest("[data-pinned-thread-tab='true']")) {
      return;
    }

    event.preventDefault();
    onPinThread(threadId, null);
    setDropIndicator(null);
  }

  function handleTabDragOver(
    event: React.DragEvent<HTMLDivElement>,
    targetThreadId: string,
  ) {
    const threadId = getMainThreadDragData(event.dataTransfer);

    if (!threadId) {
      return;
    }

    event.preventDefault();
    event.dataTransfer.dropEffect = "move";

    const rect = event.currentTarget.getBoundingClientRect();
    const position =
      event.clientX - rect.left < rect.width / 2 ? "before" : "after";

    setDropIndicator({
      position,
      threadId: targetThreadId,
    });
  }

  function handleTabDrop(
    event: React.DragEvent<HTMLDivElement>,
    targetThreadId: string,
  ) {
    const threadId = getMainThreadDragData(event.dataTransfer);

    if (!threadId) {
      return;
    }

    event.preventDefault();

    const targetIndex = pinnedThreads.findIndex(
      (thread) => thread.id === targetThreadId,
    );

    if (targetIndex === -1) {
      return;
    }

    const rect = event.currentTarget.getBoundingClientRect();
    const insertAfter = event.clientX - rect.left >= rect.width / 2;

    onPinThread(threadId, insertAfter ? targetIndex + 1 : targetIndex);
    setDropIndicator(null);
  }

  return (
    <section aria-label="Pinned main chat tabs" className="pinned-thread-tabs-shell">
      <div className="pinned-thread-tabs-head">
        <div>
          <p className="eyebrow">Pinned tabs</p>
          <p className="pinned-thread-tabs-copy">
            Drag main chats here to keep a stable multitasking tab row that stays
            separate from recent history.
          </p>
        </div>
      </div>

      <div
        className="pinned-thread-tabs"
        onDragLeave={handleStripDragLeave}
        onDragOver={handleStripDragOver}
        onDrop={handleStripDrop}
      >
        {pinnedThreads.length ? (
          pinnedThreads.map((thread) => {
            const isDropBefore =
              dropIndicator?.position === "before" &&
              dropIndicator.threadId === thread.id;
            const isDropAfter =
              dropIndicator?.position === "after" &&
              dropIndicator.threadId === thread.id;

            return (
              <div
                key={thread.id}
                className={[
                  thread.id === activeThreadId
                    ? "pinned-thread-tab is-active"
                    : "pinned-thread-tab",
                  isDropBefore ? "is-drop-before" : "",
                  isDropAfter ? "is-drop-after" : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
                data-pinned-thread-tab="true"
                draggable
                onDragEnd={() => setDropIndicator(null)}
                onDragOver={(event) => handleTabDragOver(event, thread.id)}
                onDragStart={(event) => handleDragStart(event, thread.id)}
                onDrop={(event) => handleTabDrop(event, thread.id)}
              >
                <button
                  className="pinned-thread-tab-button"
                  onClick={() => onOpenThread(thread.id)}
                  type="button"
                >
                  <span className="pinned-thread-tab-title">{thread.title}</span>
                  <span className="pinned-thread-tab-meta">
                    {thread.updatedLabel}
                  </span>
                </button>

                <button
                  aria-label={`Unpin ${thread.title}`}
                  className="pinned-thread-tab-close"
                  draggable={false}
                  onClick={(event) => {
                    event.stopPropagation();
                    onUnpinThread(thread.id);
                  }}
                  type="button"
                >
                  <CloseIcon />
                </button>
              </div>
            );
          })
        ) : (
          <div
            className={
              dropIndicator?.position === "end"
                ? "pinned-thread-tabs-empty is-drop-target"
                : "pinned-thread-tabs-empty"
            }
          >
            Drag a main chat here from the recent thread list to pin it.
          </div>
        )}

        {dropIndicator?.position === "end" && pinnedThreads.length ? (
          <div aria-hidden="true" className="pinned-thread-tab-drop-slot" />
        ) : null}
      </div>
    </section>
  );
}
