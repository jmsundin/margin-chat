/**
 * The workspace frame sits on top of the page. A wheel that nothing inside the
 * frame can use (Map toolbars and cards, a document already at its end) would
 * otherwise scroll the page underneath. overscroll-behavior cannot stop that
 * here because the frame's own document never scrolls.
 */

const SCROLLABLE = /^(auto|scroll|overlay)$/;

/** Whether `element` or one of its ancestors can still scroll by this wheel. */
export function wheelHasScrollTarget(element: Element | null, deltaX: number, deltaY: number): boolean {
  for (let node = element; node; node = node.parentElement) {
    const style = getComputedStyle(node);
    if (deltaY && SCROLLABLE.test(style.overflowY) && node.scrollHeight > node.clientHeight + 1) {
      if (deltaY > 0 ? node.scrollTop + node.clientHeight < node.scrollHeight - 1 : node.scrollTop > 0) return true;
      if (/^(contain|none)$/.test(style.overscrollBehaviorY)) return true;
    }
    if (deltaX && SCROLLABLE.test(style.overflowX) && node.scrollWidth > node.clientWidth + 1) {
      if (deltaX > 0 ? node.scrollLeft + node.clientWidth < node.scrollWidth - 1 : node.scrollLeft > 0) return true;
      if (/^(contain|none)$/.test(style.overscrollBehaviorX)) return true;
    }
  }
  return false;
}

export function containWheelScrolling(target: Window = window) {
  const handle = (event: WheelEvent) => {
    // Pinch and Ctrl-wheel belong to the map or to the browser's zoom.
    if (event.defaultPrevented || event.ctrlKey || event.metaKey) return;
    const element = (event.target as Node | null)?.nodeType === 1 ? event.target as Element : null;
    if (!wheelHasScrollTarget(element, event.deltaX, event.deltaY)) event.preventDefault();
  };
  target.addEventListener("wheel", handle, { passive: false });
  return () => target.removeEventListener("wheel", handle);
}
