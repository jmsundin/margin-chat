import { useEffect, useEffectEvent, type RefObject } from "react";

/** Treat the popup and its trigger as one boundary, even when either is portaled. */
export function useOutsideDismiss(
  enabled: boolean,
  onDismiss: () => void,
  ...boundaries: RefObject<HTMLElement | null>[]
) {
  const handleOutside = useEffectEvent((event: Event) => {
    if (!(event.target instanceof Node)) return;
    if (boundaries.some(({ current }) => current?.contains(event.target as Node))) return;
    // A nested modal may live in a portal. Keep its underlying popup mounted
    // until that modal (including its backdrop) has handled the interaction.
    const modalAbove = [...document.querySelectorAll<HTMLElement>('[aria-modal="true"], dialog[open]')]
      .some((modal) => !boundaries.some(({ current }) => current && (current.contains(modal) || modal.contains(current))));
    if (modalAbove) return;
    onDismiss();
  });

  useEffect(() => {
    if (!enabled) return;
    // Capture runs before graph/editor controls stop propagation. The click
    // listener also handles keyboard and assistive-technology activation.
    document.addEventListener("pointerdown", handleOutside, true);
    document.addEventListener("click", handleOutside, true);
    return () => {
      document.removeEventListener("pointerdown", handleOutside, true);
      document.removeEventListener("click", handleOutside, true);
    };
  }, [enabled]);
}
