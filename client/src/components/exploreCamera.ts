import { useCallback, useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";

/** A callback ref and the element's size, kept up to date; works when the element comes and goes. */
export function useSize<T extends HTMLElement>() {
  const [element, setElement] = useState<T | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    if (!element) return;
    const measure = () => setSize((current) => current.width === element.clientWidth && current.height === element.clientHeight ? current
      : { width: element.clientWidth, height: element.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [element]);
  return [setElement, size, element] as const;
}

export interface Camera { x: number; y: number; k: number }

/**
 * A camera over circles in world units: pan by dragging, zoom with the wheel or two fingers around
 * the pointer, and fly smoothly to a circle. Zoom stays between `bounds.min` and `bounds.max`.
 */
export function useCirclesCamera(element: HTMLElement | null, bounds: { min: number; max: number }) {
  const [camera, setCamera] = useState<Camera>({ x: 0, y: 0, k: 1 });
  const cameraRef = useRef(camera);
  cameraRef.current = camera;
  const animation = useRef(0);
  const boundsRef = useRef(bounds);
  boundsRef.current = bounds;

  const fly = useCallback((to: Camera, animate = true) => {
    cancelAnimationFrame(animation.current);
    const reduce = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (!animate || reduce) { setCamera(to); return; }
    const from = cameraRef.current, start = performance.now(), duration = 520;
    // Zoom moves in log space so it feels even; the point being flown to stays on its line.
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / duration), ease = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
      const k = Math.exp(Math.log(from.k) + (Math.log(to.k) - Math.log(from.k)) * ease);
      setCamera({ k, x: from.x + (to.x - from.x) * ease, y: from.y + (to.y - from.y) * ease });
      if (t < 1) animation.current = requestAnimationFrame(step);
    };
    animation.current = requestAnimationFrame(step);
  }, []);
  useEffect(() => () => cancelAnimationFrame(animation.current), []);

  const zoomAround = useCallback((factor: number, px: number, py: number) => {
    cancelAnimationFrame(animation.current);
    setCamera((current) => {
      const { min, max } = boundsRef.current;
      const nextK = Math.max(Math.min(min, current.k), Math.min(Math.max(max, current.k), current.k * factor));
      const f = nextK / current.k;
      return { k: nextK, x: px - (px - current.x) * f, y: py - (py - current.y) * f };
    });
  }, []);
  useEffect(() => {
    if (!element) return;
    const wheel = (event: WheelEvent) => {
      // The map under these layouts has its own wheel zoom; this one is the only one that should move.
      event.preventDefault(); event.stopPropagation();
      const box = element.getBoundingClientRect();
      const delta = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY;
      if (Math.abs(delta) > 0) zoomAround(Math.exp(-delta * (event.ctrlKey ? 0.01 : 0.0022)), event.clientX - box.left, event.clientY - box.top);
    };
    element.addEventListener("wheel", wheel, { passive: false });
    return () => element.removeEventListener("wheel", wheel);
  }, [element, zoomAround]);

  const pointers = useRef(new Map<number, { x: number; y: number }>());
  /** True when the last press moved the camera, so the click that ends it picks nothing. */
  const dragged = useRef(false);
  const handlers = {
    onPointerDown(event: ReactPointerEvent<HTMLElement>) {
      if (event.button !== 0 && event.pointerType === "mouse") return;
      cancelAnimationFrame(animation.current);
      pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (pointers.current.size === 1) dragged.current = false;
    },
    onPointerMove(event: ReactPointerEvent<HTMLElement>) {
      const last = pointers.current.get(event.pointerId);
      if (!last) return;
      const box = event.currentTarget.getBoundingClientRect();
      if (pointers.current.size === 2) {
        const [a, b] = [...pointers.current.entries()];
        const other = a[0] === event.pointerId ? b[1] : a[1];
        const before = Math.hypot(last.x - other.x, last.y - other.y), after = Math.hypot(event.clientX - other.x, event.clientY - other.y);
        if (before > 0) zoomAround(after / before, (event.clientX + other.x) / 2 - box.left, (event.clientY + other.y) / 2 - box.top);
        dragged.current = true;
      } else {
        const dx = event.clientX - last.x, dy = event.clientY - last.y;
        if (!dragged.current && Math.hypot(dx, dy) < 4) return;
        if (!dragged.current) event.currentTarget.setPointerCapture?.(event.pointerId);
        dragged.current = true;
        setCamera((current) => ({ ...current, x: current.x + dx, y: current.y + dy }));
      }
      pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    },
    onPointerUp(event: ReactPointerEvent<HTMLElement>) { pointers.current.delete(event.pointerId); },
    onPointerCancel(event: ReactPointerEvent<HTMLElement>) { pointers.current.delete(event.pointerId); },
  };
  return { camera, fly, zoomAround, handlers, dragged };
}

/** The camera that shows a circle filling most of the view. */
export function fitCircle(circle: { x: number; y: number; r: number }, width: number, height: number, share = 0.44) {
  const k = (Math.min(width, height) * share) / circle.r;
  return { x: width / 2 - circle.x * k, y: height / 2 - circle.y * k, k };
}
