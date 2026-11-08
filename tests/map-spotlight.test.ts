import { describe, expect, test } from "bun:test";
import { describeSpotlight, spotlightFromAnswer, spotlightFromSearch, spotlightHeat, spotlightNeighbours } from "../client/src/lib/mapSpotlight";
import type { VaultSearchResults } from "../client/src/lib/vaultSearch";

describe("Show on Map", () => {
  test("Found it documents light as likely, best matches as maybe, and cloud-only hits are left out", () => {
    const results = {
      query: "sync", scope: "all", documents: [], passages: [], complete: true,
      found: { verdict: "several", question: false, hits: [
        { kind: "document", hit: { key: "a", title: "A", kindLabel: "Document", target: { kind: "loaded", conversationId: "a" } } },
        { kind: "document", hit: { key: "b", title: "B", kindLabel: "Document", target: { kind: "cloud", path: "b.md" } } },
        { kind: "passage", hit: { key: "c", conversationId: "c", title: "C" } },
      ] },
      related: [{ conversationId: "a" }, { conversationId: "d" }, { conversationId: "e", cloudPath: "e.md" }],
    } as unknown as VaultSearchResults;
    const scores = spotlightFromSearch(results);
    expect(Object.keys(scores).sort()).toEqual(["a", "c", "d"]);
    expect(spotlightHeat(scores.a)).toBe(3);
    expect(spotlightHeat(scores.c)).toBe(3);
    expect(spotlightHeat(scores.d)).toBe(2);
    expect(spotlightFromSearch(null)).toEqual({});
  });

  test("an answer lights what it cites, and faintly what it read without citing", () => {
    const scores = spotlightFromAnswer({ status: "used", meaning: true, passages: [
      { label: "Vault 1", id: "rapa", kind: "document", title: "Rapamycin", cited: true },
      { label: "Vault 2", id: "file-1", openId: "trial", kind: "file", title: "ITP.pdf" },
      { label: "Vault 3", id: "rapa", kind: "document", title: "Rapamycin" },
    ] } as never);
    expect(scores).toEqual({ rapa: 1, trial: 0.4 });
    expect(describeSpotlight(Object.values(scores))).toBe("1 likely · 1 faint");
  });

  test("documents linked to a lit one stay faintly in view, if they are on the map", () => {
    const edges = [{ sourceId: "a", targetId: "b" }, { sourceId: "c", targetId: "a" }, { sourceId: "a", targetId: "x" }, { sourceId: "b", targetId: "z" }];
    expect([...spotlightNeighbours(new Set(["a"]), edges, new Set(["a", "b", "c", "z"]))].sort()).toEqual(["b", "c"]);
  });
});
