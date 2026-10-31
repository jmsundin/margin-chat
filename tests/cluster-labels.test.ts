import { describe, expect, test } from "bun:test";
import { carriedClusterLabel } from "../client/src/lib/useClusterLabels";

const labels = { "old-web": "Web development", "old-bread": "Baking" };
const members = { "old-web": ["angular", "react", "vue", "svelte", "css"], "old-bread": ["sourdough", "starter", "rye"] };

describe("cluster names that survive small changes", () => {
  test("a cluster with one note added keeps its name as the same cluster", () => {
    const found = carriedClusterLabel({ fingerprint: "new-web", memberIds: ["angular", "react", "vue", "svelte", "css", "htmx"] }, labels, members);
    expect(found).toEqual({ label: "Web development", same: true });
  });

  test("a cluster that lost a third of its notes keeps the name only until it is named afresh", () => {
    const found = carriedClusterLabel({ fingerprint: "smaller", memberIds: ["angular", "react", "vue"] }, labels, members);
    expect(found).toEqual({ label: "Web development", same: false });
  });

  test("a cluster sharing little with any named one gets nothing", () => {
    expect(carriedClusterLabel({ fingerprint: "other", memberIds: ["angular", "marathon", "budget", "trip"] }, labels, members)).toBeNull();
  });

  test("a named cluster whose members were never remembered cannot lend its name", () => {
    expect(carriedClusterLabel({ fingerprint: "x", memberIds: ["sourdough", "starter", "rye"] }, labels, {})).toBeNull();
  });
});
