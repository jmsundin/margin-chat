import { useRef, useState } from "react";
import "./StarterCards.css";

const DISMISSED_KEY = "margin-chat:starter-cards";

function isDismissed() {
  try { return localStorage.getItem(DISMISSED_KEY) === "dismissed"; }
  catch { return false; }
}

interface Props {
  /** Opens Vault & storage, where a folder of notes is connected. */
  onBringNotes: () => void;
  /** Adds the chosen files to the vault. Absent where files can't be added. */
  onAddFiles?: (files: File[]) => void;
  /** Opens the chat-history import. */
  onBringChats?: () => void;
  /** A new, empty document to write or ask in. */
  onNewDocument: () => void;
}

/**
 * Four ways to begin, shown above the page until the person has a document of their own. Each one is a single click to a
 * result; × hides them for good on this device.
 */
export default function StarterCards({ onBringNotes, onAddFiles, onBringChats, onNewDocument }: Props) {
  const [dismissed, setDismissed] = useState(isDismissed);
  const fileRef = useRef<HTMLInputElement>(null);
  if (dismissed) return null;
  const dismiss = () => {
    try { localStorage.setItem(DISMISSED_KEY, "dismissed"); }
    catch { /* Without storage the cards hide until the next visit. */ }
    setDismissed(true);
  };
  const card = (title: string, body: string, onClick: () => void) => <li>
    <button type="button" className="starter-card" onClick={onClick}><strong>{title}</strong><span>{body}</span></button>
  </li>;
  return <section className="starter-cards" aria-label="Ways to start">
    <header>
      <h2>Where would you like to start?</h2>
      <button type="button" className="starter-cards-close" aria-label="Hide these suggestions" title="Hide" onClick={dismiss}>×</button>
    </header>
    <ul>
      {card("Bring my notes", "Connect a folder of Markdown files. An Obsidian vault works.", onBringNotes)}
      {onAddFiles ? card("Read something with me", "Add a PDF, Word file or image, then select a passage to ask about it.", () => fileRef.current?.click()) : null}
      {onBringChats ? card("Bring my chat history", "Turn a ChatGPT export into documents you can keep working in.", onBringChats) : null}
      {card("Just write", "A blank document. Press Space on an empty line to ask AI.", onNewDocument)}
    </ul>
    {onAddFiles ? <input ref={fileRef} type="file" multiple hidden tabIndex={-1} aria-hidden="true"
      onChange={(event) => { const files = [...(event.target.files ?? [])]; event.target.value = ""; if (files.length) onAddFiles(files); }} /> : null}
  </section>;
}
