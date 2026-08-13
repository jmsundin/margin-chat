import { describe, expect, test } from "bun:test";
import {
  getHorizontalWheelDelta,
  getWheelGestureAxis,
} from "../client/src/lib/wheelGestures";

describe("wheel gesture routing", () => {
  test("keeps primarily vertical gestures inside the chat panel", () => {
    expect(getWheelGestureAxis(0, 40)).toBe("vertical");
    expect(getWheelGestureAxis(18, 40)).toBe("vertical");
    expect(
      getHorizontalWheelDelta({ deltaX: 18, deltaY: 40, shiftKey: false }),
    ).toBe(0);
  });

  test("routes a diagonal trackpad swipe horizontally instead of letting the panel consume it", () => {
    expect(getWheelGestureAxis(32, 40)).toBe("horizontal");
    expect(
      getHorizontalWheelDelta({ deltaX: 32, deltaY: 40, shiftKey: false }),
    ).toBe(32);
  });

  test("routes a dominant horizontal gesture to the conversation strip at any viewport size", () => {
    expect(getWheelGestureAxis(-42, 18)).toBe("horizontal");
    expect(
      getHorizontalWheelDelta({ deltaX: -42, deltaY: 18, shiftKey: false }),
    ).toBe(-42);
  });

  test("supports Shift+wheel as an explicit horizontal gesture", () => {
    expect(
      getHorizontalWheelDelta({ deltaX: 0, deltaY: 36, shiftKey: true }),
    ).toBe(36);
  });

  test("ignores sub-pixel wheel noise", () => {
    expect(getWheelGestureAxis(0.2, -0.3)).toBe("none");
    expect(
      getHorizontalWheelDelta({ deltaX: 0.2, deltaY: -0.3, shiftKey: true }),
    ).toBe(0);
  });
});
