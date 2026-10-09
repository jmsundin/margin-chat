import { describe, expect, test } from "bun:test";
import {
  getFullScreenScale,
  getZoomThroughProgress,
  pinchOutStep,
  zoomThroughStep,
  ZOOM_THROUGH_FILL,
  ZOOM_THROUGH_IDLE_MS,
  ZOOM_THROUGH_TRAVEL,
} from "../client/src/lib/zoomThrough";

const size = { width: 1000, height: 800 };
const card = { id: "doc", x: 100, y: 50, width: 200, height: 100 };
const step = 1.14;

function zoomIn(times: number, start = { scale: 2, x: 0, y: 0 }, gap = 16) {
  let viewport = start;
  let state = null as Parameters<typeof zoomThroughStep>[0]["state"];
  let now = 0;
  for (let index = 0; index < times; index++) {
    now += gap;
    const result = zoomThroughStep({ current: viewport, requestedScale: viewport.scale * step, point: { x: 400, y: 300 },
      card, size, maxScale: 6, state, now });
    viewport = result.viewport;
    state = result.state;
    if (result.open) return { viewport, state, opened: index + 1 };
  }
  return { viewport, state, opened: 0 };
}

describe("zoom through", () => {
  test("a card fills the screen at its wider share", () => {
    // Width decides: 200 of 1000 px is a larger share than 100 of 800.
    expect(getFullScreenScale(card, size, 10)).toBeCloseTo(ZOOM_THROUGH_FILL * 1000 / 200);
    expect(getFullScreenScale(card, size, 3)).toBe(3);
  });

  test("zooms normally until the card fills the screen", () => {
    const result = zoomThroughStep({ current: { scale: 2, x: 0, y: 0 }, requestedScale: 2.2, point: { x: 400, y: 300 },
      card, size, maxScale: 6, state: null, now: 0 });
    expect(result.viewport.scale).toBeCloseTo(2.2);
    // The point under the pointer stays put.
    expect((400 - result.viewport.x) / result.viewport.scale).toBeCloseTo(200);
    expect(result.state).toBeNull();
    expect(result.open).toBe(false);
  });

  test("holds the card at full screen, centers it, then opens after more zooming", () => {
    const fullScreen = getFullScreenScale(card, size, 6);
    const { viewport, opened } = zoomIn(40);
    expect(viewport.scale).toBeCloseTo(fullScreen);
    // Opens within a few steps past full screen, not on the first one.
    const stepsToFill = Math.ceil(Math.log(fullScreen / 2) / Math.log(step));
    expect(opened).toBeGreaterThan(stepsToFill);
    expect(opened).toBeLessThanOrEqual(stepsToFill + Math.ceil(Math.log(ZOOM_THROUGH_TRAVEL) / Math.log(step)));
    // Held steps glide the card toward the middle of the screen.
    const centerX = (card.x + card.width / 2) * viewport.scale + viewport.x;
    expect(Math.abs(centerX - size.width / 2)).toBeLessThan(Math.abs((card.x + card.width / 2) * fullScreen + (400 - 200 * fullScreen) - size.width / 2));
  });

  test("a pause starts the travel over", () => {
    const fullScreen = getFullScreenScale(card, size, 6);
    const held = { scale: fullScreen, x: 0, y: 0 };
    const first = zoomThroughStep({ current: held, requestedScale: fullScreen * step, point: { x: 500, y: 400 }, card, size, maxScale: 6, state: null, now: 0 });
    expect(first.state?.travel).toBeCloseTo(step);
    const late = zoomThroughStep({ current: first.viewport, requestedScale: fullScreen * step, point: { x: 500, y: 400 }, card, size, maxScale: 6,
      state: first.state, now: ZOOM_THROUGH_IDLE_MS + 1 });
    expect(late.state?.travel).toBeCloseTo(step);
    expect(late.open).toBe(false);
  });

  test("progress runs from 0 at full screen to 1 when the document opens", () => {
    expect(getZoomThroughProgress(1)).toBe(0);
    expect(getZoomThroughProgress(ZOOM_THROUGH_TRAVEL)).toBe(1);
    expect(getZoomThroughProgress(Math.sqrt(ZOOM_THROUGH_TRAVEL))).toBeCloseTo(0.5);
  });

  test("pinching out of the document returns after the same travel", () => {
    let state: { travel: number; at: number } | null = null;
    let steps = 0;
    do { state = pinchOutStep(state, 1 / step, steps * 16); steps++; } while (state && steps < 20);
    expect(state).toBeNull();
    expect(steps).toBe(Math.ceil(Math.log(ZOOM_THROUGH_TRAVEL) / Math.log(step)));
    // A single small pinch does nothing.
    expect(pinchOutStep(null, 1 / step, 0)).not.toBeNull();
  });
});
