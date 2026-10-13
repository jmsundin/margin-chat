/**
 * Keeps phone browsers from zooming the whole app with a pinch. The Map View
 * canvas still zooms: it reads two-finger touches itself (graphInteractions)
 * and only moves its own camera, so it never needed the browser's page zoom.
 *
 * Android Chrome follows the viewport meta tag. iOS Safari ignores
 * user-scalable=no, so it also needs touch-action on the page and its
 * proprietary gesture events cancelled.
 */
const LOCKED_CLASS = "is-page-zoom-locked";
const LOCK_DIRECTIVES = ["maximum-scale=1", "user-scalable=no"];

export function withPageZoomLocked(content: string) {
  const kept = content.split(",").map((part) => part.trim())
    .filter((part) => part && !/^(maximum-scale|user-scalable)\s*=/i.test(part));
  return [...kept, ...LOCK_DIRECTIVES].join(", ");
}

export function lockPageZoom(doc: Document = document) {
  const meta = doc.querySelector<HTMLMetaElement>('meta[name="viewport"]');
  const previousContent = meta?.getAttribute("content") ?? null;
  if (meta) meta.setAttribute("content", withPageZoomLocked(previousContent ?? ""));
  doc.documentElement.classList.add(LOCKED_CLASS);

  const cancelGesture = (event: Event) => event.preventDefault();
  const gestureEvents = ["gesturestart", "gesturechange", "gestureend"];
  for (const type of gestureEvents) doc.addEventListener(type, cancelGesture, { passive: false });

  return () => {
    if (meta && previousContent !== null) meta.setAttribute("content", previousContent);
    doc.documentElement.classList.remove(LOCKED_CLASS);
    for (const type of gestureEvents) doc.removeEventListener(type, cancelGesture);
  };
}
