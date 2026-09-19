import { useState } from "react";
import { groupChatOutline, type ChatOutlineItem } from "../lib/chatOutline";
import "./ChatOutline.css";

interface ChatOutlineProps {
  items: ChatOutlineItem[];
  activeItemId: string | null;
  onSelect: (itemId: string) => void;
}

export default function ChatOutline({ items, activeItemId, onSelect }: ChatOutlineProps) {
  const [collapsedResponses, setCollapsedResponses] = useState<Set<string>>(() => new Set());
  const sections = groupChatOutline(items);
  const responses = sections.flatMap((section) => section.responses);
  const responsesWithHeadings = responses.filter((response) => response.headings.length);
  const allHeadingsCollapsed = responsesWithHeadings.length > 0 && responsesWithHeadings.every(({ item }) => collapsedResponses.has(item.id));

  function toggleResponse(id: string) {
    setCollapsedResponses((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function headingList(headings: ChatOutlineItem[]) {
    return <ol className="outline-response-headings">
      {headings.map((item) => <li className={`outline-heading-level-${item.level}`} key={item.id}>
        <button aria-current={item.id === activeItemId ? "location" : undefined}
          className={`outline-heading-link${item.id === activeItemId ? " is-active" : ""}`}
          onClick={() => onSelect(item.id)} title={item.label} type="button">
          <span className="outline-heading-dot" aria-hidden="true" /><span>{item.label}</span>
        </button>
      </li>)}
    </ol>;
  }

  if (!items.length) return <p className="chat-outline-empty">Send a message to start this outline.</p>;

  let promptNumber = 0;
  return <div className="grouped-chat-outline">
    {responses.length ? <div className="outline-navigation-tools">
      <span>{responses.length} {responses.length === 1 ? "response" : "responses"}</span>
      {responsesWithHeadings.length ? <button type="button" onClick={() => {
        setCollapsedResponses((previous) => {
          const next = new Set(previous);
          for (const { item } of responsesWithHeadings) {
            if (allHeadingsCollapsed) next.delete(item.id);
            else next.add(item.id);
          }
          return next;
        });
      }}>{allHeadingsCollapsed ? "Expand headings" : "Collapse headings"}</button> : null}
    </div> : null}
    <ol className="outline-conversation-sections">
      {sections.map((section) => {
        if (section.prompt) promptNumber += 1;
        const sectionActive = section.prompt?.id === activeItemId || section.headings.some((item) => item.id === activeItemId)
          || section.responses.some(({ item, headings }) => item.id === activeItemId || headings.some((heading) => heading.id === activeItemId));
        return <li key={section.id} className={`outline-conversation-section${sectionActive ? " is-current-section" : ""}`}>
          {section.prompt ? <button className={`outline-prompt-link${section.prompt.id === activeItemId ? " is-active" : ""}`}
            aria-current={section.prompt.id === activeItemId ? "location" : undefined}
            onClick={() => onSelect(section.prompt!.id)} title={section.prompt.label} type="button">
            <span className="outline-prompt-kicker">Prompt {promptNumber}</span><span className="outline-prompt-label">{section.prompt.label}</span>
          </button> : null}
          {section.headings.length ? headingList(section.headings) : null}
          {section.responses.length ? <ol className="outline-responses">
            {section.responses.map(({ item, headings }) => {
              const collapsed = collapsedResponses.has(item.id);
              const responseActive = item.id === activeItemId || headings.some((heading) => heading.id === activeItemId);
              const headingsId = `outline-sections-${item.id}`;
              return <li key={item.id} className={`outline-response${responseActive ? " is-current-response" : ""}`}>
                <div className="outline-response-navigation">
                  <button className={`outline-response-link${item.id === activeItemId ? " is-active" : ""}`}
                    aria-current={item.id === activeItemId ? "location" : undefined}
                    onClick={() => onSelect(item.id)} title={`Jump to ${item.label.toLowerCase()}`} type="button">
                    <svg aria-hidden="true" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M4 4h12v9H9l-4 3v-3H4Z" /></svg>
                    <span>{item.label}</span>
                  </button>
                  {headings.length ? <button className="outline-response-toggle" aria-controls={headingsId} aria-expanded={!collapsed}
                    aria-label={`${collapsed ? "Expand" : "Collapse"} headings for ${item.label.toLowerCase()}`}
                    onClick={() => toggleResponse(item.id)} type="button">
                    <span>{headings.length}</span><svg aria-hidden="true" className={collapsed ? "" : "is-expanded"} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="m7 4 6 6-6 6" /></svg>
                  </button> : null}
                </div>
                {headings.length && !collapsed ? <div id={headingsId}>{headingList(headings)}</div> : null}
              </li>;
            })}
          </ol> : null}
        </li>;
      })}
    </ol>
  </div>;
}
