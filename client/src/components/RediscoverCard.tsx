import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { AppState } from "@margin-chat/workspace-contracts";
import {
  applyRediscoverAnswer, dayNumber, pickRediscoverNote, readRediscoverLog, readRediscoverOn, rediscoverDueToday,
  saveRediscoverLog, saveRediscoverOn, subscribeRediscoverOn, type RediscoverAnswer, type RediscoverPick,
} from "../lib/rediscover";
import { interfaceSettingsLoaded, onInterfaceSettingsLoaded } from "../lib/interfaceSettings";
import "./RediscoverCard.css";

/** Long enough that the app has settled and the person has seen where they are. */
const SHOW_AFTER_MS = 4000;
/** An unanswered card leaves by itself, counted as no answer. */
const HIDE_AFTER_MS = 60_000;

const FEEDBACK: Partial<Record<RediscoverAnswer, string>> = {
  glad: "It will come back later, a little further apart each time.",
  notNow: "It will come back in about two weeks.",
  stop: "This note won't come back.",
};

export function useRediscoverOn() {
  return useSyncExternalStore(subscribeRediscoverOn, readRediscoverOn, () => true);
}

/**
 * The Rediscover card: once a day at most, one older note that seems to matter, with four answers
 * that set when it comes back. See lib/rediscover.ts for how the note and the timing are chosen.
 */
export default function RediscoverCard({ ready, state, activeId, onOpen }: {
  /** The vault is read and the workspace can be used. */
  ready: boolean;
  state: Pick<AppState, "conversations">;
  activeId: string;
  onOpen: (conversationId: string, blockId?: string) => void;
}) {
  const on = useRediscoverOn();
  const [pick, setPick] = useState<RediscoverPick | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [settingsLoaded, setSettingsLoaded] = useState(interfaceSettingsLoaded);
  const tried = useRef(false);
  const held = useRef(new Set<string>());
  const latest = useRef({ state, activeId });
  latest.current = { state, activeId };

  useEffect(() => onInterfaceSettingsLoaded(() => setSettingsLoaded(true)), []);

  // Wait for the account's answers, so another device's card or "Stop showing" counts here too.
  useEffect(() => {
    if (!ready || !on || !settingsLoaded || tried.current) return;
    const timer = window.setTimeout(() => {
      tried.current = true;
      const now = Date.now();
      const today = dayNumber(now);
      const log = readRediscoverLog();
      if (!rediscoverDueToday(log, today)) return;
      const { state: current, activeId: active } = latest.current;
      const next = pickRediscoverNote({ state: current, log, now, skipIds: [active] });
      if (!next) return;
      saveRediscoverLog({ ...log, shown: today });
      setPick(next);
    }, SHOW_AFTER_MS);
    return () => window.clearTimeout(timer);
  }, [ready, on, settingsLoaded]);

  function answer(kind: RediscoverAnswer) {
    if (!pick) return;
    saveRediscoverLog(applyRediscoverAnswer(readRediscoverLog(), pick.id, kind, dayNumber(Date.now())));
    if (kind === "open") { setPick(null); onOpen(pick.id, pick.blockId); return; }
    const message = FEEDBACK[kind];
    if (!message) { setPick(null); return; }
    setFeedback(message);
    window.setTimeout(() => { setPick(null); setFeedback(null); }, 2600);
  }

  // Leaves by itself when it isn't answered, unless the pointer or focus is on it.
  const answerRef = useRef(answer);
  answerRef.current = answer;
  useEffect(() => {
    if (!pick || feedback) return;
    let timer = 0;
    const check = () => {
      if (held.current.size) timer = window.setTimeout(check, 10_000);
      else answerRef.current("ignored");
    };
    timer = window.setTimeout(check, HIDE_AFTER_MS);
    return () => window.clearTimeout(timer);
  }, [pick, feedback]);

  const hold = (reason: string) => { held.current.add(reason); };
  const release = (reason: string) => { held.current.delete(reason); };

  function turnOff() {
    saveRediscoverOn(false);
    setFeedback("Rediscover is off. Turn it back on in Settings → Editor & look.");
    window.setTimeout(() => { setPick(null); setFeedback(null); }, 4000);
  }

  if (!pick || (!on && !feedback)) return null;
  return (
    <aside className="rediscover-card" aria-labelledby="rediscover-title" aria-describedby="rediscover-excerpt"
      onPointerEnter={() => hold("hover")} onPointerLeave={() => release("hover")}
      onFocus={() => hold("focus")} onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) release("focus"); }}>
      <div className="rediscover-card-head">
        <span className="rediscover-card-eyebrow">Rediscover{pick.lastSeen ? ` · last edited ${pick.lastSeen}` : ""}</span>
        <button type="button" className="rediscover-card-close" aria-label="Close" onClick={() => answer("ignored")}>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg>
        </button>
      </div>
      <button type="button" className="rediscover-card-title" id="rediscover-title" onClick={() => answer("open")}>{pick.title}</button>
      <p className="rediscover-card-excerpt" id="rediscover-excerpt">{pick.excerpt}</p>
      {pick.reasons.length ? <p className="rediscover-card-why">Why now: {pick.reasons.join(", ")}.</p> : null}
      {feedback ? <p className="rediscover-card-feedback" role="status">{feedback}</p> : (
        <div className="rediscover-card-actions">
          <button type="button" className="rediscover-card-action is-primary" onClick={() => answer("open")}>Open</button>
          <button type="button" className="rediscover-card-action" onClick={() => answer("glad")}>Glad I saw this</button>
          <button type="button" className="rediscover-card-action" onClick={() => answer("notNow")}>Not now</button>
        </div>
      )}
      {feedback ? null : (
        <div className="rediscover-card-footer">
          <button type="button" className="rediscover-card-off" onClick={() => answer("stop")}>Stop showing this note</button>
          <button type="button" className="rediscover-card-off" onClick={turnOff}>Turn off Rediscover</button>
        </div>
      )}
    </aside>
  );
}
