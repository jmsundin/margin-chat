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
};

/** The agent's steps, live while it works and saved with the answer afterwards. */
export default function AgentRunLog({ steps, spentMicros, budgetMicros, stopReason, live = false }: {
  steps: AgentRunStep[];
  spentMicros?: number;
  budgetMicros?: number;
  stopReason?: "answered" | "budget" | "round-limit";
  live?: boolean;
}) {
  const cost = spentMicros === undefined ? null
    : `${formatAgentMicros(spentMicros)}${live ? " so far" : ""}${budgetMicros ? ` of ${formatAgentMicros(budgetMicros)} budget` : ""}`;
  return <div className={`agent-run-log${live ? " is-live" : ""}`}>
    {steps.length || live ? <ol aria-label="Agent steps" aria-live={live ? "polite" : undefined}>
      {steps.map((step, index) => <li key={index} className={`is-${step.kind}${step.ok ? "" : " is-failed"}`}>
        <span aria-hidden="true" className="agent-run-mark">{step.kind === "note" ? "·" : step.ok ? "✓" : "–"}</span>
        <span className="agent-run-label">{step.label}</span>
        {step.detail ? <small>{step.detail}</small> : null}
      </li>)}
      {live ? <li className="is-working"><span aria-hidden="true" className="agent-run-mark">✱</span><span className="agent-run-label">{steps.length ? "Working…" : "Planning…"}</span></li> : null}
    </ol> : null}
    {cost || (stopReason && stopReason !== "answered") ? <p className="agent-run-meta">
      {cost}{cost && stopReason && stopReason !== "answered" ? " · " : ""}{stopReason && stopReason !== "answered" ? stopNotes[stopReason] : null}
    </p> : null}
  </div>;
}
