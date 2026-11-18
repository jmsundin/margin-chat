import { useEffect, useMemo, useState } from "react";
import { renderMarkdownToHtml } from "../lib/markdown";
import type { BrowseNode } from "../lib/exploreSources";
import { getWikipediaSummary, wikipediaArticleUrl } from "../lib/wikipedia";
import "./TopicExplorer.css";

/** The question AI answers for Topic details: a short write-up you could keep as a note. */
export function topicDetailsQuestion(label: string) {
  return `Write a short overview of "${label}" for someone exploring it: what it is, its main ideas, why it matters, and open questions. Use plain paragraphs.`;
}

/** The note a Topic details write-up becomes when you save it. */
export function topicDetailsNote(node: BrowseNode, text: string) {
  const source = node.article ? `\n\nSource: [${node.article} on Wikipedia](${wikipediaArticleUrl(node.article)})` : "";
  return `${text.trim()}${source}\n`;
}

/**
 * Topic details beside Explore: AI writes up the topic you tapped, or, without AI, Wikipedia's
 * summary of it. Save as note turns what you read into a document in your vault.
 */
export default function TopicDetailsPane({ node, ask, onSave, onRead, onClose }: {
  node: BrowseNode;
  /** Asks AI for the write-up; missing when this account can't ask. */
  ask?: (label: string, signal: AbortSignal) => Promise<string>;
  /** Makes a note from the write-up; returns why it could not, or null. */
  onSave: (title: string, content: string) => string | null;
  onRead?: (title: string) => void;
  onClose: () => void;
}) {
  const [state, setState] = useState<{ text: string; by: "ai" | "wikipedia" } | { error: string } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [saveError, setSaveError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    setState(null); setSaveError("");
    (async () => {
      if (ask) return { text: await ask(node.label, controller.signal), by: "ai" as const };
      const summary = node.article ? await getWikipediaSummary(wikipediaArticleUrl(node.article), controller.signal) : null;
      if (summary?.extract) return { text: summary.extract, by: "wikipedia" as const };
      return { error: node.summary ? node.summary : "There is nothing written about this topic yet. Ask AI is part of the paid plan." };
    })().then((result) => { if (!controller.signal.aborted) setState(result); },
      (error: unknown) => { if (!controller.signal.aborted) setState({ error: error instanceof Error ? error.message : "Topic details could not be written. Try again." }); });
    return () => controller.abort();
  }, [node.id, node.label, node.article, ask, attempt]);

  const text = state && "text" in state ? state.text : "";
  const html = useMemo(() => text ? renderMarkdownToHtml(text) : "", [text]);
  return <aside className="topic-explorer-pane is-details" aria-label={`Topic details: ${node.label}`}>
    <header className="topic-explorer-pane-header">
      <span className="topic-explorer-pane-kind" aria-hidden="true">{ask ? "✦" : "W"}</span>
      <strong title={node.label}>{node.label}</strong>
      <button type="button" aria-label="Close topic details" title="Close" onClick={onClose}>×</button>
    </header>
    <div className="topic-explorer-pane-scroll topic-details-body">
      {!state ? <p className="topic-explorer-pane-message" role="status">{ask ? `AI is writing about ${node.label}…` : `Reading about ${node.label}…`}</p>
        : "error" in state ? <div className="topic-details-error"><p role="alert">{state.error}</p>{ask ? <button type="button" onClick={() => setAttempt((count) => count + 1)}>Try again</button> : null}</div>
        : <>
          {/* AI answers in Markdown (bold, lists, headings); it is drawn, not shown as symbols. */}
          <div className="topic-details-text" dangerouslySetInnerHTML={{ __html: html }} />
          <small className="topic-details-by">{state.by === "ai" ? "Written by AI. Check what matters to you." : "From Wikipedia's summary."}</small>
        </>}
    </div>
    {text ? <footer className="topic-details-actions">
      <button type="button" className="is-primary" onClick={() => setSaveError(onSave(node.label, topicDetailsNote(node, text)) ?? "")}>Save as note</button>
      {node.article && onRead ? <button type="button" onClick={() => onRead(node.article!)}>Wikipedia article</button> : null}
      {saveError ? <span role="alert">{saveError}</span> : null}
    </footer> : null}
  </aside>;
}
