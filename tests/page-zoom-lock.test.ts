import { describe, expect, test } from "bun:test";
import { withPageZoomLocked } from "../client/src/lib/pageZoomLock";

describe("withPageZoomLocked", () => {
  test("adds the zoom limits to the default viewport", () => {
    expect(withPageZoomLocked("width=device-width, initial-scale=1.0"))
      .toBe("width=device-width, initial-scale=1.0, maximum-scale=1, user-scalable=no");
  });

  test("replaces existing zoom limits instead of repeating them", () => {
    expect(withPageZoomLocked("width=device-width,maximum-scale=5, user-scalable=yes"))
      .toBe("width=device-width, maximum-scale=1, user-scalable=no");
  });
});
