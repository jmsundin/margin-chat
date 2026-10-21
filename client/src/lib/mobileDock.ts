import { useSyncExternalStore } from "react";

/**
 * The phone's bottom row of buttons: microphone, +, keyboard. The keyboard
 * provider draws the row; voice typing and the workspace put their buttons
 * into its slots, so all three line up without knowing each other's size.
 */
export type MobileDockSlot = "mic" | "create";

let slots: Record<MobileDockSlot, HTMLElement | null> = { mic: null, create: null };
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
