import { useEffect, useRef, useState } from "react";
import {
  edgeSwipeCandidates, lockEdgeSwipe, searchPullDistance, searchPullTriggers, settleSidebarOpen, sidebarDragOffset,
  type EdgeSwipeKind,
} from "../lib/edgeSwipe";
import "./MobileEdgeSwipe.css";

const SIDEBAR_SELECTOR = ".thread-sidebar";
const SETTLE_MS = 220;

type Gesture = {
  id: number;
  x: number;
  y: number;
  candidates: EdgeSwipeKind[];
  kind: EdgeSwipeKind | null;
  width: number;
  offset: number;
  dy: number;
  samples: { x: number; t: number }[];
};

/**
 * The candidates left once the touched elements have their say: drag grips, sliders,
 * canvases and dialogs own their touches, unless they hand a gesture back with data-edge-swipe-allow.
 */
function allowedCandidates(target: EventTarget | null, candidates: EdgeSwipeKind[]): EdgeSwipeKind[] {
  if (!(target instanceof Element)) return candidates;
  if (target.closest("input, textarea, select, [role='dialog'], [aria-modal='true']")) return [];
  for (let element: Element | null = target; element && element !== document.body; element = element.parentElement) {
    const allow = element.getAttribute("data-edge-swipe-allow");
    if (allow !== null) return candidates.filter((kind) => allow.split(" ").includes(kind));
    if (getComputedStyle(element).touchAction === "none") return [];
  }
  return candidates;
}

/**
 * iOS raises the keyboard only for a focus made during the touch itself. Search focuses its box
 * after it renders, so hold the keyboard open with a stand-in field until then.
 */
function holdKeyboardOpen() {
  const field = document.createElement("input");
  field.setAttribute("aria-hidden", "true");
  field.tabIndex = -1;
  field.style.cssText = "position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;font-size:16px;pointer-events:none;";
  document.body.append(field);
  field.addEventListener("blur", () => field.remove(), { once: true });
  field.focus({ preventScroll: true });
  window.setTimeout(() => field.remove(), 1000);
}

/**
 * Phone gestures: swipe in from the left edge to pull out the sidebar (or swipe it back),
 * and pull down from the top bar to open search.
 */
export default function MobileEdgeSwipe({ disabled, sidebarOpen, onCloseSidebar, onOpenSearch, onOpenSidebar }: {
  disabled: boolean;
  sidebarOpen: boolean;
  onCloseSidebar: () => void;
  onOpenSearch: () => void;
  onOpenSidebar: () => void;
}) {
  /** How far the finger has pulled down from the top bar. */
  const [pull, setPull] = useState(0);
  const latest = useRef({ disabled, sidebarOpen, onCloseSidebar, onOpenSearch, onOpenSidebar });
  latest.current = { disabled, sidebarOpen, onCloseSidebar, onOpenSearch, onOpenSidebar };

  useEffect(() => {
    const root = document.documentElement;
    let gesture: Gesture | null = null;
    let settleTimer = 0;

    const setOffset = (offset: number, width: number) => {
      root.style.setProperty("--edge-swipe-sidebar-x", `${offset}px`);
      root.style.setProperty("--edge-swipe-progress", String(1 + offset / width));
    };
    const clearDrag = () => {
      root.classList.remove("is-edge-swiping-sidebar", "is-edge-swipe-closing");
      root.style.removeProperty("--edge-swipe-sidebar-x");
      root.style.removeProperty("--edge-swipe-progress");
    };

    const start = (event: TouchEvent) => {
      gesture = null;
      const { disabled, sidebarOpen } = latest.current;
      if (disabled || event.touches.length !== 1 || settleTimer) return;
      const touch = event.touches[0];
      const candidates = allowedCandidates(event.target, edgeSwipeCandidates({ x: touch.clientX, y: touch.clientY, sidebarOpen }));
      if (!candidates.length) return;
      // Leave selection handles alone while text is selected.
      if (!sidebarOpen && !(window.getSelection()?.isCollapsed ?? true)) return;
      gesture = { id: touch.identifier, x: touch.clientX, y: touch.clientY, candidates, kind: null, width: 0, offset: 0, dy: 0,
        samples: [{ x: touch.clientX, t: event.timeStamp }] };
    };

    const move = (event: TouchEvent) => {
      const current = gesture;
      const touch = current && [...event.changedTouches].find((item) => item.identifier === current.id);
      if (!current || !touch) return;
      const dx = touch.clientX - current.x;
      const dy = touch.clientY - current.y;
      if (!current.kind) {
        const lock = lockEdgeSwipe(current.candidates, dx, dy);
        if (lock === "pending") return;
        if (lock === "none" || !event.cancelable) { gesture = null; return; }
        current.kind = lock;
        if (lock !== "pull-search") {
          const sidebar = document.querySelector<HTMLElement>(SIDEBAR_SELECTOR);
          current.width = sidebar && lock === "close-sidebar" ? sidebar.getBoundingClientRect().width : Math.min(340, window.innerWidth * 0.88);
          root.classList.add("is-edge-swiping-sidebar");
          setOffset(sidebarDragOffset(lock, dx, current.width), current.width);
          if (lock === "open-sidebar") latest.current.onOpenSidebar();
        }
      }
      event.preventDefault();
      current.samples = [...current.samples.filter((sample) => event.timeStamp - sample.t < 100), { x: touch.clientX, t: event.timeStamp }];
      if (current.kind === "pull-search") {
        current.dy = dy;
        setPull(Math.max(0, dy));
      } else {
        current.offset = sidebarDragOffset(current.kind, dx, current.width);
        setOffset(current.offset, current.width);
      }
    };

    const end = (event: TouchEvent) => {
      const current = gesture;
      if (!current || ![...event.changedTouches].some((item) => item.identifier === current.id)) return;
      gesture = null;
      if (!current.kind) return;
      if (current.kind === "pull-search") {
        setPull(0);
        if (event.type === "touchend" && searchPullTriggers(current.dy)) {
          holdKeyboardOpen();
          latest.current.onOpenSearch();
        }
        return;
      }
      const first = current.samples[0];
      const last = current.samples[current.samples.length - 1];
      const velocity = last.t > first.t ? (last.x - first.x) / (last.t - first.t) : 0;
      const open = event.type === "touchend" && settleSidebarOpen(current.offset, current.width, velocity);
      if (open) {
        // The sidebar's own transition carries it the rest of the way in.
        clearDrag();
        return;
      }
      root.classList.add("is-edge-swipe-closing");
      settleTimer = window.setTimeout(() => {
        settleTimer = 0;
        latest.current.onCloseSidebar();
        clearDrag();
      }, SETTLE_MS);
    };

    document.addEventListener("touchstart", start, { passive: true });
    document.addEventListener("touchmove", move, { passive: false });
    document.addEventListener("touchend", end);
    document.addEventListener("touchcancel", end);
    return () => {
      document.removeEventListener("touchstart", start);
      document.removeEventListener("touchmove", move);
      document.removeEventListener("touchend", end);
      document.removeEventListener("touchcancel", end);
      window.clearTimeout(settleTimer);
      clearDrag();
    };
  }, []);

  if (!pull) return null;
  const ready = searchPullTriggers(pull);
  return <div aria-hidden="true" className={`mobile-search-pull${ready ? " is-ready" : ""}`} style={{ transform: `translate(-50%, ${searchPullDistance(pull) - 52}px)` }}>
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
    <span>{ready ? "Release to search" : "Pull to search"}</span>
  </div>;
}
