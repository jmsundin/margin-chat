import { useSyncExternalStore } from "react";

/**
 * The phone's stack of buttons at the bottom right, top to bottom: +, microphone,
 * back to top, keyboard. The keyboard provider draws the stack; the workspace and
 * the document put their buttons into its slots, so they line up without knowing
 * each other's size, and a missing one leaves no gap.
 */
export type MobileDockSlot = "create" | "mic" | "top";

let slots: Record<MobileDockSlot, HTMLElement | null> = { create: null, mic: null, top: null };
const listeners = new Set<() => void>();

export function setMobileDockSlot(name: MobileDockSlot, element: HTMLElement | null) {
  if (slots[name] === element) return;
  slots = { ...slots, [name]: element };
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** The slot's element while the row is on screen, otherwise null. */
export function useMobileDockSlot(name: MobileDockSlot) {
  return useSyncExternalStore(subscribe, () => slots[name], () => null);
}
