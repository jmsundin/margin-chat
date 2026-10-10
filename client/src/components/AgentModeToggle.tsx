import { AGENT_BUDGET_CHOICES_MICROS, DEFAULT_AGENT_BUDGET_MICROS } from "@margin-chat/workspace-contracts";
import { formatAgentMicros } from "./AgentRunLog";

export interface AgentModeControls {
  enabled: boolean;
  /** False when the selected model can't call tools. */
  available: boolean;
  budgetMicros?: number;
  /** Hosted runs are charged to credit, so only they show a budget. */
  showBudget: boolean;
  onChange: (next: { enabled: boolean; budgetMicros: number }) => void;
}

/** The Ask AI composer's Agent switch, with the per-run budget beside it when on. */
export default function AgentModeToggle({ controls, disabled }: { controls: AgentModeControls; disabled?: boolean }) {
  const budgetMicros = controls.budgetMicros ?? DEFAULT_AGENT_BUDGET_MICROS;
  const on = controls.enabled && controls.available;
  return <span className="agent-mode-toggle">
    <button type="button" aria-pressed={on} disabled={disabled || !controls.available}
      title={controls.available ? "Agent mode: the AI can look through your permitted notes and chats over several steps before writing" : "This model can't use tools. Choose an OpenAI, Claude or xAI model for Agent mode."}
      onClick={() => controls.onChange({ enabled: !on, budgetMicros })}>Agent</button>
    {on && controls.showBudget ? <select aria-label="Agent budget per run" disabled={disabled} value={budgetMicros}
      onChange={(event) => controls.onChange({ enabled: true, budgetMicros: Number(event.target.value) })}>
      {AGENT_BUDGET_CHOICES_MICROS.map((micros) => <option key={micros} value={micros}>Up to {formatAgentMicros(micros)}</option>)}
    </select> : null}
  </span>;
}
