import { expect, test } from "bun:test";
import { findWikiLinkAround, findWikiLinkQuery, resolveWikiLinkDocument, wikiLinkSuggestions } from "../client/src/lib/wikiLinkSuggestions";
import { createDocumentLinkResolver } from "../client/src/lib/documentRelations";
import type { Conversation } from "../client/src/types";

const doc = (id: string, title: string, updatedAt: string, extra: Partial<Conversation> = {}) =>
  ({ id, title, parentId: null, updatedAt, createdAt: updatedAt, messages: [], ...extra }) as unknown as Conversation;

const conversations: Record<string, Conversation> = {
  current: doc("current", "Aging research", "2026-11-04T00:00:00Z"),
  senolytics: doc("senolytics", "Senolytics overview", "2026-11-01T00:00:00Z"),
  sleep: doc("sleep", "Sleep and longevity", "2026-11-03T00:00:00Z"),
  plan: doc("plan", "Plan", "2026-10-01T00:00:00Z", { parentId: "sleep" }),
  plan2: doc("plan2", "Plan", "2026-10-02T00:00:00Z", { parentId: "senolytics" }),
  brackets: doc("brackets", "Draft [v2] | notes", "2026-09-01T00:00:00Z"),
};

test("finds the [[ being typed before the caret", () => {
  expect(findWikiLinkQuery("See [[sen")).toEqual({ start: 4, query: "sen" });
  expect(findWikiLinkQuery("See [[")).toEqual({ start: 4, query: "" });
  expect(findWikiLinkQuery("![[pic")).toEqual({ start: 1, query: "pic" });
  expect(findWikiLinkQuery("See [[Done]] and")).toBeNull();
  expect(findWikiLinkQuery("See [[Doc#Head")).toBeNull();
  expect(findWikiLinkQuery("See [[Doc|label")).toBeNull();
  expect(findWikiLinkQuery("No link here")).toBeNull();
});

test("ranks title matches and leaves out the open document", () => {
  const titles = (query: string) => wikiLinkSuggestions({ conversations, currentId: "current" }, query).map((item) => item.title);
  expect(titles("sen")).toEqual(["Senolytics overview"]);
  expect(titles("long")).toEqual(["Sleep and longevity"]);
  expect(titles("aging")).toEqual([]);
  // With nothing typed yet, the most recently changed documents come first.
  expect(titles("").slice(0, 2)).toEqual(["Sleep and longevity", "Senolytics overview"]);
  // A prefix match beats a match inside the title.
  const ranked = wikiLinkSuggestions({ conversations: { a: doc("a", "My plan", "2026-11-05T00:00:00Z"), b: doc("b", "Planning", "2026-01-01T00:00:00Z") } }, "plan");
  expect(ranked.map((item) => item.title)).toEqual(["Planning", "My plan"]);
});

test("includes documents still in the cloud", () => {
  const items = wikiLinkSuggestions({
    conversations, currentId: "current",
    cloudDocuments: [{ id: "cloud-1", path: "Notes/Rapamycin dosing — abc-def.md", title: "Rapamycin dosing", type: "note", kind: "note", revision: "1", updated: "2026-11-02T00:00:00Z" }],
  }, "rapa");
  expect(items).toEqual([{ id: "cloud-1", title: "Rapamycin dosing", link: "Rapamycin dosing", cloud: true }]);
});

test("links that would be ambiguous or broken use the file name, which resolves to the right document", () => {
  const items = wikiLinkSuggestions({ conversations }, "plan");
  expect(items.map((item) => item.detail)).toEqual(["in senolytics", "in sleep"].map((value) => conversations[value.slice(3)].title));
  const resolve = createDocumentLinkResolver(conversations);
  for (const item of items) {
    expect(item.link.endsWith("|Plan")).toBe(true);
    expect(resolve(item.link.split("|")[0])).toBe(item.id);
  }
  const [bracketed] = wikiLinkSuggestions({ conversations }, "draft");
  expect(bracketed.title).toBe("Draft v2 notes");
  expect(bracketed.link).not.toMatch(/[\][]/);
  expect(resolve(bracketed.link.split("|")[0])).toBe("brackets");
});

test("finds the finished link the caret is in", () => {
  const line = "See [[Senolytics overview|senolytics]] and [[Plan#Goals]].";
  expect(findWikiLinkAround(line, 6)).toEqual({ start: 4, end: 38, target: "Senolytics overview" });
  expect(findWikiLinkAround(line, 30)).toEqual({ start: 4, end: 38, target: "Senolytics overview" });
  expect(findWikiLinkAround(line, 36)).toEqual({ start: 4, end: 38, target: "Senolytics overview" });
  expect(findWikiLinkAround(line, 40)).toBeNull();
  expect(findWikiLinkAround(line, 48)?.target).toBe("Plan");
  expect(findWikiLinkAround("See [[unfinished", 10)).toBeNull();
  expect(findWikiLinkAround("See [[]] here", 6)).toBeNull();
});

test("resolves a link to a document here or still in the cloud", () => {
  expect(resolveWikiLinkDocument("Sleep and longevity", conversations)).toEqual({ id: "sleep", title: "Sleep and longevity" });
  expect(resolveWikiLinkDocument("Plan", conversations)).toBeNull();
  const cloud = [
    { path: "Notes/Cloud parent — aa-bb.md", id: "cloudparent", type: "note", kind: "note", title: "Cloud parent", revision: "1" },
    { path: "Notes/Cloud only — cc-dd.md", id: "cloudonly", type: "note", kind: "note", title: "Cloud only", revision: "1", parentPath: "Notes/Cloud parent — aa-bb.md" },
  ] as const;
  expect(resolveWikiLinkDocument("cloud only", conversations, cloud as never)).toEqual({ id: "cloudonly", title: "Cloud only", cloudPath: "Notes/Cloud only — cc-dd.md", detail: "Cloud parent" });
  expect(resolveWikiLinkDocument("Cloud only — cc-dd", conversations, cloud as never)?.id).toBe("cloudonly");
  expect(resolveWikiLinkDocument("Missing", conversations, cloud as never)).toBeNull();
});
