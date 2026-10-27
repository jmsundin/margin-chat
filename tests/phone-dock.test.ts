import { describe, expect, test } from "bun:test";
import { clampPhoneDockSize, PHONE_DOCK_MIN, PHONE_MAP_MIN, phoneDockLayout } from "../client/src/lib/phoneDock";

describe("phone document panel", () => {
  test("an upright phone puts the panel on the bottom half", () => {
    expect(phoneDockLayout(390, 844, true)).toBe("portrait");
    expect(phoneDockLayout(700, 900, false)).toBe("portrait");
  });

  test("a phone turned sideways puts it on the right half, though it is under 760px wide", () => {
    expect(phoneDockLayout(750, 342, true)).toBe("landscape");
    expect(phoneDockLayout(932, 430, true)).toBe("landscape");
  });

  test("tablets and computers keep the panel where it was put", () => {
    expect(phoneDockLayout(1180, 820, true)).toBeNull();
    expect(phoneDockLayout(1440, 400, false)).toBeNull();
  });

  test("dragging the edge keeps both the panel and some map in view", () => {
    expect(clampPhoneDockSize(20, 600)).toBe(PHONE_DOCK_MIN);
    expect(clampPhoneDockSize(590, 600)).toBe(600 - PHONE_MAP_MIN);
    expect(clampPhoneDockSize(300.4, 600)).toBe(300);
  });
});
