import type { AIExecutionRecord } from "../types";

const providers: Record<string, string> = { "openai-api": "OpenAI", "openai-agent": "OpenAI Agent", "gemini-api": "Google Gemini", "huggingface-api": "Hugging Face", "xai-api": "xAI" };

export default function AIResponseDetails({ execution, onOpenSource, isStreaming = false }: {
  execution: AIExecutionRecord;
  onOpenSource?: (id: string) => void;
  isStreaming?: boolean;
}) {
  return <details className="ai-response-details">
    <summary><span>{execution.status === "streaming" ? isStreaming ? "Responding with" : "Partial response from" : "Answered by"} <strong>{execution.model}</strong></span><span>{execution.sources.length} {execution.sources.length === 1 ? "source" : "sources"} · Details</span></summary>
    <div className="ai-response-body">
      <p>{execution.reason || "Selected for this request."}</p>
      <dl>
        <div><dt>Provider</dt><dd>{providers[execution.provider] ?? execution.provider}</dd></div>
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
  </details>;
}
