import { getBackendServiceModel, isBackendServiceId } from "../lib/services";
import type { AgentWebSource, AIExecutionRecord, AIRetrievalRecord } from "../types";
import AgentRunLog from "./AgentRunLog";
import "./AIResponseDetails.css";

const providers: Record<string, string> = { "openai-api": "OpenAI", "openai-agent": "OpenAI", "anthropic-api": "Anthropic Claude", "gemini-api": "Google Gemini", "huggingface-api": "Hugging Face", "xai-api": "xAI", "meta-api": "Meta Muse" };
const routingLabels = {
  astra: "Auto · selected by GPT-6 Astra (low reasoning)",
  "astra-task": "Auto · GPT-6 Astra task matching",
  jev: "Auto · selected by Jev",
  "jev-task": "Auto · Jev task matching",
  rules: "Auto · standard routing",
  manual: "Selected by you",
};

function modelLabel(provider: string, model: string) {
  // Never substitute the catalog default for an unknown resolved model ID.
  return (isBackendServiceId(provider) ? getBackendServiceModel(provider, model)?.label : undefined) ?? model;
}

const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;
const matchLabels = { both: "Same words and meaning", keyword: "Same words", meaning: "Meaning only" };

/** One line on what the vault search added to the reply, for the collapsed details row. */
function vaultBadge(retrieval: AIRetrievalRecord) {
  if (retrieval.status === "none-found") return "Vault · no close matches";
  if (retrieval.status !== "used") return null;
  const cited = retrieval.passages.filter((passage) => passage.cited).length;
  return `Vault · ${plural(retrieval.passages.length, retrieval.agent ? "document" : "passage")}${cited ? ` · ${cited} cited` : ""}`;
}

/** What searching the vault contributed: what it found, how, and whether the answer used it. */
function VaultSearch({ retrieval, onOpenSource, answered }: { retrieval: AIRetrievalRecord; onOpenSource?: (id: string) => void; answered: boolean }) {
  const { passages } = retrieval;
  const meaningOnly = passages.filter((passage) => passage.matched === "meaning").length;
  const cited = passages.filter((passage) => passage.cited).length;
  const all = (count: number) => count === passages.length;
  const summary = retrieval.status === "used" ? [
    retrieval.agent
      ? `The agent searched your vault ${plural(retrieval.queries?.length ?? 1, "time")} and found ${plural(passages.length, "relevant document")}.`
      : `Found ${plural(passages.length, "passage")} in your vault and gave ${passages.length === 1 ? "it" : "them"} to the model.`,
    meaningOnly ? `${all(meaningOnly) ? passages.length === 1 ? "It was" : "All of them were" : `${meaningOnly} ${meaningOnly === 1 ? "was" : "were"}`} found by meaning only, so searching for the same words would have missed ${meaningOnly === 1 ? "it" : "them"}.` : "",
    answered && !retrieval.agent ? cited ? `The answer cites ${all(cited) ? passages.length === 1 ? "it" : "all of them" : `${cited} of them`}.` : "The answer doesn't cite any of them." : "",
  ].filter(Boolean).join(" ") : retrieval.status === "none-found" ? "Your vault was searched, but nothing matched closely enough to include." : "";
  return <div className="ai-vault-search">
    <strong>Vault search</strong>
    {summary ? <p className="ai-vault-summary">{summary}</p> : null}
    {retrieval.queries?.length ? <p className="ai-vault-queries">Searched for {retrieval.queries.map((query) => `“${query}”`).join(", ")}</p> : null}
    {passages.length ? <ol className="ai-vault-passages">{passages.map((passage, index) => <li key={`${passage.id}:${index}`}>
      <div className="ai-vault-passage-title">
        {passage.label ? <span className="ai-vault-label">[{passage.label}]</span> : null}
        {passage.openId && onOpenSource ? <button type="button" onClick={() => onOpenSource(passage.openId!)}>{passage.title || passage.id}</button> : <span>{passage.title || passage.id}</span>}
        {passage.heading ? <span className="ai-vault-heading"> › {passage.heading}</span> : null}
      </div>
      <div className="ai-vault-tags">
        <span className={`ai-vault-match ai-vault-match-${passage.matched}`}>{matchLabels[passage.matched]}</span>
        {passage.similarity !== undefined ? <span title="How close the passage's meaning is to your message, from 0 to 1">similarity {passage.similarity.toFixed(2)}</span> : null}
        <span>{passage.kind}</span>
        {passage.cited ? <span className="ai-vault-cited">Cited in the answer</span> : null}
      </div>
      {passage.excerpt ? <p>{passage.excerpt}</p> : null}
    </li>)}</ol> : null}
    {retrieval.alreadyIncluded ? <p className="ai-detail-note">{plural(retrieval.alreadyIncluded, "more match", "more matches")} {retrieval.alreadyIncluded === 1 ? "was" : "were"} already in the request in full.</p> : null}
    {retrieval.note ? <p className="ai-detail-note">{retrieval.note}</p> : null}
  </div>;
}

const hostOf = (url: string) => { try { return new URL(url).hostname.replace(/^www\./u, ""); } catch { return ""; } };

/** Web pages the agent's answer cites, listed under the answer rather than inside the details. */
function WebSources({ sources }: { sources: AgentWebSource[] }) {
  return <div className="ai-web-sources"><strong>Sources</strong><ol>{sources.map((source) => {
    const host = hostOf(source.url);
    return <li key={source.url}><a href={source.url} target="_blank" rel="noopener noreferrer">{source.title || host || source.url}</a>
      {source.title && host ? <small> · {host}</small> : null}</li>;
  })}</ol></div>;
}

export default function AIResponseDetails({ execution, onOpenSource, isStreaming = false }: {
  execution: AIExecutionRecord;
  onOpenSource?: (id: string) => void;
  isStreaming?: boolean;
}) {
  const method = execution.routing?.method;
  const isPartial = execution.status === "stopped" || execution.status === "failed" || execution.status === "streaming" && !isStreaming;
  const statusLabel = execution.status === "streaming" && isStreaming ? "Responding with" : isPartial ? "Partial response from" : "Answered by";
  const retrieval = execution.retrieval;
  const badge = retrieval ? vaultBadge(retrieval) : null;
  // Vault passages are listed under Vault search, so Context used keeps what was chosen or attached.
  const vaultIds = new Set(retrieval && !retrieval.agent ? retrieval.passages.map((passage) => passage.id) : []);
  const sources = execution.sources.filter((source) => !vaultIds.has(source.id));
  const webSources = execution.agent?.webSources ?? [];
  return <section className="ai-response-details" aria-label="Model selection">
    {webSources.length ? <WebSources sources={webSources}/> : null}
    <details className="ai-response-more">
    <summary>
      <span className="ai-routing-model">{statusLabel} <strong>{modelLabel(execution.provider, execution.model)}</strong><span> · {providers[execution.provider] ?? execution.provider}</span></span>
      {execution.agent ? <span className="ai-routing-agent-label">Agent · {execution.agent.steps.filter((step) => step.kind === "tool").length} {execution.agent.steps.filter((step) => step.kind === "tool").length === 1 ? "step" : "steps"}</span> : null}
      {badge ? <span className="ai-routing-vault-label">{badge}</span> : null}
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
      {execution.agent ? <div className="ai-agent-run"><strong>Agent steps</strong>
        {execution.agent.automatic ? <p className="ai-detail-note">Agent mode turned on by itself because {execution.agent.automatic}.</p> : null}
        <AgentRunLog steps={execution.agent.steps} spentMicros={execution.agent.spentMicros} budgetMicros={execution.agent.budgetMicros} stopReason={execution.agent.stopReason} reasoning={execution.agent.reasoning}/>
        {!execution.agent.steps.some((step) => step.kind === "tool") ? <p className="ai-detail-note">The agent answered without needing any tools.</p> : null}
      </div> : null}
      {retrieval ? <VaultSearch retrieval={retrieval} onOpenSource={onOpenSource} answered={execution.status === "complete"}/> : null}
      {sources.length ? <div className="ai-used-sources"><strong>Context used</strong><ul>{sources.map((source, index) => <li key={`${source.kind}:${source.id}:${index}`}>
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
