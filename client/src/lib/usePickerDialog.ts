import { useEffect, useRef, type RefObject } from "react";

/**
 * Shared behavior for the search-and-pick dialogs (groups, spaces): while open, the page behind
 * stops scrolling, the search box takes focus, Tab stays inside the dialog, Escape closes it, and
 * focus goes back to where it was when the dialog closes.
 */
export function usePickerDialog(isOpen: boolean, dialogRef: RefObject<HTMLElement | null>,
  inputRef: RefObject<HTMLInputElement | null>, onClose: () => void, onOpen?: () => void) {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const openRef = useRef(onOpen);
  openRef.current = onOpen;

  useEffect(() => {
    if (!isOpen) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    openRef.current?.();
    inputRef.current?.focus();

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        closeRef.current();
      } else if (event.key === "Tab") {
        const items = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>('button:not([disabled]):not([tabindex="-1"]), input:not([disabled])') ?? []);
        const first = items[0], last = items.at(-1);
        if (!first || !last) return;
        const outside = !dialogRef.current?.contains(document.activeElement);
        if (event.shiftKey && (document.activeElement === first || outside)) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && (document.activeElement === last || outside)) {
          event.preventDefault();
          first.focus();
        }
      }
    }
    function keepFocusInside(event: FocusEvent) {
      if (event.target instanceof Node && !dialogRef.current?.contains(event.target)) inputRef.current?.focus();
    }
    document.addEventListener("keydown", handleKeyDown, true);
    document.addEventListener("focusin", keepFocusInside);
    return () => {
      document.removeEventListener("keydown", handleKeyDown, true);
      document.removeEventListener("focusin", keepFocusInside);
      document.body.style.overflow = previousOverflow;
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, [isOpen, dialogRef, inputRef]);
}
