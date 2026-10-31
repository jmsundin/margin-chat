import { useEffect, useState } from "react";
import { libraryApi, type LibraryField, type LibraryWork } from "../lib/api";
import type { LibraryProgress } from "../lib/useLibrary";
import "./GraphLibrary.css";

const SIZES = [500, 1000, 2000, 5000];

/** Picks what the Landscape shows: your vault, or one of your PubMed fields with your documents pinned on it. */
export function GraphLibraryBar({ fields, selectedId, progress, error, onShowVault, onOpen, onAdd, onRemove }: {
  fields: LibraryField[];
  selectedId: string | null;
  progress: LibraryProgress;
  error: string | null;
  onShowVault: () => void;
  onOpen: (field: LibraryField) => void;
  onAdd: (query: string, size: number) => void;
  onRemove: (fieldId: string) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [query, setQuery] = useState("");
  const [size, setSize] = useState(1000);
  const selected = fields.find((field) => field.id === selectedId) ?? null;
  return <div className="graph-library-bar" data-graph-ui="true" role="group" aria-label="What the landscape shows">
    <label><span>Showing</span>
      <select value={adding ? "add" : selectedId ?? "vault"} onChange={(event) => {
        const value = event.target.value;
        if (value === "add") { setAdding(true); return; }
        setAdding(false);
        if (value === "vault") onShowVault();
        else { const field = fields.find((item) => item.id === value); if (field) onOpen(field); }
      }}>
        <option value="vault">Your vault</option>
        {fields.length ? <optgroup label="PubMed fields">
          {fields.map((field) => <option key={field.id} value={field.id}>{field.query} ({field.works.toLocaleString()} papers)</option>)}
        </optgroup> : null}
        <option value="add">Add a PubMed field…</option>
      </select>
    </label>
    {selected && !adding ? <button type="button" className="graph-library-remove" onClick={() => onRemove(selected.id)}
      title="Remove this field from your library; your documents are not touched">Remove field</button> : null}
    {adding ? <form className="graph-library-add" onSubmit={(event) => {
      event.preventDefault();
      if (query.trim().length < 2) return;
      onAdd(query.trim(), size); setAdding(false); setQuery("");
    }}>
      <input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search PubMed, e.g. cellular senescence" aria-label="PubMed search for the field" maxLength={300} />
      <select value={size} onChange={(event) => setSize(Number(event.target.value))} aria-label="Papers to import">
        {SIZES.map((item) => <option key={item} value={item}>{item.toLocaleString()} papers</option>)}
      </select>
      <button type="submit" disabled={query.trim().length < 2}>Import</button>
      <button type="button" onClick={() => setAdding(false)}>Cancel</button>
    </form> : null}
    {progress ? <p className="graph-library-progress" role="status">{progress.stage === "importing"
      ? `Importing from PubMed: ${progress.fetched.toLocaleString()} of up to ${progress.target.toLocaleString()} papers, ${progress.embedded.toLocaleString()} placed by meaning…`
      : `Laying out ${progress.embedded.toLocaleString()} papers by meaning…`}</p> : null}
    {error ? <p className="graph-library-error" role="alert">{error}</p> : null}
  </div>;
}

/** Markdown for a paper kept in the vault: where it came from first, then the abstract. */
export function libraryWorkMarkdown(work: LibraryWork) {
  const pmid = work.id.replace(/^pubmed:/, "");
  const source = [`[PubMed ${pmid}](https://pubmed.ncbi.nlm.nih.gov/${pmid}/)`, work.doi ? `[doi:${work.doi}](https://doi.org/${work.doi})` : null].filter(Boolean).join(" · ");
  const byline = [work.authors, work.journal, work.year].filter(Boolean).join(" · ");
  return [`> ${source}`, byline ? `*${byline}*` : null, work.abstract ? `## Abstract\n\n${work.abstract}` : null,
    work.topics.length ? `Topics: ${work.topics.join(", ")}` : null].filter(Boolean).join("\n\n");
}

/** A paper clicked on the landscape: its abstract, where to read it, and keeping it as a document. */
export function GraphLibraryWorkCard({ workId, expectedUserId, onKeep, onClose }: {
  workId: string;
  expectedUserId?: string;
  onKeep?: (work: LibraryWork) => boolean;
  onClose: () => void;
}) {
  const [work, setWork] = useState<LibraryWork | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [kept, setKept] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setWork(null); setFailed(null); setKept(false);
    libraryApi.work(workId, expectedUserId).then((result) => { if (!cancelled) setWork(result.work); })
      .catch((error) => { if (!cancelled) setFailed(error instanceof Error ? error.message : "Loading the paper failed."); });
    return () => { cancelled = true; };
  }, [workId, expectedUserId]);
  const pmid = workId.replace(/^pubmed:/, "");
  return <aside className="graph-library-work" data-graph-ui="true" aria-label="Paper" onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); onClose(); } }}>
    <button type="button" className="graph-library-work-close" onClick={onClose} aria-label="Close paper">×</button>
    {failed ? <p role="alert">{failed}</p> : !work ? <p role="status">Loading the paper…</p> : <>
      <h2>{work.title}</h2>
      <p className="graph-library-work-byline">{[work.authors, work.journal, work.year].filter(Boolean).join(" · ")}</p>
      <div className="graph-library-work-abstract">{work.abstract.split("\n\n").map((paragraph, index) => <p key={index}>{paragraph}</p>)}</div>
      {work.topics.length ? <p className="graph-library-work-topics">{work.topics.join(" · ")}</p> : null}
      <div className="graph-library-work-actions">
        <a href={`https://pubmed.ncbi.nlm.nih.gov/${pmid}/`} target="_blank" rel="noreferrer">Open on PubMed</a>
        {work.doi ? <a href={`https://doi.org/${work.doi}`} target="_blank" rel="noreferrer">Full text (DOI)</a> : null}
        {onKeep ? <button type="button" disabled={kept} onClick={() => { if (onKeep(work)) setKept(true); }}>{kept ? "Kept in your vault" : "Keep in vault"}</button> : null}
      </div>
    </>}
  </aside>;
}
