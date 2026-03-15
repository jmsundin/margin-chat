import { useEffect, useRef } from "react";

export interface ChatSearchResult {
  conversationId: string;
  locationLabel: string;
  matchLabel: string;
  preview: string;
  rootTitle: string;
  title: string;
  updatedLabel: string;
}

interface SearchModalProps {
  isOpen: boolean;
  onClose: () => void;
  onQueryChange: (value: string) => void;
  onSelectResult: (conversationId: string) => void;
  query: string;
  results: ChatSearchResult[];
}

function CloseIcon() {
  return (
    <svg
      aria-hidden="true"
      className="search-modal-close-icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="2"
    >
      <path d="m7 7 10 10" />
      <path d="m17 7-10 10" />
    </svg>
  );
}

export default function SearchModal({
  isOpen,
  onClose,
  onQueryChange,
  onSelectResult,
  query,
  results,
}: SearchModalProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!isOpen) {
      return undefined;
    }

    inputRef.current?.focus();

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onClose();
      }
    }

    document.addEventListener("keydown", handleKeyDown);

    return () => {
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [isOpen, onClose]);

  if (!isOpen) {
    return null;
  }

  return (
    <div className="search-modal-backdrop" onClick={onClose} role="presentation">
      <section
        aria-label="Search chats"
        className="search-modal"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="search-modal-head">
          <div>
            <p className="eyebrow">Search chats</p>
            <h2>{query.trim() ? "Matching conversations" : "Recent conversations"}</h2>
          </div>

          <button
            aria-label="Close search"
            className="search-modal-close"
            onClick={onClose}
            type="button"
          >
            <CloseIcon />
          </button>
        </div>

        <label className="search-modal-field">
          <span className="search-modal-label">Find by title or message</span>
          <input
            ref={inputRef}
            className="search-modal-input"
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder="Search chats"
            type="search"
            value={query}
          />
        </label>

        <div className="search-modal-results">
          {results.length ? (
            results.map((result) => (
              <button
                key={`${result.conversationId}-${result.matchLabel}-${result.preview}`}
                className="search-result"
                onClick={() => onSelectResult(result.conversationId)}
                type="button"
              >
                <span className="search-result-eyebrow">
                  {result.matchLabel}
                  <span aria-hidden="true">•</span>
                  {result.updatedLabel}
                </span>
                <span className="search-result-title">{result.title}</span>
                <span className="search-result-preview">{result.preview}</span>
                <span className="search-result-location">
                  {result.locationLabel}
                  {result.locationLabel !== result.rootTitle ? (
                    <>
                      <span aria-hidden="true">•</span>
                      {result.rootTitle}
                    </>
                  ) : null}
                </span>
              </button>
            ))
          ) : (
            <div className="search-empty">
              <strong>No chats matched.</strong>
              <p>Try a different title, phrase, or message snippet.</p>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
