import { describe, expect, test } from "bun:test";
import {
  clampChatScrollPosition,
  getJumpToTopVisibility,
} from "../client/src/lib/chatScroll";

describe("chat scroll state", () => {
  test("restores a saved position within the current scroll bounds", () => {
    expect(clampChatScrollPosition(420, 1_000)).toBe(420);
    expect(clampChatScrollPosition(1_200, 1_000)).toBe(1_000);
    expect(clampChatScrollPosition(-20, 1_000)).toBe(0);
  });

  test("reveals the jump control after the user scrolls upward", () => {
    expect(
      getJumpToTopVisibility({
        currentScrollTop: 600,
        previousScrollTop: 680,
        wasVisible: false,
      }),
    ).toBe(true);
  });

  test("hides the jump control near the top or while scrolling down", () => {
    expect(
      getJumpToTopVisibility({
        currentScrollTop: 40,
        previousScrollTop: 100,
        wasVisible: true,
      }),
    ).toBe(false);
    expect(
      getJumpToTopVisibility({
        currentScrollTop: 700,
        previousScrollTop: 620,
        wasVisible: true,
      }),
    ).toBe(false);
  });
});
