import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";

/**
 * On a computer with the quiet page and one document open, the workspace's top row only held the
 * sidebar button, the Map button and Ask, so a whole row of the screen sat empty above the page.
 * That row now floats over the top of the page instead. The documents' own headers under it keep
 * their buttons and words clear of the floating ones by widening their padding on that side.
 */
const CLEARS = ".document-panel > .document-header";
const GAP = 8;

type Edges = { left: number; right: number; bottom: number };

/** The inner edges of the floating buttons: the right edge of those on the left, the left edge of those on the right. */
export function floatingEdges(toolbar: HTMLElement): Edges | null {
  const box = toolbar.getBoundingClientRect();
  if (!box.width) return null;
  const middle = box.left + box.width / 2;
  let left = box.left, right = box.right, bottom = box.top;
  for (const child of Array.from(toolbar.children)) {
    for (const item of child.classList.contains("document-workspace-actions") ? Array.from(child.children) : [child]) {
      const rect = item.getBoundingClientRect();
      if (!rect.width || !rect.height) continue;
      if (rect.left + rect.width / 2 < middle) left = Math.max(left, rect.right);
      else right = Math.min(right, rect.left);
      bottom = Math.max(bottom, rect.bottom);
    }
  }
  return { left, right, bottom };
}

/** How much more room an element needs on each side so its contents stay clear of the floating buttons. */
export function clearance(target: { left: number; right: number; top: number }, padding: { left: number; right: number }, edges: Edges) {
  if (target.top >= edges.bottom) return { left: 0, right: 0 };
  return {
    left: Math.max(0, Math.ceil(edges.left + GAP - (target.left + padding.left))),
    right: Math.max(0, Math.ceil(target.right - padding.right - (edges.right - GAP))),
  };
}

function overlaps(a: DOMRect, b: DOMRect) {
  return a.width > 0 && a.height > 0 && a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
}

function reset(element: HTMLElement) {
  if (!element.dataset.floatClear) return;
  element.style.removeProperty("padding-left");
  element.style.removeProperty("padding-right");
  delete element.dataset.floatClear;
}

/** Pads each element the floating buttons cover; with nothing floating, takes the padding back. */
export function clearFloatingHeader(bar: HTMLElement, floating: boolean) {
  const workspace = bar.parentElement;
  const toolbar = bar.firstElementChild as HTMLElement | null;
  if (!workspace) return;
  const targets = Array.from(workspace.querySelectorAll<HTMLElement>(CLEARS));
  targets.forEach(reset);
  // The docked Map draws its own sidebar button in the same corner: show one, not two on top of each other.
  const own = toolbar?.querySelector<HTMLElement>(":scope > .workspace-menu-button");
  const map = floating && own ? Array.from(document.querySelectorAll<HTMLElement>(".knowledge-map-sidebar-toggle")).find((button) => overlaps(button.getBoundingClientRect(), own.getBoundingClientRect())) : undefined;
  if (map) bar.dataset.underMapToggle = "true"; else delete bar.dataset.underMapToggle;
  const edges = floating && toolbar ? floatingEdges(toolbar) : null;
  if (!edges) return;
  for (const target of targets) {
    const style = getComputedStyle(target);
    const padding = { left: parseFloat(style.paddingLeft) || 0, right: parseFloat(style.paddingRight) || 0 };
    const need = clearance(target.getBoundingClientRect(), padding, edges);
    if (!need.left && !need.right) continue;
    if (need.left) target.style.paddingLeft = `${padding.left + need.left}px`;
    if (need.right) target.style.paddingRight = `${padding.right + need.right}px`;
    target.dataset.floatClear = "true";
  }
}

export function useFloatingHeaderClearance(header: RefObject<HTMLElement | null>, floating: boolean) {
  const observer = useRef<ResizeObserver | null>(null);

  useEffect(() => {
    const bar = header.current;
    if (!floating || !bar || typeof ResizeObserver === "undefined") return;
    let frame = 0;
    // Resizing the window or a panel re-renders nothing, so it measures again by itself.
    const watcher = new ResizeObserver(() => {
      if (!frame) frame = requestAnimationFrame(() => { frame = 0; clearFloatingHeader(bar, true); });
    });
    observer.current = watcher;
    if (bar.parentElement) watcher.observe(bar.parentElement);
    watcher.observe(bar);
    return () => { watcher.disconnect(); observer.current = null; if (frame) cancelAnimationFrame(frame); };
  }, [header, floating]);

  // Documents open, close and change width through React state, so measure after every render.
  useLayoutEffect(() => {
    const bar = header.current;
    if (!bar) return;
    clearFloatingHeader(bar, floating);
    bar.parentElement?.querySelectorAll(".panel-slot").forEach((element) => observer.current?.observe(element));
  });
}
