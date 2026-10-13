import { describe, expect, test } from "bun:test";
import { groupByDate, groupIntoCategories, sortAlphabetically, sortByRecentlyViewed, sortBySimilarity } from "../client/src/lib/sidebarDocumentOrder";
import type { ThreadSummary } from "../client/src/types";

function doc(id: string, title: string, createdAt: string): ThreadSummary {
  return { id, title, createdAt, updatedAt: createdAt, updatedLabel: "", categoryId: "general" as ThreadSummary["categoryId"],
    categoryLabel: "", conversationCount: 1, preview: "" };
}

const angular = doc("angular", "Angular", "2026-01-01T00:00:00Z");
const viewChild = doc("viewchild", "ViewChild", "2026-02-01T00:00:00Z");
const react = doc("react", "react hooks", "2026-03-01T00:00:00Z");
const added = doc("added", "Added in Finder", "2026-10-11T18:00:00Z");
const all = [angular, viewChild, react, added];

describe("sidebar document order", () => {
  test("date headings split a newest-first list by local calendar day", () => {
    const now = new Date(2026, 9, 13, 9, 0).getTime();
    const at = (day: number, hour = 12, month = 9) => new Date(2026, month, day, hour).getTime();
    const times: Record<string, number> = { today: at(13, 1), yesterday: at(12, 23), week: at(7), month: at(14, 12, 8), older: at(13, 12, 8) };
    const docs = Object.keys(times).map((id) => doc(id, id, "2026-01-01T00:00:00Z"));
    const sections = groupByDate(docs, (thread) => times[thread.id], now);
    expect(sections.map((section) => [section.label, section.threads.map((thread) => thread.id)])).toEqual([
      ["Today", ["today"]], ["Yesterday", ["yesterday"]], ["This week", ["week"]], ["This month", ["month"]], ["Older", ["older"]],
    ]);
    expect(groupByDate([docs[0], docs[4]], (thread) => times[thread.id], now).map((section) => section.id)).toEqual(["today", "older"]);
  });

  test("recently viewed puts the last opened first, and a newly added file above older views", () => {
    const opened = new Map([["angular", Date.parse("2026-10-11T12:00:00Z")], ["react", Date.parse("2026-10-10T12:00:00Z")]]);
    expect(sortByRecentlyViewed(all, opened).map((thread) => thread.id)).toEqual(["added", "angular", "react", "viewchild"]);
  });

  test("A to Z ignores case and orders numbers naturally", () => {
    const items = [doc("b", "note 10", "2026-01-01T00:00:00Z"), doc("a", "Note 9", "2026-01-01T00:00:00Z"), ...all];
    expect(sortAlphabetically(items).map((thread) => thread.title)).toEqual(["Added in Finder", "Angular", "Note 9", "note 10", "react hooks", "ViewChild"]);
  });

  test("similar puts the open document first, then the closest in meaning, then documents without meanings", () => {
    const vectors = new Map<string, Float32Array>([
      ["angular", Float32Array.from([1, 0])],
      ["viewchild", Float32Array.from([0.9, Math.sqrt(1 - 0.81)])],
      ["react", Float32Array.from([0, 1])],
    ]);
    const fallback = sortByRecentlyViewed(all, new Map());
    expect(sortBySimilarity(all, "angular", (id) => vectors.get(id), fallback).map((thread) => thread.id))
      .toEqual(["angular", "viewchild", "react", "added"]);
    // Without a meaning for the open document, the list keeps its fallback order.
    expect(sortBySimilarity(all, "added", (id) => vectors.get(id), fallback)).toBe(fallback);
  });

  test("categories keep list order inside each, largest first, unfiled last", () => {
    const clusters = [
      { id: "cluster:angular", hubId: "angular", memberIds: ["angular", "viewchild"] },
      { id: "cluster:react", hubId: "react", memberIds: ["react"] },
      { id: "unfiled", hubId: null, memberIds: ["added"] },
    ];
    const ordered = sortByRecentlyViewed(all, new Map());
    const categories = groupIntoCategories(ordered, clusters, (id) => id === "cluster:angular" ? "Angular" : "React");
    expect(categories.map((category) => [category.label, category.threads.map((thread) => thread.id)])).toEqual([
      ["Angular", ["viewchild", "angular"]],
      ["React", ["react"]],
      ["Unfiled", ["added"]],
    ]);
  });
});
