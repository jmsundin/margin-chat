import { useEffect, type RefObject } from "react";
import { SIDEBAR_EDGE_PX } from "./edgeSwipe";
import { htmlEdgeZones, readHtmlFrameMessage, type HtmlEdgeTouchPhase } from "./htmlDocuments";

/**
 * Touches inside an HTML page's frame never reach the app, so the phone's edge swipes would stop at the page.
 * The frame's bridge takes swipes that start in the screen's edge strips and passes them up; the page's
 * viewer puts them on the window as this event, in screen coordinates, for MobileEdgeSwipe to follow.
 */
export const FRAME_EDGE_TOUCH_EVENT = "margin-chat:frame-edge-touch";
export type FrameEdgeTouch = { phase: HtmlEdgeTouchPhase; x: number; y: number; t: number; frame: HTMLIFrameElement };

/** MobileEdgeSwipe marks the root while phone edge swipes are on, and says so with this event when that changes. */
export const EDGE_SWIPES_ATTRIBUTE = "data-edge-swipes";
export const EDGE_SWIPES_CHANGE_EVENT = "margin-chat:edge-swipes-change";
export function setEdgeSwipesOn(on: boolean) {
  document.documentElement.toggleAttribute(EDGE_SWIPES_ATTRIBUTE, on);
  window.dispatchEvent(new Event(EDGE_SWIPES_CHANGE_EVENT));
}
const edgeSwipesOn = () => document.documentElement.hasAttribute(EDGE_SWIPES_ATTRIBUTE);

/** Sent to what a right-edge swipe opens (an HTML page's body), which shows its notes. */
export const OPEN_RIGHT_EVENT = "margin-chat:edge-swipe-open-right";

/** What sits to the right of the touched element: an HTML page showing the page, whose notes come in from the right. */
export function rightPanelFor(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof Element)) return null;
  return target.closest<HTMLElement>(".document-body.is-html-page[data-html-view='page']:not(.is-html-full-screen)");
}

/**
 * Keeps the page's frame told which of its edges are the screen's swipe strips (none unless the phone's
 * edge swipes are on, and none in full screen, where the app's panels are put away), as it moves and resizes.
 * `frameKey` changes whenever a new frame element is put in.
 */
export function useFrameEdgeSwipes(frameRef: RefObject<HTMLIFrameElement | null>, frameKey: unknown) {
  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    const send = () => {
      const box = frame.getBoundingClientRect();
      const off = !edgeSwipesOn() || Boolean(frame.closest(".is-html-full-screen")) || !box.width;
      const zones = off ? { marginHtml: 1 as const, type: "edges" as const, left: 0, right: 0 } : htmlEdgeZones(box, window.innerWidth, SIDEBAR_EDGE_PX);
      frame.contentWindow?.postMessage(zones, "*");
    };
    send();
    frame.addEventListener("load", send);
    window.addEventListener("resize", send);
    window.addEventListener(EDGE_SWIPES_CHANGE_EVENT, send);
    const resized = typeof ResizeObserver === "function" ? new ResizeObserver(send) : null;
    resized?.observe(frame);
    const receive = (event: MessageEvent) => {
      if (!edgeSwipesOn() || event.source !== frame.contentWindow) return;
      const message = readHtmlFrameMessage(event.data);
      if (message?.type !== "edge-touch") return;
      const box = frame.getBoundingClientRect();
      const detail: FrameEdgeTouch = { phase: message.phase, x: box.left + message.x, y: box.top + message.y, t: message.t, frame };
      window.dispatchEvent(new CustomEvent(FRAME_EDGE_TOUCH_EVENT, { detail }));
    };
    window.addEventListener("message", receive);
    return () => {
      frame.removeEventListener("load", send);
      window.removeEventListener("resize", send);
      window.removeEventListener(EDGE_SWIPES_CHANGE_EVENT, send);
      resized?.disconnect();
      window.removeEventListener("message", receive);
    };
  }, [frameRef, frameKey]);
}
