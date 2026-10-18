import { useLayoutEffect, useRef } from "react";
import type { AgentRunStep } from "../types";
import "./AgentRunLog.css";

/** Dollars from micro-dollars, with sub-cent spend shown as such rather than $0.00. */
export function formatAgentMicros(micros: number) {
  if (micros > 0 && micros < 10_000) return "under $0.01";
  return `$${(micros / 1_000_000).toFixed(2)}`;
}

const stopNotes = {
  budget: "Stopped early at its budget and answered from what it had.",
  "round-limit": "Reached its step limit and answered from what it had.",
  "time-limit": "Reached its time limit and answered from what it had.",
  question: "Stopped to ask you a question. Your reply picks up from here.",
};

const NOT_SHARED = "The model didn't share its thinking for this run, so only its steps are shown.";

/** Thinking summaries use blank lines between paragraphs and **bold** for headings; nothing else is formatted. */
function ThinkingText({ text }: { text: string }) {
  return <>{text.split(/\n{2,}/u).map((paragraph, index) => paragraph.trim() ? <p key={index}>
    {paragraph.trim().split(/\*\*(.+?)\*\*/gu).map((part, partIndex) => partIndex % 2 ? <strong key={partIndex}>{part}</strong> : part)}
  </p> : null)}</>;
}

const preview = (text: string) => text.replace(/\*\*/gu, "").replace(/\s+/gu, " ").trim();

/** The current model call's thinking as it streams, kept scrolled to the newest text unless the reader scrolls up. */
function LiveThinking({ text }: { text: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  useLayoutEffect(() => {
    if (ref.current && pinned.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [text]);
  return <div ref={ref} className="agent-run-thinking is-live" aria-live="off"
    onScroll={(event) => { const box = event.currentTarget; pinned.current = box.scrollHeight - box.scrollTop - box.clientHeight < 24; }}>
    <ThinkingText text={text}/>
  </div>;
}

/**
 * The agent's steps and thinking, live while it works and saved with the answer
 * afterwards. Live, `thinking` is the current model call's reasoning so far and
 * `activity` what that call is doing.
 */
export default function AgentRunLog({ steps, spentMicros, budgetMicros, stopReason, reasoning, thinking, activity, live = false }: {
  steps: AgentRunStep[];
  spentMicros?: number;
  budgetMicros?: number;
  stopReason?: "answered" | "budget" | "round-limit" | "time-limit" | "question";
  reasoning?: "shared" | "not-shared";
  thinking?: string;
  activity?: "thinking" | "searching" | "writing";
  live?: boolean;
}) {
  const cost = spentMicros === undefined ? null
    : `${formatAgentMicros(spentMicros)}${live ? " so far" : ""}${budgetMicros ? ` of ${formatAgentMicros(budgetMicros)} budget` : ""}`;
  const working = activity === "writing" ? "Writing…" : activity === "searching" ? "Searching the web…" : activity === "thinking" || thinking ? "Thinking…" : steps.length ? "Working…" : "Planning…";
  return <div className={`agent-run-log${live ? " is-live" : ""}`}>
    {steps.length || live ? <ol aria-label="Agent steps" aria-live={live ? "polite" : undefined}>
      {steps.map((step, index) => step.kind === "thinking"
        ? <li key={index} className="is-thinking">
          <span aria-hidden="true" className="agent-run-mark">✻</span>
          <details className="agent-run-thought">
            <summary><span className="agent-run-label">Thought</span><span className="agent-run-thought-preview">{preview(step.label)}</span></summary>
            <div className="agent-run-thinking"><ThinkingText text={step.label}/></div>
          </details>
        </li>
        : <li key={index} className={`is-${step.kind}${step.ok ? "" : " is-failed"}`}>
          <span aria-hidden="true" className="agent-run-mark">{step.kind === "note" ? "·" : step.ok ? "✓" : "–"}</span>
          <span className="agent-run-label">{step.label}</span>
          {step.detail ? <small>{step.detail}</small> : null}
        </li>)}
      {live ? <li className="is-working">
        <span aria-hidden="true" className="agent-run-mark">✱</span>
        <div className="agent-run-current">
          <span className="agent-run-label">{working}</span>
          {thinking ? <LiveThinking text={thinking}/> : null}
        </div>
      </li> : null}
    </ol> : null}
    {cost || (stopReason && stopReason !== "answered") ? <p className="agent-run-meta">
      {cost}{cost && stopReason && stopReason !== "answered" ? " · " : ""}{stopReason && stopReason !== "answered" ? stopNotes[stopReason] : null}
    </p> : null}
    {reasoning === "not-shared" ? <p className="agent-run-meta">{NOT_SHARED}</p> : null}
  </div>;
}
