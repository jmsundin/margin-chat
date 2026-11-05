import { describe, expect, test } from "bun:test";
import { highestDesktopVersion, nextDesktopVersion } from "../scripts/desktop-next-version.mjs";

describe("desktop release version", () => {
  test("the first release uses desktop/package.json's version", () => {
    expect(nextDesktopVersion({ tags: [], bump: "minor", firstVersion: "0.1.0" })).toEqual({ version: "0.1.0", previous: null });
  });

  test("bumps the highest desktop tag, ignoring other tags and order", () => {
    const tags = ["desktop-v0.1.0", "desktop-v0.10.2", "desktop-v0.9.9", "v3.0.0", "desktop-vbeta"];
    expect(highestDesktopVersion(tags)).toBe("0.10.2");
    expect(nextDesktopVersion({ tags, bump: "patch" }).version).toBe("0.10.3");
    expect(nextDesktopVersion({ tags, bump: "minor" }).version).toBe("0.11.0");
    expect(nextDesktopVersion({ tags, bump: "major" }).version).toBe("1.0.0");
  });

  test("an override must be a higher plain version", () => {
    const tags = ["desktop-v0.2.0"];
    expect(nextDesktopVersion({ tags, override: "0.3.0" }).version).toBe("0.3.0");
    expect(() => nextDesktopVersion({ tags, override: "0.2.0" })).toThrow("must be higher");
    expect(() => nextDesktopVersion({ tags, override: "0.1.9" })).toThrow("must be higher");
    expect(() => nextDesktopVersion({ tags, override: "v0.3" })).toThrow("Use a version like");
  });

  test("rejects an unknown bump", () => {
    expect(() => nextDesktopVersion({ tags: ["desktop-v0.1.0"], bump: "huge" })).toThrow("patch, minor or major");
  });
});
