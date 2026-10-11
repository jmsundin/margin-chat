import { useMemo, useState } from "react";

export interface ClusterMoveTarget {
  /** The cluster's id in the current layout. */
  id: string;
  label: string;
  /** A document that stays in the cluster; a moved document joins whichever cluster holds it. */
  anchorId: string;
}

/**
 * Lets the user move one document to another cluster, or back to automatic
 * placement. Self-contained so any cluster details panel can reuse it.
 */
export default function ClusterMoveMenu({ documentTitle, currentClusterId, targets, movedByHand, onMove }: {
  documentTitle: string;
  currentClusterId: string | null;
  targets: ClusterMoveTarget[];
  /** The document's cluster was chosen by hand rather than by subject. */
  movedByHand: boolean;
  onMove: (anchorId: string | null) => Promise<void> | void;
}) {
  const [error, setError] = useState<string | null>(null);
  const options = useMemo(() => [...targets].sort((a, b) => a.label.localeCompare(b.label)), [targets]);
  const choose = async (value: string) => {
    setError(null);
    try {
      if (value === "__automatic__") await onMove(null);
      else {
        const target = options.find((option) => option.id === value);
        if (target) await onMove(target.anchorId);
      }
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Moving the document failed.");
    }
  };
  return (
    <label className="graph-cluster-move">
      <span>Cluster</span>
      <select aria-label={`Cluster for ${documentTitle}`} value={currentClusterId ?? ""} onChange={(event) => void choose(event.target.value)}>
        {currentClusterId && !options.some((option) => option.id === currentClusterId) ? <option value={currentClusterId}>Unfiled</option> : null}
        {options.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
        {movedByHand ? <option value="__automatic__">Put back automatically</option> : null}
      </select>
      {error ? <span role="alert">{error}</span> : null}
    </label>
  );
}
