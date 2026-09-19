import { getBackendServiceModel, isBackendServiceId } from "../lib/services";
import type { AIExecutionRecord } from "../types";
import "./AIResponseDetails.css";

const providers: Record<string, string> = { "openai-api": "OpenAI", "openai-agent": "OpenAI Agent", "gemini-api": "Google Gemini", "huggingface-api": "Hugging Face", "xai-api": "xAI" };
const routingLabels = {
  jev: "Auto · selected by Jev",
  "jev-task": "Auto · Jev task matching",
  rules: "Auto · standard routing",
  manual: "Selected by you",
};

function modelLabel(provider: string, model: string) {
  // Never substitute the catalog default for an unknown resolved model ID.
  return (isBackendServiceId(provider) ? getBackendServiceModel(provider, model)?.label : undefined) ?? model;
}

export default function AIResponseDetails({ execution, onOpenSource, isStreaming = false }: {
  execution: AIExecutionRecord;
  onOpenSource?: (id: string) => void;
  isStreaming?: boolean;
}) {
  const method = execution.routing?.method;
  const isPartial = execution.status === "stopped" || execution.status === "failed" || execution.status === "streaming" && !isStreaming;
  const statusLabel = execution.status === "streaming" && isStreaming ? "Responding with" : isPartial ? "Partial response from" : "Answered by";
  return <section className="ai-response-details" aria-label="Model selection">
    <details className="ai-response-more">
    <summary>
      <span className="ai-routing-model">{statusLabel} <strong>{modelLabel(execution.provider, execution.model)}</strong><span> · {providers[execution.provider] ?? execution.provider}</span></span>
      {execution.fallbacks.length ? <span className="ai-routing-fallback-label">Fallback used</span> : null}
      <span className="ai-routing-trigger">Why this model?<svg aria-hidden="true" viewBox="0 0 16 16" fill="none"><path d="m6 4 4 4-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg></span>
    </summary>
    <div className="ai-response-body">
      <p className="ai-routing-label">{method ? routingLabels[method] : "Selection details"}</p>
      <p className="ai-routing-reason"><strong>Why:</strong> {execution.reason || "No selection reason was recorded for this reply."}</p>
      <dl>
        <div><dt>Service</dt><dd>{providers[execution.provider] ?? execution.provider}</dd></div>
        <div><dt>Model ID</dt><dd>{execution.model}</dd></div>
        {execution.routing && execution.routing.selectedModel !== execution.model ? <div><dt>Requested model ID</dt><dd>{execution.routing.selectedModel}</dd></div> : null}
        <div><dt>Preference</dt><dd>{execution.mode}</dd></div>
        <div><dt>Task</dt><dd>{execution.task}</dd></div>
        {execution.durationMs !== undefined ? <div><dt>Time</dt><dd>{(execution.durationMs / 1000).toFixed(1)} seconds</dd></div> : null}
        {execution.status && execution.status !== "complete" ? <div><dt>Status</dt><dd>{execution.status === "stopped" ? "Stopped; partial answer saved" : execution.status === "failed" ? "Interrupted; partial answer saved" : isStreaming ? "Responding" : "Partial answer saved; completion not recorded"}</dd></div> : null}
      </dl>
      {execution.sources.length ? <div className="ai-used-sources"><strong>Context used</strong><ul>{execution.sources.map((source, index) => <li key={`${source.kind}:${source.id}:${index}`}>
        {source.kind !== "document" && onOpenSource ? <button type="button" onClick={() => onOpenSource(source.id)}>{source.title || source.id}</button> : <span>{source.title || source.id}</span>}
        <small>{source.kind}{source.updatedAt ? ` · version from ${source.updatedAt}` : ""}</small>
        {source.excerpt ? <p>{source.excerpt}</p> : null}
      </li>)}</ul></div> : null}
      {execution.truncated ? <p className="ai-detail-warning">Some context was shortened or omitted to fit this request. Narrow your sources or use Thorough for more context.</p> : null}
      {execution.fallbacks.length ? <div><strong>Fallbacks</strong><ul>{execution.fallbacks.map((attempt, index) => <li key={index}>{attempt.model} · {providers[attempt.provider] ?? attempt.provider}: {attempt.reason}</li>)}</ul></div> : null}
      {execution.warnings.map((warning, index) => <p className="ai-detail-warning" key={index}>{warning}</p>)}
      {execution.profileVersion ? <small>Selection policy: {execution.profileVersion}</small> : null}
    </div>
    </details>
  </section>;
}
