import { useEffect, useRef, useState } from "react";
import {
  edgeSwipeCandidates, lockEdgeSwipe, settleSidebarOpen, sidebarDragOffset, syncPullDistance, syncPullTriggers,
  type EdgeSwipeKind,
} from "../lib/edgeSwipe";
import "./MobileEdgeSwipe.css";

const SIDEBAR_SELECTOR = ".thread-sidebar";
const DOCUMENT_BODY_SELECTOR = ".panel-body";
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
  /** Top of the document or sidebar the sync pull started on, where its hint appears. */
  pullTop: number;
  samples: { x: number; t: number }[];
};

/**
 * The candidates left once the touched elements have their say: drag grips, sliders,
 * canvases and dialogs own their touches.
 */
function ownsTouch(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  if (target.closest("input, textarea, select, [role='dialog'], [aria-modal='true']")) return true;
  for (let element: Element | null = target; element && element !== document.body; element = element.parentElement) {
    if (getComputedStyle(element).touchAction === "none") return true;
  }
  return false;
}

/** The document body under the touch when it is scrolled to its top, so a pull down has nothing to scroll. */
function documentAtTop(target: EventTarget | null): HTMLElement | null {
  const body = target instanceof Element ? target.closest<HTMLElement>(DOCUMENT_BODY_SELECTOR) : null;
  return body && body.scrollTop <= 0 ? body : null;
}

/** The open sidebar under the touch when every list it is in is scrolled to its top. */
function sidebarAtTop(target: EventTarget | null): HTMLElement | null {
  const sidebar = target instanceof Element ? target.closest<HTMLElement>(SIDEBAR_SELECTOR) : null;
  if (!sidebar) return null;
  for (let element = target as Element | null; element && element !== sidebar; element = element.parentElement) {
    if (element.scrollTop > 0) return null;
  }
  return sidebar.scrollTop > 0 ? null : sidebar;
}

/**
 * Phone gestures: swipe in from the left edge to pull out the sidebar (or swipe it back),
 * and pull down on a document or the open sidebar, scrolled to its top, to sync the cloud vault.
 */
export default function MobileEdgeSwipe({ canSync, disabled, sidebarOpen, onCloseSidebar, onOpenSidebar, onSync }: {
  /** The vault syncs to the cloud, so a pull down has something to do. */
  canSync: boolean;
  disabled: boolean;
  sidebarOpen: boolean;
  onCloseSidebar: () => void;
  onOpenSidebar: () => void;
  onSync: () => void;
}) {
  /** How far the finger has pulled down, and the top of the document or sidebar it is pulling. */
  const [pull, setPull] = useState({ distance: 0, top: 0 });
  const latest = useRef({ canSync, disabled, sidebarOpen, onCloseSidebar, onOpenSidebar, onSync });
  latest.current = { canSync, disabled, sidebarOpen, onCloseSidebar, onOpenSidebar, onSync };

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
      const { canSync, disabled, sidebarOpen } = latest.current;
      if (disabled || event.touches.length !== 1 || settleTimer) return;
      const touch = event.touches[0];
      if (ownsTouch(event.target)) return;
      const pulled = !canSync ? null : sidebarOpen ? sidebarAtTop(event.target) : documentAtTop(event.target);
      const candidates = edgeSwipeCandidates({ x: touch.clientX, sidebarOpen, canPullSync: Boolean(pulled) });
      if (!candidates.length) return;
      // Leave selection handles alone while text is selected.
      if (!sidebarOpen && !(window.getSelection()?.isCollapsed ?? true)) return;
      gesture = { id: touch.identifier, x: touch.clientX, y: touch.clientY, candidates, kind: null, width: 0, offset: 0, dy: 0,
        pullTop: pulled?.getBoundingClientRect().top ?? 0,
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
        if (lock !== "pull-sync") {
          const sidebar = document.querySelector<HTMLElement>(SIDEBAR_SELECTOR);
          current.width = sidebar && lock === "close-sidebar" ? sidebar.getBoundingClientRect().width : Math.min(340, window.innerWidth * 0.88);
          root.classList.add("is-edge-swiping-sidebar");
          setOffset(sidebarDragOffset(lock, dx, current.width), current.width);
          if (lock === "open-sidebar") latest.current.onOpenSidebar();
        }
      }
      event.preventDefault();
      current.samples = [...current.samples.filter((sample) => event.timeStamp - sample.t < 100), { x: touch.clientX, t: event.timeStamp }];
      if (current.kind === "pull-sync") {
        current.dy = dy;
        setPull({ distance: Math.max(0, dy), top: current.pullTop });
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
      if (current.kind === "pull-sync") {
        setPull({ distance: 0, top: 0 });
        if (event.type === "touchend" && syncPullTriggers(current.dy)) latest.current.onSync();
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

  if (!pull.distance) return null;
  const ready = syncPullTriggers(pull.distance);
  return <div aria-hidden="true" className={`mobile-sync-pull${ready ? " is-ready" : ""}`}
    style={{ top: pull.top, opacity: Math.min(1, pull.distance / 40), transform: `translate(-50%, ${syncPullDistance(pull.distance) - 40}px)` }}>
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
      style={{ transform: `rotate(${Math.min(1, pull.distance / 72) * 180}deg)` }}>
      <path d="M21 12a9 9 0 1 1-2.64-6.36" /><path d="M21 3v6h-6" />
    </svg>
    <span>{ready ? "Release to sync" : "Pull to sync"}</span>
  </div>;
}
