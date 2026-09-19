import { useEffect, useRef, useState } from "react";
import "./NotificationToast.css";

interface NotificationToastProps {
  message: string | null;
  kind?: "info" | "success" | "error";
  action?: { label: string; onClick: () => void | Promise<void> };
  onDismiss?: () => void;
  duration?: number;
  className?: string;
}

type NotificationControls = {
  dismiss: () => void;
  pause: (reason: "hover" | "focus") => void;
  resume: (reason: "hover" | "focus") => void;
};

/** A transient notice. Persistent validation and loading states should remain inline. */
export default function NotificationToast({
  message,
  kind = "info",
  action,
  onDismiss,
  duration = 8000,
  className = "",
}: NotificationToastProps) {
  const [visible, setVisible] = useState(Boolean(message));
  const controlsRef = useRef<NotificationControls | null>(null);
  const onDismissRef = useRef(onDismiss);
  const elementRef = useRef<HTMLDivElement>(null);
  onDismissRef.current = onDismiss;

  useEffect(() => {
    setVisible(Boolean(message));
    if (!message) return;

    let dismissed = false;
    let timer: number | null = null;
    let startedAt = 0;
    let remaining = Number.isFinite(duration) ? Math.max(0, duration) : 8000;
    const paused = new Set<"hover" | "focus">();
    // A new message can replace one while its action still holds keyboard focus.
    if (elementRef.current?.contains(document.activeElement)) paused.add("focus");
    if (elementRef.current?.matches(":hover")) paused.add("hover");

    function clearTimer() {
      if (timer !== null) window.clearTimeout(timer);
      timer = null;
    }

    function dismiss() {
      if (dismissed) return;
      dismissed = true;
      clearTimer();
      setVisible(false);
      onDismissRef.current?.();
    }

    function schedule() {
      if (dismissed || paused.size || timer !== null) return;
      startedAt = Date.now();
      timer = window.setTimeout(dismiss, remaining);
    }

    const controls: NotificationControls = {
      dismiss,
      pause(reason) {
        if (dismissed || paused.has(reason)) return;
        paused.add(reason);
        if (timer !== null) {
          remaining = Math.max(0, remaining - (Date.now() - startedAt));
          clearTimer();
        }
      },
      resume(reason) {
        paused.delete(reason);
        schedule();
      },
    };
    controlsRef.current = controls;
    schedule();
    return () => {
      clearTimer();
      if (controlsRef.current === controls) controlsRef.current = null;
    };
  }, [message, duration]);

  if (!visible || !message) return null;

  return (
    <div
      ref={elementRef}
      className={`notification-toast is-${kind}${className ? ` ${className}` : ""}`}
      role={kind === "error" ? "alert" : "status"}
      aria-atomic="true"
      onClick={() => controlsRef.current?.dismiss()}
      onMouseEnter={() => controlsRef.current?.pause("hover")}
      onMouseLeave={() => controlsRef.current?.resume("hover")}
      onFocusCapture={() => controlsRef.current?.pause("focus")}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) controlsRef.current?.resume("focus");
      }}
    >
      <span className="notification-toast-symbol" aria-hidden="true">{kind === "success" ? "✓" : kind === "error" ? "!" : "i"}</span>
      <div className="notification-toast-content">
        <p>{message}</p>
        {action ? <button className="notification-toast-action" onClick={(event) => {
          event.stopPropagation();
          controlsRef.current?.dismiss();
          void action.onClick();
        }} type="button">{action.label}</button> : null}
      </div>
      <button aria-label="Dismiss notification" className="notification-toast-close" title="Dismiss notification" onClick={(event) => {
        event.stopPropagation();
        controlsRef.current?.dismiss();
      }} type="button">
        <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="1.8"><path d="m6 6 12 12M6 18 18 6" /></svg>
      </button>
    </div>
  );
}
