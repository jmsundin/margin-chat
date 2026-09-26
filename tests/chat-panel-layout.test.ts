import { expect, test } from "bun:test";
import { getChatPanelLayout, resizeChatPanel } from "../client/src/lib/chatPanelLayout";

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

test("resizing changes only the selected document width", () => {
  expect(resizeChatPanel({ width: 544, delta: 80 })).toEqual({ width: 624 });
  expect(resizeChatPanel({ width: 544, delta: -80 })).toEqual({ width: 464 });
});

test("a document can grow beyond its initial pair layout without a combined-width cap", () => {
  const initialWidth = layout(1168).width;
  expect(resizeChatPanel({ width: initialWidth, delta: 400 })).toEqual({ width: 944 });
  expect(resizeChatPanel({ width: initialWidth, delta: 1000 })).toEqual({ width: 980 });
});

test("document resizing clamps to its own minimum and maximum", () => {
  expect(resizeChatPanel({ width: 800, delta: -1000 })).toEqual({ width: 320 });
  expect(resizeChatPanel({ width: 800, delta: 1000 })).toEqual({ width: 980 });
  expect(resizeChatPanel({ width: 320, delta: -24 })).toEqual({ width: 320 });
  expect(resizeChatPanel({ width: 980, delta: 24 })).toEqual({ width: 980 });
});

test("a document honors its available maximum without needing a neighboring width", () => {
  expect(resizeChatPanel({ width: 600, delta: 1000, maxWidth: 850 })).toEqual({ width: 850 });
  expect(resizeChatPanel({ width: 600, delta: -1000, maxWidth: 850 })).toEqual({ width: 320 });
});
