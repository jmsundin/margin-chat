import { useEffect, useRef, useState } from "react";
import type { AppState, Conversation } from "@margin-chat/workspace-contracts";
import { alreadyConnected, buildRelatedIndex, currentPassage, findRelatedNote, type RelatedIndex, type RelatedPick } from "../lib/relatedBeside";
import { readRediscoverLog } from "../lib/rediscover";
import { useRediscoverLevel } from "./RediscoverCard";
import "./RediscoverCard.css";

/** Waits for a pause in typing before looking. */
const PAUSE_MS = 3000;
/** Old notes rarely change, so the word index is rebuilt at most this often (or when the vault grows). */
const REBUILD_MS = 10 * 60 * 1000;

/** Documents that already had their one suggestion this session, and pairs marked "Not related". */
const suggestedFor = new Set<string>();
const notRelated = new Set<string>();

/**
 * While writing (Settings → Editor & look → Rediscover → While writing too): after a pause, one
 * older note about what is being written, at most once per document per session. Nothing shows
 * just for opening a document; only text written here starts it.
 */
export default function RelatedBeside({ state, active, onOpenBeside }: {
  state: Pick<AppState, "conversations">;
  active: Conversation;
  onOpenBeside: (conversationId: string) => void;
}) {
  const level = useRediscoverLevel();
  const [pick, setPick] = useState<(RelatedPick & { forId: string }) | null>(null);
  const index = useRef<RelatedIndex | null>(null);
  const latest = useRef({ state, active });
  latest.current = { state, active };
  const passage = level === "writing" ? currentPassage(active) : "";
  // The passage as the document opened; only a change from it counts as writing.
  const opening = useRef<{ id: string; passage: string } | null>(null);
  if (!opening.current || opening.current.id !== active.id) opening.current = { id: active.id, passage };

  useEffect(() => {
    if (pick && pick.forId !== active.id) setPick(null);
  }, [active.id, pick]);

  useEffect(() => {
    if (level !== "writing" || !passage || passage === opening.current?.passage || suggestedFor.has(active.id)) return;
    const timer = window.setTimeout(() => {
      const { state: current, active: doc } = latest.current;
      const now = Date.now();
      const size = Object.keys(current.conversations).length;
      if (!index.current || index.current.size !== size || now - index.current.builtAt > REBUILD_MS) index.current = buildRelatedIndex(current, now);
      const exclude = alreadyConnected(doc, current);
      for (const key of notRelated) if (key.startsWith(`${doc.id}\n`)) exclude.add(key.slice(doc.id.length + 1));
      const found = findRelatedNote({ index: index.current, passage: currentPassage(doc), exclude, log: readRediscoverLog(), now });
      if (!found) return;
      suggestedFor.add(doc.id);
      setPick({ ...found, forId: doc.id });
    }, PAUSE_MS);
    return () => window.clearTimeout(timer);
  }, [level, passage, active.id]);

  if (level !== "writing" || !pick || pick.forId !== active.id) return null;
  const close = () => setPick(null);
  return (
    <aside className="rediscover-card is-related" aria-labelledby="related-beside-title">
      <div className="rediscover-card-head">
        <span className="rediscover-card-eyebrow">From your notes{pick.lastEdited ? ` · last edited ${pick.lastEdited}` : ""}</span>
        <button type="button" className="rediscover-card-close" aria-label="Close" onClick={close}>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg>
        </button>
      </div>
      <button type="button" className="rediscover-card-title" id="related-beside-title" onClick={() => { close(); onOpenBeside(pick.id); }}>{pick.title}</button>
      <p className="rediscover-card-why">Both mention {joinWords(pick.shared)}.</p>
      <div className="rediscover-card-actions">
        <button type="button" className="rediscover-card-action is-primary" onClick={() => { close(); onOpenBeside(pick.id); }}>Open beside</button>
        <button type="button" className="rediscover-card-action" onClick={() => { notRelated.add(`${pick.forId}\n${pick.id}`); close(); }}>Not related</button>
      </div>
    </aside>
  );
}

function joinWords(words: string[]) {
  return words.length < 2 ? words.join("") : `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}
