import { useEffect, useRef, useState } from "react";
import type { GraphViewport } from "./graphInteractions";

/** Keep camera frames cheap: admit one visible document at a time after two quiet frames. */
export function useGraphContentQueue(keys: string[], viewport: GraphViewport, active: boolean) {
  const [ready, setReady] = useState<ReadonlySet<string>>(() => new Set());
  const admitted = useRef(new Set<string>());
  const keySignature = JSON.stringify(keys);

  useEffect(() => {
    if (!active) return;
    const eligible = new Set<string>(JSON.parse(keySignature));
    const retained = new Set([...admitted.current].filter((key) => eligible.has(key)));
    if (retained.size !== admitted.current.size) {
      admitted.current = retained;
      setReady(retained);
    }
    const pending = [...eligible].filter((key) => !retained.has(key));
    if (!pending.length) return;
    let frame = 0;
    let cancelled = false;
    function admitNext() {
      if (cancelled) return;
      const key = pending.shift();
      if (!key) return;
      admitted.current = new Set(admitted.current).add(key);
      setReady(admitted.current);
      if (pending.length) frame = window.requestAnimationFrame(admitNext);
    }
    // A new camera position cancels this queue, leaving skeletons while moving.
    // Loaded documents that remain visible keep their editor and selection.
    frame = window.requestAnimationFrame(() => {
      frame = window.requestAnimationFrame(admitNext);
    });
    return () => { cancelled = true; window.cancelAnimationFrame(frame); };
  }, [keySignature, viewport.x, viewport.y, viewport.scale, active]);

  return ready;
}
