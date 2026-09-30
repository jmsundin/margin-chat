import { useId, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import "./MobileAIComposer.css";

export interface MobileAIComposerProps {
  prompt: string;
  onPromptChange: (value: string) => void;
  onSubmit: () => void;
  onClose: () => void;
  quote?: string;
  contextLabel?: string;
  disabled?: boolean;
  textareaId?: string;
  promptLabel?: string;
  placeholder?: string;
  initiallyOpenOptions?: boolean;
  testId?: string;
  options: ReactNode;
  formRef?: RefObject<HTMLFormElement | null>;
  textareaRef?: RefObject<HTMLTextAreaElement | null>;
  className?: string;
}

/** A small, native text-entry dock; secondary controls only open on request. */
export default function MobileAIComposer({
  prompt, onPromptChange, onSubmit, onClose, quote, contextLabel,
  disabled = false, textareaId, promptLabel = "AI prompt", placeholder = "Ask Margin…",
  options, formRef, textareaRef, className = "", initiallyOpenOptions = false, testId,
}: MobileAIComposerProps) {
  const localTextareaRef = useRef<HTMLTextAreaElement>(null);
  const inputRef = textareaRef ?? localTextareaRef;
  const [expanded, setExpanded] = useState<"quote" | "options" | null>(initiallyOpenOptions ? "options" : null);
  const contextId = useId();
  const optionsId = useId();
  const label = contextLabel ?? (quote ? "Selected text" : "This block");

  useLayoutEffect(() => {
    const textarea = inputRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    textarea.style.height = `${Math.max(40, Math.min(textarea.scrollHeight, 88))}px`;
  }, [prompt, inputRef]);

  function submit() {
    if (disabled || !prompt.trim()) return;
    inputRef.current?.blur();
    onSubmit();
  }

  const context = <>
    <svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
      <path d="M5 2h6l4 4v12H5zM11 2v4h4M8 10h4M8 13h4" />
    </svg>
    <span>{label}</span>
    {quote ? <span className="mobile-ai-context-chevron" aria-hidden="true">{expanded === "quote" ? "⌃" : "⌄"}</span> : null}
  </>;

  return <form ref={formRef} className={`mobile-ai-composer ${className}`.trim()} aria-label="Ask AI" data-testid={testId}
    onSubmit={(event) => { event.preventDefault(); submit(); }}
    onKeyDown={(event) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      if (expanded) setExpanded(null);
      else onClose();
    }}>
    <div className="mobile-ai-context-row">
      {quote ? <button className="mobile-ai-context" type="button" aria-label={expanded === "quote" ? "Hide selected text" : "Show selected text"}
        aria-expanded={expanded === "quote"} aria-controls={contextId}
        onClick={() => setExpanded(expanded === "quote" ? null : "quote")}>{context}</button>
        : <span className="mobile-ai-context">{context}</span>}
      <button className="mobile-ai-icon" type="button" aria-label="Prompt options" aria-expanded={expanded === "options"} aria-controls={optionsId}
        onClick={() => setExpanded(expanded === "options" ? null : "options")}>
        <svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/></svg>
      </button>
      <button className="mobile-ai-icon" type="button" aria-label="Close AI prompt" onClick={onClose}>
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true"><path d="m7 7 10 10M7 17 17 7"/></svg>
      </button>
    </div>
    {expanded === "quote" && quote ? <blockquote id={contextId} className="mobile-ai-quote">{quote}</blockquote> : null}
    {expanded === "options" ? <div id={optionsId} className="mobile-ai-options" role="region" aria-label="Prompt options">{options}</div> : null}
    <div className="mobile-ai-entry">
      <textarea ref={inputRef} id={textareaId} aria-label={promptLabel} placeholder={placeholder} value={prompt} inputMode="text" rows={1}
        onFocus={() => setExpanded(null)} onChange={(event) => onPromptChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229) {
            event.preventDefault();
            submit();
          }
        }}/>
      <button className="mobile-ai-send" type="submit" aria-label="Generate response" disabled={disabled || !prompt.trim()}>
        <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 19V5m-6 6 6-6 6 6"/></svg>
      </button>
    </div>
  </form>;
}
