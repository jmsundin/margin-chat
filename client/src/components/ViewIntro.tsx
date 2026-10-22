import { useState, type ReactNode } from "react";
import "./ViewIntro.css";

const storageKey = (id: string) => `margin-chat:view-intro:${id}`;

function isDismissed(id: string) {
  try { return localStorage.getItem(storageKey(id)) === "dismissed"; }
  catch { return false; }
}

/** A short "what this view is" card for a nearly empty vault; × hides it for good on this device. */
export default function ViewIntro({ id, title, children, className = "" }: { id: string; title: string; children: ReactNode; className?: string }) {
  const [dismissed, setDismissed] = useState(() => isDismissed(id));
  if (dismissed) return null;
  const dismiss = () => {
    try { localStorage.setItem(storageKey(id), "dismissed"); }
    catch { /* Without storage the card hides until the next visit. */ }
    setDismissed(true);
  };
  return <aside className={`view-intro ${className}`.trim()} aria-label={title} data-graph-ui="true">
    <div className="view-intro-text"><strong>{title}</strong><p>{children}</p></div>
    <button type="button" className="view-intro-close" aria-label={`Hide “${title}”`} title="Got it" onClick={dismiss}>×</button>
  </aside>;
}
