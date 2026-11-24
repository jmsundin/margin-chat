/**
 * A press and hold with one finger, for the app's own menu at that spot (on phones: Paste and
 * the other actions at the cursor). It fires once the finger lifts, after the phone has
 * finished whatever it does on a hold itself, such as selecting the word under the finger.
 */

export const LONG_PRESS_MS = 500;
/** A finger that moves farther than this is scrolling or dragging handles, not holding. */
export const LONG_PRESS_SLOP = 10;
/** Time after lifting for the phone's own selection to settle before the menu decides what to show. */
export const LONG_PRESS_SETTLE_MS = 80;
/** Long presses here keep the phone's own menu: links, media and form fields have their own. */
const NATIVE_TARGETS = "a[href], img, video, audio, input, textarea, select, button, [data-long-press-native]";

export type LongPressPoint = { x: number; y: number; target: Element | null };

type Options = {
  onLongPress: (point: LongPressPoint) => void;
  /** Checked when the press starts; false leaves the press to the phone. */
  enabled?: () => boolean;
  delay?: number;
  settle?: number;
};

export function watchLongPress(element: HTMLElement, { onLongPress, enabled = () => true, delay = LONG_PRESS_MS, settle = LONG_PRESS_SETTLE_MS }: Options): () => void {
  let press: { x: number; y: number; target: Element | null; held: boolean } | null = null;
  let holdTimer = 0;
  let settleTimer = 0;

  const cancel = () => { window.clearTimeout(holdTimer); holdTimer = 0; press = null; };
  const onTouchStart = (event: TouchEvent) => {
    cancel();
    if (event.touches.length !== 1 || !enabled()) return;
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest(NATIVE_TARGETS)) return;
    const touch = event.touches[0];
    press = { x: touch.clientX, y: touch.clientY, target, held: false };
    holdTimer = window.setTimeout(() => { if (press) press.held = true; }, delay);
  };
  const onTouchMove = (event: TouchEvent) => {
    if (!press) return;
    const touch = event.touches[0];
    if (event.touches.length !== 1 || !touch || Math.hypot(touch.clientX - press.x, touch.clientY - press.y) > LONG_PRESS_SLOP) cancel();
  };
  // iOS can cancel the touch once its own hold gesture (the magnifier, a word selection) takes
  // over, so a cancel after the hold counts as the lift.
  const onTouchEnd = (event: TouchEvent) => {
    const done = press;
    cancel();
    if (!done?.held || event.touches.length) return;
    window.clearTimeout(settleTimer);
    settleTimer = window.setTimeout(() => onLongPress({ x: done.x, y: done.y, target: done.target }), settle);
  };

  element.addEventListener("touchstart", onTouchStart, { passive: true });
  element.addEventListener("touchmove", onTouchMove, { passive: true });
  element.addEventListener("touchend", onTouchEnd, { passive: true });
  element.addEventListener("touchcancel", onTouchEnd, { passive: true });
  return () => {
    cancel();
    window.clearTimeout(settleTimer);
    element.removeEventListener("touchstart", onTouchStart);
    element.removeEventListener("touchmove", onTouchMove);
    element.removeEventListener("touchend", onTouchEnd);
    element.removeEventListener("touchcancel", onTouchEnd);
  };
}
