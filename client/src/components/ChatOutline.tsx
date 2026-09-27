import type { ChatOutlineItem } from "../lib/chatOutline";
import "./ChatOutline.css";

interface ChatOutlineProps {
  items: ChatOutlineItem[];
  activeItemId: string | null;
  onSelect: (itemId: string) => void;
}

export default function ChatOutline({ items, activeItemId, onSelect }: ChatOutlineProps) {
  const headings = items.filter((item) => item.kind === "heading");
  // The reader also reports paragraph and prompt targets. Keep the preceding
  // content heading active when those internal navigation targets are visible.
  const activeIndex = items.findIndex((item) => item.id === activeItemId);
  const activeHeadingId = items.slice(0, activeIndex + 1).reverse().find((item) => item.kind === "heading")?.id;

  if (!headings.length) return <p className="chat-outline-empty">Add headings to your document to see its outline.</p>;

  return <div className="document-content-outline">
    <ol className="outline-headings">
      {headings.map((item) => <li className={`outline-heading-level-${item.level}`} key={item.id}>
        <button aria-current={item.id === activeHeadingId ? "location" : undefined}
          className={`outline-heading-link${item.id === activeHeadingId ? " is-active" : ""}`}
          onClick={() => onSelect(item.id)} title={item.label} type="button">
          <span className="outline-heading-dot" aria-hidden="true" /><span>{item.label}</span>
        </button>
      </li>)}
    </ol>
  </div>;
}
