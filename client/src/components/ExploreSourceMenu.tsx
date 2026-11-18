import { useState, type FormEvent } from "react";
import DismissibleDetails from "./DismissibleDetails";
import { sameSource, type ExploreSource } from "../lib/exploreSources";

const RECENT_KEY = "margin-chat:explore-recent-ai";
function readRecent(): string[] {
  try { const value = JSON.parse(window.localStorage.getItem(RECENT_KEY) ?? "[]"); return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string").slice(0, 5) : []; }
  catch { return []; }
}
function remember(topic: string) {
  try { window.localStorage.setItem(RECENT_KEY, JSON.stringify([topic, ...readRecent().filter((item) => item.toLocaleLowerCase() !== topic.toLocaleLowerCase())].slice(0, 5))); }
  catch { /* Recent topics are a convenience. */ }
}

export const sourceName = (source: ExploreSource) => source.kind === "notes" ? "My notes" : source.kind === "wikipedia" ? "Wikipedia" : source.topic;

/**
 * The first breadcrumb in Explore: where the walk starts. My notes, Wikipedia, or a topic AI
 * splits into sub-topics. Picking the source you are already in goes back to its top.
 */
export default function ExploreSourceMenu({ value, canAsk, onChange, onTop }: {
  value: ExploreSource;
  /** Whether this account can ask AI; without it the AI choice says why it is off. */
  canAsk: boolean;
  onChange: (source: ExploreSource) => void;
  onTop: () => void;
}) {
  const [topic, setTopic] = useState("");
  const [recent, setRecent] = useState(readRecent);
  const close = (element: Element | null) => element?.closest("details")?.removeAttribute("open");
  const pick = (element: Element, source: ExploreSource) => {
    close(element);
    if (sameSource(source, value)) onTop(); else onChange(source);
  };
  const ask = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const wanted = topic.replace(/\s+/gu, " ").trim().slice(0, 200);
    if (!wanted) return;
    remember(wanted); setRecent(readRecent()); setTopic("");
    pick(event.currentTarget, { kind: "ai", topic: wanted });
  };
  return <DismissibleDetails className="explore-source-menu" onKeyDown={(event) => {
    if (event.key !== "Escape") return;
    event.stopPropagation(); event.currentTarget.open = false; event.currentTarget.querySelector("summary")?.focus();
  }}>
    <summary aria-label={`Start from: ${sourceName(value)}`} title="Where Explore starts">
      {value.kind === "ai" ? <span className="explore-source-ai" aria-hidden="true">✦</span> : null}{sourceName(value)}<span aria-hidden="true">▾</span>
    </summary>
    <div role="menu" aria-label="Start from">
      <button type="button" role="menuitemradio" aria-checked={value.kind === "notes"} onClick={(event) => pick(event.currentTarget, { kind: "notes" })}>
        My notes<small>Your notes, in the sections the Map sorts them into</small>
      </button>
      <button type="button" role="menuitemradio" aria-checked={value.kind === "wikipedia"} onClick={(event) => pick(event.currentTarget, { kind: "wikipedia" })}>
        Wikipedia<small>Walk in from its main sections, like the aisles of a library</small>
      </button>
      <div className="explore-source-ask">
        <span>Ask AI about a topic<small>{canAsk ? "AI splits it into sub-topics, and those into more" : "Ask AI is part of the paid plan"}</small></span>
        {canAsk ? <form onSubmit={ask}>
          <input id="explore-source-topic" type="text" value={topic} maxLength={200} placeholder="Longevity, Women's football…" aria-label="Topic for AI"
            onChange={(event) => setTopic(event.target.value)} />
          <button type="submit" disabled={!topic.trim()}>Go</button>
        </form> : null}
        {canAsk && recent.length ? <div className="explore-source-recent">
          {recent.map((item) => <button type="button" role="menuitemradio" key={item} aria-checked={value.kind === "ai" && value.topic === item}
            onClick={(event) => pick(event.currentTarget, { kind: "ai", topic: item })}>{item}</button>)}
        </div> : null}
      </div>
    </div>
  </DismissibleDetails>;
}
