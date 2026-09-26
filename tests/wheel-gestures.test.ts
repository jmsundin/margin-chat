import { describe, expect, test } from "bun:test";
import {
  getHorizontalWheelDelta,
  getWheelGestureAxis,
  isProfileDialogWheelTarget,
} from "../client/src/lib/wheelGestures";

describe("wheel gesture routing", () => {
  test("keeps primarily vertical gestures inside the chat panel", () => {
    expect(getWheelGestureAxis(0, 40)).toBe("vertical");
    expect(getWheelGestureAxis(18, 40)).toBe("vertical");
    expect(
      getHorizontalWheelDelta({ deltaX: 18, deltaY: 40, shiftKey: false }),
    ).toBe(0);
  });

  test("keeps upward and downward diagonals vertical despite drift in either horizontal direction", () => {
    for (const deltaY of [-40, 40]) {
      for (const deltaX of [-40, -32, 32, 40]) {
        expect(getWheelGestureAxis(deltaX, deltaY)).toBe("vertical");
        expect(getHorizontalWheelDelta({ deltaX, deltaY, shiftKey: false })).toBe(0);
      }
    }
  });

  test("favors vertical scrolling when horizontal movement is stronger but still ambiguous", () => {
    for (const deltaY of [-40, 40]) {
      for (const deltaX of [-79.9, -60, 60, 79.9]) {
        expect(getWheelGestureAxis(deltaX, deltaY)).toBe("vertical");
        expect(getHorizontalWheelDelta({ deltaX, deltaY, shiftKey: false })).toBe(0);
      }
    }
  });

  test("routes a dominant horizontal gesture to the conversation strip at any viewport size", () => {
    expect(getWheelGestureAxis(-42, 18)).toBe("horizontal");
    expect(
      getHorizontalWheelDelta({ deltaX: -42, deltaY: 18, shiftKey: false }),
    ).toBe(-42);
    for (const deltaY of [-40, 0, 40]) {
      for (const deltaX of [-80, 80]) {
        expect(getWheelGestureAxis(deltaX, deltaY)).toBe("horizontal");
        expect(getHorizontalWheelDelta({ deltaX, deltaY, shiftKey: false })).toBe(deltaX);
      }
    }
  });

  test("supports Shift+wheel as an explicit horizontal gesture", () => {
    expect(
      getHorizontalWheelDelta({ deltaX: 0, deltaY: 36, shiftKey: true }),
    ).toBe(36);
    for (const deltaY of [-40, 40]) {
      for (const deltaX of [-60, -32, 32, 60]) {
        expect(getHorizontalWheelDelta({ deltaX, deltaY, shiftKey: true })).toBe(deltaY);
      }
    }
    expect(getHorizontalWheelDelta({ deltaX: -100, deltaY: 40, shiftKey: true })).toBe(-100);
    expect(getHorizontalWheelDelta({ deltaX: 100, deltaY: -40, shiftKey: true })).toBe(100);
  });

  test("ignores sub-pixel wheel noise", () => {
    expect(getWheelGestureAxis(0.2, -0.3)).toBe("none");
    expect(
      getHorizontalWheelDelta({ deltaX: 0.2, deltaY: -0.3, shiftKey: true }),
    ).toBe(0);
    expect(getWheelGestureAxis(0.5, 0)).toBe("horizontal");
    expect(getWheelGestureAxis(0, -0.5)).toBe("vertical");
  });

  test("leaves wheel gestures inside the Profile dialog untouched", () => {
    const profileTarget = {
      closest: (selector: string) =>
        selector === ".profile-dialog" ? { role: "dialog" } : null,
    } as unknown as EventTarget;
    const workspaceTarget = {
      closest: () => null,
    } as unknown as EventTarget;

    expect(isProfileDialogWheelTarget(profileTarget)).toBe(true);
    expect(isProfileDialogWheelTarget(workspaceTarget)).toBe(false);
    expect(isProfileDialogWheelTarget(null)).toBe(false);
  });
});
