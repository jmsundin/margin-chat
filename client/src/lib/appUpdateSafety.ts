import { useLayoutEffect, useRef } from "react";

type Guard = { check(): string | null; busy?(): boolean; canReload?(): boolean; flush?(): Promise<void> };
const guards = new Map<symbol, { name: string; guard: Guard }>();
let locked = false;

export const isAppUpdateLocked = () => locked;
export const hasAppUpdateGuard = (name: string) => [...guards.values()].some((entry) => entry.name === name);
export const canReloadAfterAppUpdate = () => guards.size > 0 && [...guards.values()].every(({ guard }) => !guard.check() && (guard.canReload?.() ?? true));

export function registerAppUpdateGuard(name: string, guard: Guard) {
  const key = Symbol(name);
  guards.set(key, { name, guard });
  return () => { guards.delete(key); };
}

export function useAppUpdateGuard(name: string, guard: Guard) {
  const latest = useRef(guard);
  latest.current = guard;
  useLayoutEffect(() => registerAppUpdateGuard(name, {
    check: () => latest.current.check(),
    busy: () => latest.current.busy?.() ?? false,
    canReload: () => latest.current.canReload?.() ?? true,
    flush: async () => { await latest.current.flush?.(); },
  }), [name]);
}

export async function flushForAppUpdate() {
  if (!guards.size) throw new Error("A tab is still opening. Wait a moment and try again.");
  // Short operations can finish without a second click. Longer ones return a
  // useful reason before the worker's deadline, leaving the current app usable.
  const deadline = Date.now() + 6000;
  while ([...guards.values()].some(({ guard }) => guard.busy?.()) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const check = () => {
    if (document.querySelector('dialog[open], [role="dialog"][aria-modal="true"]')) {
      throw new Error("Finish or close the open dialog in each tab, then try again.");
    }
    for (const { guard } of guards.values()) {
      const reason = guard.check();
      if (reason) throw new Error(reason);
    }
  };
  check();
  for (const { guard } of guards.values()) await guard.flush?.();
  check();
}

// Prevent new input between a tab's durable save and the worker handover.
export function lockForAppUpdate(): () => void {
  if (locked) throw new Error("An update is already being prepared.");
  locked = true;
  const root = document.documentElement;
  const wasInert = root.inert;
  (document.activeElement as HTMLElement | null)?.blur?.();
  root.inert = true;
  return () => { root.inert = wasInert; locked = false; };
}
