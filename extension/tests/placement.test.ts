import { describe, expect, test } from "bun:test";
import { placeCard, type Box } from "../src/placement";

const viewport = { width: 1100, height: 760 };
const passage = (top: number, left = 500, width = 170, height = 28): Box => ({ top, left, right: left + width, bottom: top + height });
const overlaps = (card: { top: number; left: number; width: number; height: number }, box: Box) =>
  card.left < box.right && card.left + card.width > box.left && card.top < box.bottom && card.top + card.height > box.top;

describe("answer card placement", () => {
  test("goes below a passage that has room, and above one near the bottom", () => {
    const high = passage(100); const below = placeCard(high, viewport);
    expect(below).toMatchObject({ top: 138, height: 460, width: 400 });
    const low = passage(650); const above = placeCard(low, viewport);
    expect(above.top + above.height).toBe(650 - 10);
    expect(above.height).toBe(460);
  });
  test("shrinks to the roomier side instead of covering a passage in the middle of a short window", () => {
    const middle = passage(284); // the case that used to overlap the quote
    const card = placeCard(middle, viewport);
    expect(overlaps(card, middle)).toBe(false);
    expect(card.height).toBeGreaterThanOrEqual(240);
    expect(card.height).toBeLessThan(460);
    expect(card.top + card.height).toBeLessThanOrEqual(viewport.height - 8);
    expect(card.top).toBeGreaterThanOrEqual(8);
  });
  test("never covers the passage across a range of positions and window sizes", () => {
    for (const height of [420, 520, 640, 760, 1000]) for (let top = 0; top < height - 30; top += 37) {
      const box = passage(top); const card = placeCard(box, { width: 1100, height });
      const usable = Math.max(height - 8 - (box.bottom + 10), box.top - 10 - 8);
      if (usable >= 240 || card.left >= box.right || card.left + card.width <= box.left) expect(overlaps(card, box)).toBe(false);
      expect(card.top).toBeGreaterThanOrEqual(8);
      expect(card.top + card.height).toBeLessThanOrEqual(height - 8 + 0.5);
      expect(card.left).toBeGreaterThanOrEqual(8);
      expect(card.left + card.width).toBeLessThanOrEqual(1100 - 8);
    }
  });
  test("moves beside the passage when a tiny window leaves no room above or below", () => {
    const box = passage(100, 100, 170, 28);
    const card = placeCard(box, { width: 1100, height: 330 });
    expect(overlaps(card, box)).toBe(false);
    expect(card.left).toBe(box.right + 10);
  });
  test("keeps the card inside narrow windows and falls back to the corner without a passage", () => {
    const narrow = placeCard(passage(100, 300, 40), { width: 320, height: 700 });
    expect(narrow.width).toBe(304);
    expect(narrow.left).toBe(8);
    expect(placeCard(null, viewport)).toEqual({ width: 400, height: 460, top: 292, left: 692 });
  });
  test("clamps horizontally for passages at the edges", () => {
    expect(placeCard(passage(100, 1000, 80), viewport).left).toBe(1100 - 400 - 8);
    expect(placeCard(passage(100, -30, 80), viewport).left).toBe(8);
  });
});
