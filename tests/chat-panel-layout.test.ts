import { expect, test } from "bun:test";
import { getChatPanelLayout, resizeChatPanels } from "../client/src/lib/chatPanelLayout";

const layout = (availableWidth: number, options = {}) => getChatPanelLayout({
  availableWidth, preferredWidth: 760, hasParent: true, hasSideItems: true, mobile: false, ...options,
});

test("a desktop branch and source fit together without exceeding the canvas", () => {
  const result = layout(1168);
  expect(result.fitsPair).toBe(true);
  expect(result.width * 2 + 80).toBeLessThanOrEqual(1168);
  expect(result.width).toBeGreaterThanOrEqual(360);
  expect(layout(800)).toEqual({ width: 360, maxWidth: 360, fitsPair: true });
  expect(layout(799).fitsPair).toBe(false);
});

test("phone panels fill the screen and a main chat leaves room for its margin", () => {
  expect(layout(390, { mobile: true })).toEqual({ width: 390, maxWidth: 390, fitsPair: false });
  expect(layout(1168, { hasParent: false }).width + 284 + 80).toBeLessThanOrEqual(1168);
  expect(layout(1500, { preferredWidth: 420 }).width).toBe(420);
});

test("resizing a side chat redistributes space without changing the combined width", () => {
  expect(resizeChatPanels({ width: 544, companionWidth: 544, delta: 80 })).toEqual({ width: 624, companionWidth: 464 });
  expect(resizeChatPanels({ width: 544, companionWidth: 544, delta: -80 })).toEqual({ width: 464, companionWidth: 624 });
});

test("neither panel can be dragged below its minimum or above its maximum", () => {
  expect(resizeChatPanels({ width: 544, companionWidth: 544, delta: 1000 })).toEqual({ width: 768, companionWidth: 320 });
  expect(resizeChatPanels({ width: 544, companionWidth: 544, delta: -1000 })).toEqual({ width: 320, companionWidth: 768 });
  expect(resizeChatPanels({ width: 800, companionWidth: 800, delta: 1000 })).toEqual({ width: 980, companionWidth: 620 });
  expect(resizeChatPanels({ width: 800, companionWidth: 800, delta: -1000 })).toEqual({ width: 620, companionWidth: 980 });
});

test("an unpaired panel resizes independently within its bounds", () => {
  expect(resizeChatPanels({ width: 600, delta: -1000 })).toEqual({ width: 320, companionWidth: undefined });
  expect(resizeChatPanels({ width: 600, delta: 1000, maxWidth: 850 })).toEqual({ width: 850, companionWidth: undefined });
});
