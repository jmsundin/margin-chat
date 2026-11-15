import { describe, expect, test } from "bun:test";
import { decodeHtmlPageData, encodeHtmlPageData, htmlPageDataPath, newerHtmlPageData, sameHtmlPageData } from "../client/src/lib/htmlPageData";
import { validVaultPath } from "../client/src/lib/vaultTypes";

describe("what an HTML page saves follows the vault", () => {
  test("a page's data file sits with the vault's housekeeping, at a path every device derives the same way", () => {
    const path = htmlPageDataPath("Games/Glider Gauntlet.html");
    expect(path).toBe(".margin-chat/page-data/Games/Glider Gauntlet.html.json");
    expect(validVaultPath(path)).toBe(true);
    expect(htmlPageDataPath("Café.html")).toBe(htmlPageDataPath("Café.html"));
  });

  test("a saved copy round-trips with the time it was saved", () => {
    const value = { savedAt: 1_700_000_000_000, data: { "game:state": "{\"xp\":40}" } };
    expect(decodeHtmlPageData(encodeHtmlPageData(value))).toEqual(value);
  });

  test("the copy this device kept before pages synced still opens, as the oldest", () => {
    expect(decodeHtmlPageData("{\"game:state\":\"1\"}")).toEqual({ savedAt: 0, data: { "game:state": "1" } });
  });

  test("anything malformed counts as no copy, never as an empty one that could overwrite progress", () => {
    for (const text of [null, "", "not json", "[]", "3", "{\"a\":1}", "{\"version\":1,\"savedAt\":5,\"data\":{\"a\":2}}"]) expect(decodeHtmlPageData(text)).toBeNull();
    expect(decodeHtmlPageData(JSON.stringify({ a: "x".repeat(1_000_001) }))).toBeNull();
  });

  test("the copy saved last opens; this device's wins a tie", () => {
    const older = { savedAt: 10, data: { a: "old" } };
    const newer = { savedAt: 20, data: { a: "new" } };
    expect(newerHtmlPageData(older, newer)).toBe(newer);
    expect(newerHtmlPageData(newer, older)).toBe(newer);
    expect(newerHtmlPageData(older, { ...older, data: { a: "other" } })).toBe(older);
    expect(newerHtmlPageData(null, newer)).toBe(newer);
    expect(newerHtmlPageData(older, null)).toBe(older);
    expect(newerHtmlPageData(null, null)).toBeNull();
    // A reset here after the vault's copy was saved stays a reset.
    expect(newerHtmlPageData({ savedAt: 30, data: {} }, newer)).toEqual({ savedAt: 30, data: {} });
  });

  test("two copies with the same entries are the same, whatever their order", () => {
    expect(sameHtmlPageData({ a: "1", b: "2" }, { b: "2", a: "1" })).toBe(true);
    expect(sameHtmlPageData({ a: "1" }, { a: "1", b: "2" })).toBe(false);
    expect(sameHtmlPageData({ a: "1" }, { a: "2" })).toBe(false);
  });
});
