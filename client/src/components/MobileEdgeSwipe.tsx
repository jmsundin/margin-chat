import { useEffect, useRef, useState } from "react";
import {
  edgeSwipeCandidates, lockEdgeSwipe, rightSwipeLean, settleOpenRight, settleSidebarOpen, sidebarDragOffset, syncPullDistance, syncPullTriggers,
  type EdgeSwipeKind,
} from "../lib/edgeSwipe";
import { FRAME_EDGE_TOUCH_EVENT, OPEN_RIGHT_EVENT, rightPanelFor, setEdgeSwipesOn, type FrameEdgeTouch } from "../lib/frameEdgeSwipe";
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
  /** What a right-edge swipe opens, and how far it has moved. */
  right: HTMLElement | null;
  dx: number;
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
 * swipe in from the right edge of an HTML page to show its notes, and pull down on a document or the open sidebar, scrolled to its top, to sync the cloud vault.
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

  // HTML pages' frames pass up swipes from their edges only while these gestures are on.
  useEffect(() => {
    setEdgeSwipesOn(!disabled);
    return () => setEdgeSwipesOn(false);
  }, [disabled]);

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

    /** One finger, from a real touch on the app or one an HTML page's frame passed up. */
    type Point = { id: number; x: number; y: number; t: number; cancelable: boolean; preventDefault: () => void };

    const begin = (point: Point, target: EventTarget | null, fromFrame: boolean) => {
      gesture = null;
      const { canSync, disabled, sidebarOpen } = latest.current;
      if (disabled || settleTimer) return;
      if (ownsTouch(target) || (target instanceof Element && target.closest(".is-html-full-screen"))) return;
      const pulled = fromFrame || !canSync ? null : sidebarOpen ? sidebarAtTop(target) : documentAtTop(target);
      const right = rightPanelFor(target);
      const candidates = edgeSwipeCandidates({ x: point.x, sidebarOpen, canPullSync: Boolean(pulled), canOpenRight: Boolean(right), viewportWidth: window.innerWidth });
      if (!candidates.length) return;
      // Leave selection handles alone while text is selected.
      if (!sidebarOpen && !(window.getSelection()?.isCollapsed ?? true)) return;
      gesture = { id: point.id, x: point.x, y: point.y, candidates, kind: null, width: 0, offset: 0, dy: 0, dx: 0, right,
        pullTop: pulled?.getBoundingClientRect().top ?? 0,
        samples: [{ x: point.x, t: point.t }] };
    };

    const track = (point: Point) => {
      const current = gesture;
      if (!current || point.id !== current.id) return;
      const dx = point.x - current.x;
      const dy = point.y - current.y;
      if (!current.kind) {
        const lock = lockEdgeSwipe(current.candidates, dx, dy);
        if (lock === "pending") return;
        if (lock === "none" || !point.cancelable) { gesture = null; return; }
        current.kind = lock;
        if (lock === "open-right") root.classList.add("is-edge-swiping-right");
        else if (lock !== "pull-sync") {
          const sidebar = document.querySelector<HTMLElement>(SIDEBAR_SELECTOR);
          current.width = sidebar && lock === "close-sidebar" ? sidebar.getBoundingClientRect().width : Math.min(340, window.innerWidth * 0.88);
          root.classList.add("is-edge-swiping-sidebar");
          setOffset(sidebarDragOffset(lock, dx, current.width), current.width);
          if (lock === "open-sidebar") latest.current.onOpenSidebar();
        }
      }
      point.preventDefault();
      current.samples = [...current.samples.filter((sample) => point.t - sample.t < 100), { x: point.x, t: point.t }];
      if (current.kind === "pull-sync") {
        current.dy = dy;
        setPull({ distance: Math.max(0, dy), top: current.pullTop });
      } else if (current.kind === "open-right") {
        current.dx = dx;
        root.style.setProperty("--edge-swipe-right-x", `${rightSwipeLean(dx)}px`);
      } else {
        current.offset = sidebarDragOffset(current.kind, dx, current.width);
        setOffset(current.offset, current.width);
      }
    };

    const finish = (id: number, completed: boolean) => {
      const current = gesture;
      if (!current || id !== current.id) return;
      gesture = null;
      if (!current.kind) return;
      if (current.kind === "pull-sync") {
        setPull({ distance: 0, top: 0 });
        if (completed && syncPullTriggers(current.dy)) latest.current.onSync();
        return;
      }
      const first = current.samples[0];
      const last = current.samples[current.samples.length - 1];
      const velocity = last.t > first.t ? (last.x - first.x) / (last.t - first.t) : 0;
      if (current.kind === "open-right") {
        root.classList.remove("is-edge-swiping-right");
        root.style.removeProperty("--edge-swipe-right-x");
        if (completed && current.right?.isConnected && settleOpenRight(current.dx, velocity)) current.right.dispatchEvent(new CustomEvent(OPEN_RIGHT_EVENT));
        return;
      }
      const open = completed && settleSidebarOpen(current.offset, current.width, velocity);
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

    const touchPoint = (event: TouchEvent, touch: Touch): Point => ({ id: touch.identifier, x: touch.clientX, y: touch.clientY, t: event.timeStamp,
      cancelable: event.cancelable, preventDefault: () => event.preventDefault() });
    const start = (event: TouchEvent) => {
      if (event.touches.length !== 1) { gesture = null; return; }
      begin(touchPoint(event, event.touches[0]), event.target, false);
    };
    const move = (event: TouchEvent) => {
      const current = gesture;
      const touch = current && [...event.changedTouches].find((item) => item.identifier === current.id);
      if (touch) track(touchPoint(event, touch));
    };
    const end = (event: TouchEvent) => {
      const current = gesture;
      if (current && [...event.changedTouches].some((item) => item.identifier === current.id)) finish(current.id, event.type === "touchend");
    };
    // Touches inside an HTML page never reach the app; the page's frame passes up swipes in from its edges, already in screen coordinates.
    const FRAME_TOUCH_ID = -1;
    const frameTouch = (event: Event) => {
      const { phase, x, y, t, frame } = (event as CustomEvent<FrameEdgeTouch>).detail;
      const point: Point = { id: FRAME_TOUCH_ID, x, y, t, cancelable: true, preventDefault: () => undefined };
      if (phase === "start") begin(point, frame, true);
      else if (phase === "move") track(point);
      else { track(point); finish(FRAME_TOUCH_ID, phase === "end"); }
    };

    document.addEventListener("touchstart", start, { passive: true });
    document.addEventListener("touchmove", move, { passive: false });
    document.addEventListener("touchend", end);
    document.addEventListener("touchcancel", end);
    window.addEventListener(FRAME_EDGE_TOUCH_EVENT, frameTouch);
    return () => {
      document.removeEventListener("touchstart", start);
      document.removeEventListener("touchmove", move);
      document.removeEventListener("touchend", end);
      document.removeEventListener("touchcancel", end);
      window.removeEventListener(FRAME_EDGE_TOUCH_EVENT, frameTouch);
      window.clearTimeout(settleTimer);
      clearDrag();
      root.classList.remove("is-edge-swiping-right");
      root.style.removeProperty("--edge-swipe-right-x");
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
