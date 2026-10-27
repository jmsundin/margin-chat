import { useEffect, useState } from "react";

/**
 * On a phone the Map's document panel takes half the screen: the bottom half
 * held upright, the right half turned sideways. Larger screens keep the panel
 * wherever the person put it.
 */
export type PhoneDockLayout = "portrait" | "landscape" | null;

/** A touch screen that is short when turned sideways, or any narrow screen. */
export function phoneDockLayout(width: number, height: number, coarsePointer: boolean): PhoneDockLayout {
  if (coarsePointer && height <= 500 && width > height) return "landscape";
  if (width <= 760) return "portrait";
  return null;
}

/** The panel's starting share of the screen. */
export const PHONE_DOCK_SHARE = 0.5;
/** The smallest panel still shows a title and a few lines. */
export const PHONE_DOCK_MIN = 140;
/** Map left showing beside the panel at its largest. */
export const PHONE_MAP_MIN = 96;

/** Panel size after dragging its edge, kept between the smallest panel and the smallest map. */
export function clampPhoneDockSize(size: number, available: number) {
  return Math.round(Math.min(Math.max(size, PHONE_DOCK_MIN), Math.max(PHONE_DOCK_MIN, available - PHONE_MAP_MIN)));
}

function currentLayout(): PhoneDockLayout {
  if (typeof window === "undefined") return null;
  const coarse = typeof window.matchMedia === "function" && window.matchMedia("(pointer: coarse)").matches;
  return phoneDockLayout(window.innerWidth, window.innerHeight, coarse);
}

export function usePhoneDockLayout() {
  const [layout, setLayout] = useState<PhoneDockLayout>(currentLayout);
  useEffect(() => {
    const update = () => setLayout(currentLayout());
    window.addEventListener("resize", update);
    window.addEventListener("orientationchange", update);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("orientationchange", update);
    };
  }, []);
  return layout;
}
