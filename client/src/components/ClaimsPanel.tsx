import { useEffect, useRef } from "react";
import { VERDICT_LABELS, type RatchetClaim, type RatchetEvidence, type RatchetVerdict } from "../lib/ratchet";
import type { RatchetDocumentState } from "../lib/useRatchet";
import "./ClaimsPanel.css";

interface Props {
  title: string;
  state: RatchetDocumentState | undefined;
  /** The claim to scroll to, when opened from its highlight or margin mark. */
  focusClaimId?: string | null;
  onCheck: () => void;
  onStop: () => void;
  onOpenEvidence: (evidence: RatchetEvidence) => void;
  onShowClaim: (claim: RatchetClaim) => void;
  onClose: () => void;
}

const ORDER: RatchetVerdict[] = ["contradicted", "stale", "unsupported", "supported", "insufficient-evidence"];
const STANCE: Record<RatchetEvidence["stance"], string> = { supports: "Supports", contradicts: "Contradicts", supersedes: "Newer", related: "Related" };

export function VerdictChip({ verdict }: { verdict: RatchetVerdict }) {
  return <span className={`ratchet-verdict is-${verdict}`}>{VERDICT_LABELS[verdict]}</span>;
}

/** Every claim in one document with its verdict and the passages behind it, plus the check's receipt. */
export default function ClaimsPanel({ title, state, focusClaimId, onCheck, onStop, onOpenEvidence, onShowClaim, onClose }: Props) {
  const listRef = useRef<HTMLOListElement>(null);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); onClose(); } };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  useEffect(() => {
    if (!focusClaimId) return;
    listRef.current?.querySelector<HTMLElement>(`[data-claim-id="${CSS.escape(focusClaimId)}"]`)?.scrollIntoView({ block: "nearest" });
  }, [focusClaimId, state?.claims.length]);

  const checking = state?.status === "checking";
  const claims = [...(state?.claims ?? [])];
  const current = claims.filter((claim) => state?.anchors[claim.id]?.state !== "anchor-stale")
    .sort((left, right) => ORDER.indexOf(left.verdict) - ORDER.indexOf(right.verdict));
  const changed = claims.filter((claim) => state?.anchors[claim.id]?.state === "anchor-stale");
  const run = state?.run;
  const counts = ORDER.map((verdict) => [verdict, current.filter((claim) => claim.verdict === verdict).length] as const).filter(([, count]) => count);

  const progress = state?.progress;
  const progressLabel = !progress ? "" : progress.phase === "extracting" ? "Finding claims…"
    : `Checking claims against your vault… ${Math.min(progress.checked, progress.total)} of ${progress.total}`;

  function renderClaim(claim: RatchetClaim, stale = false) {
    const evidenceStates = state?.evidence[claim.id] ?? [];
    return <li key={claim.id} data-claim-id={claim.id} className={`claims-item${focusClaimId === claim.id ? " is-focused" : ""}${stale ? " is-stale" : ""}`}>
      <div className="claims-item-head">
        {stale ? <span className="ratchet-verdict is-changed">Text changed</span> : <VerdictChip verdict={claim.verdict}/>}
        {!stale ? <button type="button" className="claims-show" onClick={() => onShowClaim(claim)}>Show in document</button> : null}
      </div>
      <blockquote className="claims-span">{claim.span}</blockquote>
      {claim.claim !== claim.span ? <p className="claims-restated">{claim.claim}</p> : null}
      {stale ? <p className="claims-reason">These lines changed after the check, so this verdict isn't shown in the margin. Check again to update it.</p>
        : claim.reason ? <p className="claims-reason">{claim.reason}</p> : null}
      {claim.evidence.length ? <ul className="claims-evidence" aria-label="Evidence">
        {claim.evidence.map((evidence, index) => {
          const located = evidenceStates[index];
          const resolved = located?.state ?? "ok";
          return <li key={`${evidence.documentId}:${evidence.blockId}:${evidence.lineStart}`} className={resolved === "ok" ? "" : "is-changed"}>
            <span className="claims-stance">{STANCE[evidence.stance]}</span>
            <q>{evidence.quote}</q>
            <span className="claims-source">
              {resolved === "source-missing" ? <>{evidence.title} <em>· no longer in your vault</em></>
                : <button type="button" onClick={() => onOpenEvidence(located?.state === "ok" ? { ...evidence, blockId: located.blockId } : evidence)}>{evidence.title}</button>}
              {resolved === "source-changed" ? <em> · source changed since the check</em> : null}
            </span>
          </li>;
        })}
      </ul> : null}
    </li>;
  }

  return (
    <div className="claims-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="claims-panel" role="dialog" aria-modal="true" aria-label={`Claims in ${title}`}>
        <header className="claims-head">
          <h2>Claims</h2>
          <span className="claims-source-title">in {title || "Untitled"}</span>
          <button type="button" className="claims-close" onClick={onClose} aria-label="Close">×</button>
        </header>
        <p className="claims-hint">Finds the claims this document makes and checks each against your other notes. Verdicts stay private and nothing in the document changes. Documents hidden from AI are never read.</p>
        <div className="claims-actions">
          {checking ? <>
            <span className="claims-progress" role="status">{progressLabel}</span>
            <button type="button" onClick={onStop}>Stop</button>
          </> : <button type="button" className="claims-primary" onClick={onCheck}>{run ? "Check again" : "Check claims"}</button>}
        </div>
        {state?.error ? <p className="claims-error" role="alert">{state.error}</p> : null}
        {state?.unsaved ? <p className="claims-error" role="status">These verdicts couldn't be saved to your account, so they show on this device only.</p> : null}
        {state?.status === "loading" ? <p className="claims-hint">Loading checked claims…</p> : null}
        {run && !checking ? <>
          {counts.length ? <p className="claims-summary">{counts.map(([verdict, count]) => `${count} ${VERDICT_LABELS[verdict].toLowerCase()}`).join(" · ")}</p>
            : !changed.length ? <p className="claims-summary">No checkable claims found in this document.</p> : null}
          <ol className="claims-list" ref={listRef}>
            {current.map((claim) => renderClaim(claim))}
            {changed.map((claim) => renderClaim(claim, true))}
          </ol>
          <details className="claims-receipt">
            <summary>How this was checked</summary>
            <dl>
              <dt>Checked</dt><dd>{new Date(run.finishedAt).toLocaleString()}</dd>
              <dt>Model</dt><dd>{run.models.join(", ") || "None"}</dd>
              <dt>Model calls</dt><dd>{run.modelCalls}</dd>
              <dt>Read</dt><dd>{run.passagesConsulted} passage{run.passagesConsulted === 1 ? "" : "s"} from {run.documentsConsulted.length} document{run.documentsConsulted.length === 1 ? "" : "s"} in your vault</dd>
            </dl>
            {run.omissions.length ? <ul>{run.omissions.map((omission) => <li key={omission}>{omission}</li>)}</ul> : null}
          </details>
        </> : null}
      </section>
    </div>
  );
}
