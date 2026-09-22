import type { Conversation } from "../types";
import type { JevStatus } from "../lib/jevAssistance";

export default function JevRelatedItems({ status, related, conversations, currentId, onSelect, warning }: {
  status: JevStatus;
  related: Array<{ id: string; score: number }>;
  conversations: Record<string, Conversation>;
  currentId: string;
  onSelect: (id: string) => void;
  warning?: string;
}) {
  if (status !== "ready") return null;
  const items = related.filter((item) => item.id !== currentId && conversations[item.id]).slice(0, 5);
  if (!items.length) return null;
  return <aside className="jev-related" aria-label="Related notes and chats">
    <span className="jev-related-label">Related</span>
    <div className="jev-related-items">{items.map(({ id }) => <button key={id} type="button" onClick={() => onSelect(id)} title={conversations[id].title}>
      <span>{conversations[id].kind === "note" ? "Note" : "Chat"}</span>{conversations[id].title}
    </button>)}</div>
    {warning ? <p role="status">{warning}</p> : null}
  </aside>;
}
