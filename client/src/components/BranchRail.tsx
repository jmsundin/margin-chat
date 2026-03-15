import type { Conversation } from "../types";
import { excerpt } from "../lib/tree";

interface BranchRailProps {
  branches: Conversation[];
  isRootActive: boolean;
  onSelectConversation: (conversationId: string) => void;
  onSelectRoot: () => void;
  onToggle: () => void;
  open: boolean;
  rootTitle: string;
  registerTabRef: (
    conversationId: string,
    element: HTMLButtonElement | null,
  ) => void;
}

function RailToggleIcon({ open }: { open: boolean }) {
  return (
    <svg
      aria-hidden="true"
      className={open ? "rail-toggle-icon" : "rail-toggle-icon is-collapsed"}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.8"
    >
      <path d="M17 5v14" />
      <path d="m7 6 6 6-6 6" />
    </svg>
  );
}

export default function BranchRail({
  branches,
  isRootActive,
  onSelectConversation,
  onSelectRoot,
  onToggle,
  open,
  rootTitle,
  registerTabRef,
}: BranchRailProps) {
  return (
    <aside className={open ? "app-rail is-open" : "app-rail"}>
      <div className="rail-body">
        <div className="rail-head">
          <div className="rail-head-copy">
            <p className="eyebrow">Right rail</p>
            <h2>Child branches</h2>
          </div>
          <button
            aria-expanded={open}
            aria-label={open ? "Minimize child branches panel" : "Expand child branches panel"}
            className={open ? "rail-minimize-button" : "rail-minimize-button is-collapsed"}
            onClick={onToggle}
            type="button"
          >
            <RailToggleIcon open={open} />
          </button>
        </div>
        <p className="rail-count">{branches.length} direct branches</p>

        {open ? (
          <button
            className={isRootActive ? "main-thread-button is-active" : "main-thread-button"}
            onClick={onSelectRoot}
            type="button"
          >
            <span>{rootTitle}</span>
            <small>Return to this thread&apos;s main chat</small>
          </button>
        ) : null}

        <div className="rail-list">
          {branches.length ? (
            branches.map((branch) => {
              const quote = branch.branchAnchor?.quote ?? "";
              const prompt = branch.branchAnchor?.prompt ?? "";

              return (
                <button
                  key={branch.id}
                  ref={(element) => registerTabRef(branch.id, element)}
                  className="rail-tab"
                  onClick={() => onSelectConversation(branch.id)}
                  type="button"
                >
                  <span className="rail-tab-dot" aria-hidden="true" />
                  <span className="rail-tab-card">
                    <span className="rail-tab-title">{branch.title}</span>
                    {quote ? (
                      <span className="rail-tab-quote">“{excerpt(quote, 72)}”</span>
                    ) : null}
                    {prompt ? (
                      <span className="rail-tab-prompt">{excerpt(prompt, 78)}</span>
                    ) : null}
                  </span>
                </button>
              );
            })
          ) : open ? (
            <p className="rail-empty">
              This chat does not have child branches yet. Highlight text in the
              focused chat to create one.
            </p>
          ) : null}
        </div>
      </div>
    </aside>
  );
}
