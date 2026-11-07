import { describe, expect, test } from "bun:test";
import {
  buildMuseCategoriesPrompt, museCategoryGroups, museDocumentExcerpt, museDocumentSignature, museKnownCategories,
  musePendingIds, museSortableIds, readMuseCategoryCache,
} from "../client/src/lib/museCategories";
import type { Conversation } from "../client/src/types";

function doc(id: string, title: string, text = "", extra: Partial<Conversation> = {}): Conversation {
  return {
    id, title, parentId: null, childIds: [], branchAnchor: null, serviceId: "openai-api", modelId: "gpt-5.6", messages: [],
    createdAt: "2026-11-01T00:00:00.000Z", updatedAt: "2026-11-01T00:00:00.000Z",
    document: { schemaVersion: 1, blocks: text ? [{ id: `${id}-b`, type: "markdown", content: text } as never] : [] } as never,
    ...extra,
  } as Conversation;
}

describe("Muse categories", () => {
  const conversations: Record<string, Conversation> = {
    a: doc("a", "Rapamycin dosing", "# Rapamycin dosing\n\nWeekly **dosing** and [[mTOR]] notes."),
    b: doc("b", "Lab-grown kidneys", "Organoids and scaffolds."),
    hidden: doc("hidden", "Private journal", "secret", { hiddenFromAI: true }),
    child: doc("child", "Margin note", "about dosing", { parentId: "a" }),
  };
  conversations.a.childIds = ["child"];

  test("sends main documents only, never ones hidden from AI", () => {
    expect(museSortableIds(["a", "b", "hidden", "child", "missing", "a"], conversations)).toEqual(["a", "b"]);
  });

  test("excerpts read as plain text", () => {
    expect(museDocumentExcerpt(conversations.a)).toBe("Weekly dosing and mTOR notes.");
  });

  test("prompt lists known categories, then numbered documents", () => {
    const { content, ids } = buildMuseCategoriesPrompt(["a", "b"], conversations, ["Longevity"]);
    expect(ids).toEqual(["a", "b"]);
    expect(content).toBe("Categories in use: Longevity\nD1: Rapamycin dosing — Weekly dosing and mTOR notes.\nD2: Lab-grown kidneys — Organoids and scaffolds.");
  });

  test("re-sorts changed documents but leaves ones filed by hand", () => {
    const cache = {
      a: { name: "Longevity", signature: museDocumentSignature(conversations.a) },
      b: { name: "Organs", signature: "stale" },
    };
    expect(musePendingIds(["a", "b"], conversations, cache)).toEqual(["b"]);
    expect(musePendingIds(["a", "b"], conversations, { ...cache, b: { ...cache.b, manual: true } })).toEqual([]);
  });

  test("boxes merge spellings of one category, in name order", () => {
    const cache = readMuseCategoryCache({
      a: { name: "longevity", signature: "x" }, b: { name: "Kidney repair", signature: "y" }, c: { name: "Longevity ", signature: "z", manual: true },
      bad: { name: 3 },
    });
    expect(Object.keys(cache)).toEqual(["a", "b", "c"]);
    const groups = museCategoryGroups(["a", "b", "c", "hidden"], cache);
    expect(Object.values(groups).map((group) => [group.name, group.conversationIds])).toEqual([["Kidney repair", ["b"]], ["longevity", ["a", "c"]]]);
    expect(museKnownCategories(cache)).toEqual(["longevity", "Kidney repair"]);
  });
});
