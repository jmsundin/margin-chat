import { useCallback, useEffect, useRef, useState } from "react";
import { libraryApi, type LibraryField, type LibraryMap } from "./api";

export type LibraryProgress = { fieldId: string; stage: "importing" | "laying-out"; fetched: number; target: number; embedded: number } | null;

/**
 * The reader's PubMed fields and the one shown on the Landscape. Adding a
 * field imports it a batch at a time (each request fetches and embeds about
 * 200 papers), then lays it out; a field left half-imported resumes when it
 * is opened again.
 */
export function useLibrary({ userId, enabled, active }: { userId: string; enabled: boolean; active: boolean }) {
  const [fields, setFields] = useState<LibraryField[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [map, setMap] = useState<LibraryMap | null>(null);
  const [progress, setProgress] = useState<LibraryProgress>(null);
  const [error, setError] = useState<string | null>(null);
  const runRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!userId || !enabled || !active) return;
    let cancelled = false;
    libraryApi.list(userId).then((result) => { if (!cancelled) setFields(result.fields); }).catch(() => {});
    return () => { cancelled = true; };
  }, [userId, enabled, active]);

  /** Imports what is missing, lays out if needed, then loads the field's map. */
  const open = useCallback(async (field: LibraryField) => {
    runRef.current?.abort();
    const controller = new AbortController();
    runRef.current = controller;
    setSelectedId(field.id); setError(null); setMap(null);
    try {
      let current = field;
      const complete = (item: LibraryField) => (item.fetched >= item.target || (item.available !== null && item.fetched >= item.available)) && item.embedded >= item.works;
      let imported = false;
      while (!complete(current)) {
        imported = true;
        setProgress({ fieldId: field.id, stage: "importing", fetched: current.works, target: Math.min(current.target, current.available ?? current.target), embedded: current.embedded });
        const step = await libraryApi.importStep(field.id, controller.signal, userId);
        current = step.field;
        setFields((list) => list.map((item) => item.id === current.id ? current : item));
        if (step.done) break;
      }
      let result: LibraryMap;
      // Papers added since the last layout need one; otherwise the stored one is shown.
      if (!current.laidOutAt || imported) {
        setProgress({ fieldId: field.id, stage: "laying-out", fetched: current.works, target: current.target, embedded: current.embedded });
        result = await libraryApi.layout(field.id, controller.signal, userId);
      } else result = await libraryApi.map(field.id, controller.signal, userId);
      if (controller.signal.aborted) return;
      setMap(result);
      setFields((list) => list.map((item) => item.id === result.field.id ? result.field : item));
    } catch (failure) {
      if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : "Loading the field failed.");
    } finally {
      if (runRef.current === controller) { setProgress(null); runRef.current = null; }
    }
  }, [userId]);

  const add = useCallback(async (query: string, size: number) => {
    setError(null);
    try {
      const { field } = await libraryApi.create(query, size, userId);
      setFields((list) => [...list, field]);
      await open(field);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Adding the field failed.");
    }
  }, [open, userId]);

  const remove = useCallback(async (fieldId: string) => {
    await libraryApi.remove(fieldId, userId);
    setFields((list) => list.filter((item) => item.id !== fieldId));
    if (selectedId === fieldId) { runRef.current?.abort(); setSelectedId(null); setMap(null); }
  }, [selectedId, userId]);

  const showVault = useCallback(() => { runRef.current?.abort(); setSelectedId(null); setMap(null); setProgress(null); setError(null); }, []);
  useEffect(() => () => runRef.current?.abort(), []);

  return { fields, selectedId, map, progress, error, open, add, remove, showVault };
}
