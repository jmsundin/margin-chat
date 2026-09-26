import { useDeferredValue, useEffect, useId, useMemo, useRef, useState } from "react";
import type { Conversation } from "../types";
import {
  normalizeGraphConcepts, resolveGraphEvidence, searchGraphSources,
  type GraphConcept, type GraphConceptMember, type GraphEvidenceRef, type GraphEvidenceRelation, type GraphSearchResult,
} from "../lib/graphExploration";
import "./GraphEvidenceView.css";

export interface GraphEvidenceViewProps {
  concepts: GraphConcept[];
  conversations: Record<string, Conversation>;
  selectedConceptId: string | null;
  selectedConversationId: string | null;
  onSelectConcept: (id: string) => void;
  onSaveConcepts: (concepts: GraphConcept[]) => void;
  onOpenEvidence: (evidence: GraphEvidenceRef) => void;
  lens?: "concepts" | "evidence";
}

const RELATIONS: { value: GraphEvidenceRelation; label: string; hint: string }[] = [
  { value: "supports", label: "Supports", hint: "Sources you judge to support this claim." },
  { value: "challenges", label: "Challenges", hint: "Counterexamples, conflicting evidence, and limitations." },
  { value: "example", label: "Examples", hint: "Concrete cases that illustrate the idea." },
  { value: "question", label: "Questions", hint: "Open questions to investigate." },
  { value: "reference", label: "References", hint: "Related sources with no evidence role assigned." },
];

function RelationSelect({ value, label, onChange }: { value: GraphEvidenceRelation; label: string; onChange: (value: GraphEvidenceRelation) => void }) {
  return <select aria-label={label} value={value} onChange={(event) => onChange(event.target.value as GraphEvidenceRelation)}>
    <option value="reference">Reference</option>
    <option value="supports">Supports</option>
    <option value="challenges">Challenges</option>
    <option value="example">Example</option>
    <option value="question">Question</option>
  </select>;
}

function ConceptEditor({ concept, defaultKind, onSave, onCancel }: {
  concept?: GraphConcept; defaultKind: "concept" | "claim";
  onSave: (value: Pick<GraphConcept, "label" | "description" | "kind">) => void; onCancel: () => void;
}) {
  const id = useId();
  const [label, setLabel] = useState(concept?.label ?? "");
  const [description, setDescription] = useState(concept?.description ?? "");
  const [kind, setKind] = useState(concept?.kind ?? defaultKind);
  return <form className="graph-evidence-form" aria-label={concept ? "Edit concept or claim" : "Create concept or claim"} onSubmit={(event) => {
    event.preventDefault();
    if (label.trim()) onSave({ label: label.trim(), description: description.trim(), kind });
  }}>
    <label htmlFor={`${id}-kind`}>Type</label>
    <select id={`${id}-kind`} value={kind} onChange={(event) => setKind(event.target.value as "concept" | "claim")}>
      <option value="concept">Concept or entity</option><option value="claim">Claim or question</option>
    </select>
    <label htmlFor={`${id}-name`}>{kind === "claim" ? "Claim or question" : "Concept name"}</label>
    <input id={`${id}-name`} autoFocus required maxLength={240} value={label} onChange={(event) => setLabel(event.target.value)}
      placeholder={kind === "claim" ? "What are you trying to establish?" : "e.g. Local-first software"} />
    <label htmlFor={`${id}-description`}>Description (optional)</label>
    <textarea id={`${id}-description`} maxLength={2000} rows={3} value={description} onChange={(event) => setDescription(event.target.value)} />
    <div className="graph-evidence-actions"><button type="submit" disabled={!label.trim()}>{concept ? "Save changes" : "Create"}</button>
      <button type="button" onClick={onCancel}>Cancel</button></div>
  </form>;
}

/** Pick a paragraph around the search match while retaining exact source offsets. */
function initialPassage(content: string, evidence: GraphEvidenceRef) {
  const anchor = Math.min(evidence.startOffset ?? 0, content.length);
  let start = content.lastIndexOf("\n\n", Math.max(0, anchor - 1));
  start = start < 0 ? 0 : start + 2;
  let end = content.indexOf("\n\n", evidence.endOffset ?? anchor);
  if (end < 0) end = content.length;
  // Long blocks remain fully available in the selection field without creating
  // an unexpectedly enormous default quote.
  if (end - start > 1200) {
    start = Math.max(start, anchor - 160);
    end = Math.min(end, Math.max(evidence.endOffset ?? anchor, anchor + 600));
  }
  return { startOffset: start, endOffset: end };
}

function PassagePicker({ result, conversations, evidenceMode, onAdd, onCancel }: {
  result: GraphSearchResult; conversations: Record<string, Conversation>; evidenceMode: boolean;
  onAdd: (member: GraphConceptMember) => void; onCancel: () => void;
}) {
  const source = resolveGraphEvidence(conversations, result.evidence);
  const content = source.content ?? "";
  const [range, setRange] = useState(() => initialPassage(content, result.evidence));
  const [relation, setRelation] = useState<GraphEvidenceRelation>("reference");
  const textarea = useRef<HTMLTextAreaElement>(null);
  const id = useId();
  useEffect(() => {
    textarea.current?.focus();
    textarea.current?.setSelectionRange(range.startOffset, range.endOffset);
  }, []);
  const passage = content.slice(range.startOffset, range.endOffset);
  const canQuote = result.evidence.sourceKind !== "conversation" && Boolean(passage) && source.status !== "missing";
  return <section className="graph-evidence-picker" aria-label="Review source passage">
    <div className="graph-evidence-section-title"><h4>{result.title}</h4><button type="button" onClick={onCancel}>Cancel</button></div>
    {result.evidence.sourceKind !== "conversation" ? <>
      <label htmlFor={id}>Select the exact text to attach</label>
      <textarea id={id} ref={textarea} readOnly value={content} rows={7} onSelect={(event) => {
        const { selectionStart, selectionEnd } = event.currentTarget;
        setRange({ startOffset: selectionStart, endOffset: selectionEnd });
      }} />
      <p className="graph-evidence-hint">{passage.length} characters selected · {result.sourceLabel}. The reference opens the current source document.</p>
    </> : <p className="graph-evidence-hint">This result matches the document title. Attach the whole document, or search for text inside it to attach a passage.</p>}
    {evidenceMode ? <label className="graph-evidence-role">Role you assign
      <RelationSelect value={relation} label="New source evidence role" onChange={setRelation} />
    </label> : null}
    <div className="graph-evidence-actions">
      {result.evidence.sourceKind !== "conversation" ? <button type="button" disabled={!canQuote} onClick={() => onAdd({
        ...result.evidence, ...range, quote: passage, relation,
      })}>Attach selected passage</button> : null}
      <button type="button" onClick={() => onAdd({ conversationId: result.evidence.conversationId, sourceKind: "conversation", relation })}>Attach whole document</button>
    </div>
  </section>;
}

function SourceCard({ member, index, concept, conversations, showRole, onOpen, onUpdate }: {
  member: GraphConceptMember; index: number; concept: GraphConcept; conversations: Record<string, Conversation>; showRole: boolean;
  onOpen: (evidence: GraphEvidenceRef) => void; onUpdate: (concept: GraphConcept) => void;
}) {
  const source = resolveGraphEvidence(conversations, member);
  const title = conversations[member.conversationId]?.title ?? "Unavailable document";
  const status = source.status === "recovered" ? "Passage moved · located in current source"
    : source.status === "stale" ? "Passage changed · verify this reference"
    : source.status === "missing" ? "Source unavailable" : member.sourceKind === "conversation" ? "Whole document · no passage anchor" : member.quote ? "Exact passage" : "Source block · no passage selection";
  return <article className={`graph-evidence-source is-${source.status}`}>
    <div className="graph-evidence-source-meta"><span>{status}</span>
      <button type="button" aria-label={`Remove source ${index + 1} from ${concept.label}`} onClick={() => onUpdate({ ...concept, members: concept.members.filter((_member, i) => i !== index) })}>Remove</button></div>
    <button type="button" className="graph-evidence-source-open" disabled={!conversations[member.conversationId]} onClick={() => onOpen(member)}>
      <strong>{title}</strong>
      {member.quote ? <blockquote>{member.quote}</blockquote> : null}
      <span>Open source ↗</span>
    </button>
    {showRole ? <RelationSelect value={member.relation ?? "reference"} label={`Evidence role for source ${index + 1}`} onChange={(relation) => onUpdate({
      ...concept, members: concept.members.map((item, i) => i === index ? { ...item, relation } : item),
    })} /> : null}
  </article>;
}

export function GraphEvidenceView({ concepts, conversations, selectedConceptId, selectedConversationId, onSelectConcept, onSaveConcepts, onOpenEvidence, lens = "evidence" }: GraphEvidenceViewProps) {
  const evidenceMode = lens === "evidence";
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const [query, setQuery] = useState("");
  const [resultLimit, setResultLimit] = useState(12);
  const [pickedSource, setPickedSource] = useState<GraphSearchResult | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const selected = concepts.find((concept) => concept.id === selectedConceptId) ?? concepts[0];
  const deferredQuery = useDeferredValue(query);
  const results = useMemo(() => searchGraphSources(conversations, deferredQuery), [conversations, deferredQuery]);
  const id = useId();
  useEffect(() => { setPickedSource(null); setAnnouncement(""); setEditing(null); }, [selected?.id]);
  useEffect(() => { setResultLimit(12); }, [deferredQuery]);

  const update = (concept: GraphConcept) => onSaveConcepts(concepts.map((item) => item.id === concept.id ? concept : item));
  const addSource = (member: GraphConceptMember) => {
    if (!selected) return;
    const next = normalizeGraphConcepts([{ ...selected, members: [...selected.members, member] }])[0];
    update(next);
    setPickedSource(null);
    setAnnouncement(next.members.length > selected.members.length ? "Source attached." : "This source is already attached. Change its role on the source card.");
  };
  const createOrEdit = (fields: Pick<GraphConcept, "label" | "description" | "kind">) => {
    if (editing && editing !== "new") {
      const original = concepts.find((concept) => concept.id === editing);
      if (original) update({ ...original, ...fields });
    } else {
      const concept: GraphConcept = { ...fields, id: `concept-${crypto.randomUUID()}`, members: [] };
      onSaveConcepts([...concepts, concept]);
      onSelectConcept(concept.id);
    }
    setEditing(null);
  };

  return <section className={`graph-evidence-view is-${lens}`} data-graph-ui="true" aria-label={evidenceMode ? "Evidence view" : "Concepts view"}>
    <aside className="graph-evidence-index" aria-label="Concepts and claims">
      <header><span className="graph-evidence-eyebrow">{evidenceMode ? "Evidence" : "Concepts & entities"}</span>
        <h2>{evidenceMode ? "Follow the sources" : "Ideas across documents"}</h2>
        <p>{evidenceMode ? "Gather passages around a claim or question. Assign each source a role." : "Connect an idea to exact passages. A document can belong to several concepts."}</p>
      </header>
      <button type="button" className="graph-evidence-new" onClick={() => setEditing("new")}>{evidenceMode ? "+ New claim or concept" : "+ New concept"}</button>
      <nav aria-label="Choose concept or claim"><ul>{concepts.map((concept) => <li key={concept.id}>
        <button type="button" aria-current={selected?.id === concept.id ? "true" : undefined} onClick={() => onSelectConcept(concept.id)}>
          <span>{concept.kind === "claim" ? "Claim / question" : "Concept / entity"}</span><strong>{concept.label}</strong>
          <small>{concept.members.length} {concept.members.length === 1 ? "source" : "sources"} · {new Set(concept.members.map((member) => member.conversationId)).size} {new Set(concept.members.map((member) => member.conversationId)).size === 1 ? "document" : "documents"}</small>
        </button>
      </li>)}</ul></nav>
      <p className="graph-evidence-local">Concepts, claims, and source roles are saved on this device for this workspace.</p>
    </aside>
    <div className="graph-evidence-main" tabIndex={0} aria-label="Concept sources">
      {editing ? <ConceptEditor key={editing} concept={concepts.find((concept) => concept.id === editing)} defaultKind={evidenceMode ? "claim" : "concept"} onSave={createOrEdit} onCancel={() => setEditing(null)} /> : null}
      {selected ? <>
        <header className="graph-evidence-heading"><div><span className="graph-evidence-eyebrow">{selected.kind === "claim" ? "Claim / question" : "Concept / entity"}</span>
          <h3>{selected.label}</h3>{selected.description ? <p>{selected.description}</p> : null}</div>
          <button type="button" onClick={() => setEditing(selected.id)}>Edit</button></header>
        {evidenceMode ? <p className="graph-evidence-hint">Roles reflect your assessment of the sources. Similarity alone does not establish support or contradiction.</p> : null}
        {selected.members.length ? <div className="graph-evidence-lanes">{(evidenceMode ? RELATIONS : [{ value: "all", label: "Source passages", hint: "" }]).map((lane) => {
          const members = selected.members.map((member, index) => ({ member, index })).filter(({ member }) => lane.value === "all" || (member.relation ?? "reference") === lane.value);
          return <section className="graph-evidence-lane" key={lane.value} aria-label={lane.label} data-evidence-role={lane.value}>
            <h4>{lane.label} <span>{members.length}</span></h4>
            {!members.length ? <p className="graph-evidence-hint">{lane.hint}</p> : members.map(({ member, index }) => <SourceCard key={`${index}-${member.conversationId}`} member={member} index={index} concept={selected}
              conversations={conversations} showRole={evidenceMode} onOpen={onOpenEvidence} onUpdate={update} />)}
          </section>;
        })}</div> : <p className="graph-evidence-empty">No sources yet. Find a passage below, or attach the selected document.</p>}
        <section className="graph-evidence-attach" aria-label="Attach sources">
          <div className="graph-evidence-section-title"><h4>Attach sources</h4>
            {selectedConversationId && conversations[selectedConversationId] ? <button type="button" onClick={() => addSource({ conversationId: selectedConversationId, sourceKind: "conversation", relation: "reference" })}>Attach selected document</button> : null}</div>
          <label htmlFor={`${id}-search`}>Search titles and source text</label>
          <input id={`${id}-search`} type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Find a specific passage…" />
          <p className="graph-evidence-hint" role="status">{announcement || `${results.length} matching sources. Review a result to choose its exact passage.`}</p>
          {pickedSource ? <PassagePicker key={pickedSource.id} result={pickedSource} conversations={conversations} evidenceMode={evidenceMode} onAdd={addSource} onCancel={() => setPickedSource(null)} /> : <>
            <ul className="graph-evidence-results">{results.slice(0, resultLimit).map((result) => <li key={result.id}>
              <button type="button" onClick={() => setPickedSource(result)}><span>{result.sourceLabel}</span><strong>{result.title}</strong><p>{result.preview}</p><small>Review passage →</small></button>
            </li>)}</ul>
            {results.length > resultLimit ? <button type="button" onClick={() => setResultLimit((limit) => limit + 12)}>Show more sources</button> : null}
          </>}
        </section>
      </> : !editing ? <div className="graph-evidence-empty-state"><h3>{evidenceMode ? "Start with a claim or a question" : "Give a shared idea a home"}</h3>
        <p>{evidenceMode ? "Add a claim, then collect exact passages that support it, challenge it, illustrate it, or leave questions open." : "Create a concept or entity, then connect it to passages from any of your documents."}</p>
        <button type="button" onClick={() => setEditing("new")}>{evidenceMode ? "Create your first claim" : "Create your first concept"}</button></div> : null}
    </div>
  </section>;
}

export default GraphEvidenceView;
