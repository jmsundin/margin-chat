import { useEffect, useRef, useState } from "react";
import "./WriteBackLine.css";

/**
 * "Write back…": a reply line under a paragraph the AI wrote, opened by clicking or tapping the
 * paragraph, so answering it needs no text selection. Enter sends; Escape or Dismiss closes.
 */
export default function WriteBackLine({ onSend, onClose, disabled = false, autoFocus = true, dismissible = true }: {
  onSend: (text: string) => void; onClose: () => void; disabled?: boolean;
  /** Off in a card that opens on a tap, so the keyboard waits until the line is tapped. */
  autoFocus?: boolean;
  /** Off where the surrounding card has its own close button. */
  dismissible?: boolean;
}) {
  const [text, setText] = useState("");
  const inputRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { if (autoFocus) inputRef.current?.focus({ preventScroll: true }); }, [autoFocus]);
  function send() {
    const reply = text.trim();
    if (!reply || disabled) return;
    onSend(reply);
    setText("");
  }
  return <div className="write-back" data-write-back onMouseDown={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()}>
    <div className="write-back-row">
      <textarea ref={inputRef} className="write-back-input" rows={1} value={text} placeholder="Write back…" aria-label="Write back to the AI"
        onChange={(event) => { setText(event.target.value); event.target.style.height = "auto"; event.target.style.height = `${event.target.scrollHeight}px`; }}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); send(); }
          else if (event.key === "Escape") { event.preventDefault(); onClose(); }
        }} />
      <button type="button" className="write-back-send" aria-label="Send" title="Send (Enter)" disabled={!text.trim() || disabled} onClick={send}>
        <svg viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M2.5 8 13.5 2.5 10 13.5 7.5 8.5z" /><path d="M7.5 8.5 13.5 2.5" /></svg>
      </button>
    </div>
    {dismissible ? <div className="write-back-actions"><button type="button" onClick={onClose}>Dismiss</button></div> : null}
  </div>;
}
