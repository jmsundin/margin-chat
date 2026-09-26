import { useRef, useState, type ComponentPropsWithoutRef } from "react";
import { useOutsideDismiss } from "../lib/useOutsideDismiss";

/** Native details behavior for menus, with outside dismissal while open. */
export default function DismissibleDetails({ onToggle, onKeyDown, ...props }: ComponentPropsWithoutRef<"details">) {
  const ref = useRef<HTMLDetailsElement>(null);
  const [open, setOpen] = useState(Boolean(props.open));
  useOutsideDismiss(open, () => {
    if (ref.current) ref.current.open = false;
    setOpen(false);
  }, ref);

  return <details {...props} ref={ref}
    onToggle={(event) => { setOpen(event.currentTarget.open); onToggle?.(event); }}
    onKeyDown={(event) => {
      onKeyDown?.(event);
      if (event.key === "Escape" && !event.defaultPrevented) {
        event.stopPropagation();
        event.currentTarget.open = false;
        event.currentTarget.querySelector<HTMLElement>("summary")?.focus();
      }
    }} />;
}
