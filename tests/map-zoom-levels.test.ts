import { describe, expect, test } from "bun:test";
import { createMainConversation } from "../client/src/initialState";
import { layoutCanvasGroupBoxes } from "../client/src/lib/canvasGroupBoxes";
import type { ConversationGraphNodePlacement } from "../client/src/lib/conversationGraph";
import { blockFallbackName, groupTopicsIntoThemes, mapZoomLevel, mapZoomLevelScale, mapZoomScales, reachableMapZoomLevels, themeFallbackLabel, MAP_ZOOM_LEVELS } from "../client/src/lib/mapZoomLevels";
import { buildMapLevelsPrompt, carryMapLevelLabels, mapLevelFingerprint, type MapLevelTarget } from "../client/src/lib/useMapLevelLabels";
import type { Conversation, ConversationGroup } from "../client/src/types";

/** Nine topics in three fields; documents are named field.topic.number and alike by what they share. */
const topics = ["bio", "drug", "code"].flatMap((field) => [0, 1, 2].map((topic) => ({
  id: `${field}${topic}`, label: `${field} ${topic}`, memberIds: [0, 1, 2, 3].slice(0, 2 + topic % 3).map((n) => `${field}.${topic}.${n}`) })));
const alike = (a: string, b: string) => {
  const [fieldA, topicA] = a.split("."), [fieldB, topicB] = b.split(".");
  return fieldA !== fieldB ? 0.05 : topicA === topicB ? 0.7 : 0.35;
};

describe("Map themes", () => {
  test("too few topics get no themes", () => {
    expect(groupTopicsIntoThemes(topics.slice(0, 5), alike)).toEqual([]);
  });

  test("topics alike in meaning are gathered into a few themes, each named after its biggest topics", () => {
    const themes = groupTopicsIntoThemes(topics, alike);
    expect(themes).toHaveLength(3);
    // Every topic sits in exactly one theme, and no theme mixes fields.
    expect(themes.flatMap((theme) => theme.topicIds).sort()).toEqual(topics.map((topic) => topic.id).sort());
    for (const theme of themes) expect(new Set(theme.topicIds.map((id) => id.slice(0, -1))).size).toBe(1);
    const whole = themes[0];
    const field = whole.topicIds[0].slice(0, -1);
    expect(whole.topicIds).toEqual([`${field}2`, `${field}1`, `${field}0`]);
    expect(whole.id).toBe(`theme:${field}2`);
    expect(whole.label).toBe(`${field} 2, ${field} 1 and 1 more`);
    expect(whole.memberIds).toHaveLength(9);
  });

  test("the same topics give the same themes whatever order they come in", () => {
    const ids = (list: typeof topics) => groupTopicsIntoThemes(list, alike).map((theme) => `${theme.id}=${[...theme.topicIds].sort()}`).sort();
    expect(ids([...topics].reverse())).toEqual(ids(topics));
  });

  test("topics alike to no other stay outside every theme, and one lone theme is no theme at all", () => {
    const topicOf = (id: string) => id.split(".").slice(0, 2).join(".");
    const apart = (a: string, b: string) => a.startsWith("code") || b.startsWith("code") ? (topicOf(a) === topicOf(b) ? 0.7 : 0.02) : alike(a, b);
    const themes = groupTopicsIntoThemes(topics, apart);
    expect(themes.map((theme) => [...theme.topicIds].sort())).toEqual([["bio0", "bio1", "bio2"], ["drug0", "drug1", "drug2"]]);
    expect(groupTopicsIntoThemes(topics, (a, b) => topicOf(a) === topicOf(b) ? 0.7 : 0.02)).toEqual([]);
    expect(groupTopicsIntoThemes(topics, (a, b) => a.startsWith("bio") && b.startsWith("bio") ? 0.5 : 0.02)).toEqual([]);
  });

  test("stand-in names", () => {
    expect(themeFallbackLabel(["Angular"])).toBe("Angular");
    expect(themeFallbackLabel(["Angular", "React"])).toBe("Angular and React");
    expect(themeFallbackLabel(["Angular", "React", "Vue", "Svelte"])).toBe("Angular, React and 2 more");
    expect(blockFallbackName(["Rapamycin dosing for longevity", "My rapamycin side-effects log", "ITP rapamycin results"])).toBe("Rapamycin");
    expect(blockFallbackName(["Sleep tracker comparison", "Sleep trackers I tried", "Oura vs Whoop"])).toBe("Sleep tracker");
    expect(blockFallbackName(["Horvath clock", "GrimAge vs PhenoAge", "DunedinPACE"])).toBe("Horvath clock +2");
    expect(blockFallbackName(["A very long title that would never fit above a block of circles"])).toBe("A very long title that woul…");
  });
});

describe("Map zoom levels", () => {
  const scales = mapZoomScales({ cardWidth: 200, cardHeight: 96, cellWidth: 224, topicSide: 400, hasThemes: true, hasBlocks: true });

  test("each level hands over to the next as the camera zooms in", () => {
    expect(scales.topicsFrom).toBeCloseTo(0.15);
    // Topic tiles give way to circles exactly where the Map always showed its cards again.
    expect(scales.blocksFrom).toBeCloseTo(56 / 200);
    expect(scales.notesFrom).toBeCloseTo(88 / 224);
    expect(scales.previewsFrom).toBeCloseTo(1.15);
    expect([0.1, 0.2, 0.3, 0.6, 1.3].map((scale) => mapZoomLevel(scale, scales))).toEqual([...MAP_ZOOM_LEVELS]);
    // The ladder lands inside each level, not on its edge.
    for (const level of MAP_ZOOM_LEVELS) expect(mapZoomLevel(mapZoomLevelScale(level, scales), scales)).toBe(level);
  });

  test("without themes or blocks those levels never show", () => {
    const plain = mapZoomScales({ cardWidth: 200, cellWidth: 224, topicSide: 0, hasThemes: false, hasBlocks: false });
    expect([0.01, 0.2, 0.3, 0.6, 1.3].map((scale) => mapZoomLevel(scale, plain))).toEqual(["topics", "topics", "notes", "notes", "previews"]);
    expect(reachableMapZoomLevels(plain, 0.2, { hasThemes: false, hasBlocks: false })).toEqual(["topics", "notes", "previews"]);
  });

  test("a small vault gets a short ladder: levels that would shrink the map to a corner are left out", () => {
    const has = { hasThemes: true, hasBlocks: true };
    expect(reachableMapZoomLevels(scales, 0.1, has)).toEqual([...MAP_ZOOM_LEVELS]);
    expect(reachableMapZoomLevels(scales, 0.3, has)).toEqual(["topics", "blocks", "notes", "previews"]);
    expect(reachableMapZoomLevels(scales, 0.8, has)).toEqual(["notes", "previews"]);
  });
});

describe("Map boxes inside themes", () => {
  const conversations: Record<string, Conversation> = {};
  const groups: Record<string, ConversationGroup> = {};
  const nodes: ConversationGraphNodePlacement[] = [];
  for (const topic of topics) {
    groups[topic.id] = { id: topic.id, name: topic.label, color: "#0f766e", collapsed: false, conversationIds: topic.memberIds };
    for (const id of topic.memberIds) {
      conversations[id] = { ...createMainConversation({ id }), title: id };
      nodes.push({ conversationId: id, x: 0, y: 0, width: 200, height: 96 } as ConversationGraphNodePlacement);
    }
  }
  conversations.loose = createMainConversation({ id: "loose" });
  nodes.push({ conversationId: "loose", x: 0, y: 0, width: 200, height: 96 } as ConversationGraphNodePlacement);
  const themes = groupTopicsIntoThemes(topics, alike).map((theme) => ({ id: theme.id, label: theme.label, groupIds: theme.topicIds }));
  const overlap = (a: { x: number; y: number; width: number; height: number }, b: typeof a) =>
    a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

  test("each theme frames its own topic boxes, and themes never overlap", () => {
    const layout = layoutCanvasGroupBoxes({ nodes, conversations, groups, similarity: alike, themes });
    expect(layout.themes.map((theme) => theme.id).sort()).toEqual(themes.map((theme) => theme.id).sort());
    for (const theme of layout.themes) {
      const own = layout.boxes.filter((box) => box.themeId === theme.id);
      expect(own.map((box) => box.id).sort()).toEqual([...theme.boxIds].sort());
      for (const box of own) {
        expect(box.x).toBeGreaterThan(theme.x);
        expect(box.y).toBeGreaterThan(theme.y);
        expect(box.x + box.width).toBeLessThan(theme.x + theme.width);
        expect(box.y + box.height).toBeLessThan(theme.y + theme.height);
      }
      expect(theme.conversationIds.length).toBe(own.reduce((sum, box) => sum + box.conversationIds.length, 0));
    }
    for (const a of layout.themes) for (const b of layout.themes) if (a !== b) expect(overlap(a, b)).toBe(false);
    for (const a of layout.boxes) for (const b of layout.boxes) if (a !== b) expect(overlap(a, b)).toBe(false);
    // The box of unfiled documents stays outside every theme, and boxes keep their order.
    const none = layout.boxes.at(-1)!;
    expect(none.kind).toBe("none");
    expect(none.themeId).toBeUndefined();
    for (const theme of layout.themes) expect(overlap(none, theme)).toBe(false);
    expect(layout.boxes.map((box) => box.id).slice(0, -1)).toEqual(Object.keys(groups));
    // Every card sits inside its own box.
    for (const node of layout.nodes) {
      const box = layout.boxes.find((item) => item.conversationIds.includes(node.conversationId))!;
      expect(node.x).toBeGreaterThanOrEqual(box.x);
      expect(node.x + node.width).toBeLessThanOrEqual(box.x + box.width);
    }
  });

  test("without themes the boxes sit where they always did", () => {
    const plain = layoutCanvasGroupBoxes({ nodes, conversations, groups, similarity: alike });
    expect(plain.themes).toEqual([]);
    expect(plain.boxes.every((box) => box.themeId === undefined)).toBe(true);
    expect(layoutCanvasGroupBoxes({ nodes, conversations, groups, similarity: alike, themes: [] }).boxes).toEqual(plain.boxes);
  });

  test("a box says where its blocks of alike documents sit", () => {
    const ids = ["a1", "a2", "a3", "b1", "b2", "lone"];
    const docs: Record<string, Conversation> = Object.fromEntries(ids.map((id) => [id, createMainConversation({ id })]));
    const placed = ids.map((id) => ({ conversationId: id, x: 0, y: 0, width: 200, height: 96 }) as ConversationGraphNodePlacement);
    const sameLetter = (a: string, b: string) => a[0] === b[0] && a !== "lone" && b !== "lone" ? 0.8 : 0.05;
    const { boxes, nodes: cards } = layoutCanvasGroupBoxes({ nodes: placed, conversations: docs,
      groups: { g: { id: "g", name: "G", color: "#000", collapsed: false, conversationIds: ids } }, similarity: sameLetter });
    const blocks = boxes[0].blocks!;
    expect(blocks.map((block) => [block.kind, [...block.conversationIds].sort()])).toEqual([["alike", ["a1", "a2", "a3"]], ["alike", ["b1", "b2"]]]);
    for (const block of blocks) {
      for (const id of block.conversationIds) {
        const card = cards.find((item) => item.conversationId === id)!;
        expect(card.x).toBeGreaterThanOrEqual(block.x);
        expect(card.x + card.width).toBeLessThanOrEqual(block.x + block.width);
        expect(card.y).toBeGreaterThanOrEqual(block.y);
        expect(card.y + card.height).toBeLessThanOrEqual(block.y + block.height);
      }
      // No other card sits in a block's patch.
      for (const card of cards) if (!block.conversationIds.includes(card.conversationId)) expect(overlap(card, block)).toBe(false);
    }
    expect(overlap(blocks[0], blocks[1])).toBe(false);
  });
});

describe("Map level labels", () => {
  const conversations: Record<string, Conversation> = {};
  for (const [id, title] of [["a", "Rapamycin dosing"], ["b", "TAME trial; status"], ["c", "Private diary"], ["d", "Untitled document"]] as const) {
    conversations[id] = { ...createMainConversation({ id }), title };
  }
  (conversations.c as Conversation & { hiddenFromAI?: boolean }).hiddenFromAI = true;
  const targets: MapLevelTarget[] = [
    { id: "theme:t", kind: "theme", memberIds: ["a", "b", "c"], name: "Drugs and 1 more", childNames: ["Drugs", "Trials"] },
    { id: "t", kind: "topic", memberIds: ["a", "b", "c", "d"], name: "Drugs" },
    { id: "t\na", kind: "block", memberIds: ["a", "b"], name: "", parentName: "Drugs" },
    { id: "t\nc", kind: "block", memberIds: ["c", "d"], name: "", parentName: "Drugs" },
  ];

  test("one line per group, without titles hidden from AI, and nothing for a block with no titles to go by", () => {
    const { content, codes, sent } = buildMapLevelsPrompt(targets, conversations);
    expect(content.split("\n")).toEqual([
      "T1 (3 notes): Topics: Drugs; Trials",
      "P1 (4 notes): Drugs: Rapamycin dosing; TAME trial, status",
      "B1 (2 notes) in Drugs: Rapamycin dosing; TAME trial, status",
    ]);
    expect(codes).toEqual(["T1", "P1", "B1"]);
    expect(sent.map((target) => target.id)).toEqual(["theme:t", "t", "t\na"]);
    expect(content).not.toContain("Private diary");
  });

  test("a group keeps its label while most of its documents stay", () => {
    const stored = [
      { kind: "topic" as const, fingerprint: mapLevelFingerprint(targets[1]), memberIds: ["a", "b", "c", "d"], summary: "Drugs with a longevity case." },
      { kind: "block" as const, fingerprint: "block:old", memberIds: ["a", "b", "x"], name: "Rapamycin" },
      { kind: "theme" as const, fingerprint: "theme:old", memberIds: ["x", "y", "z"], name: "Other", summary: "Elsewhere." },
    ];
    const labels = carryMapLevelLabels(targets, stored);
    expect(labels.get("t")).toEqual({ name: undefined, summary: "Drugs with a longevity case." });
    expect(labels.get("t\na")?.name).toBe("Rapamycin");
    expect(labels.has("theme:t")).toBe(false);
    expect(labels.has("t\nc")).toBe(false);
    // The fingerprint doesn't depend on the order documents are listed in.
    expect(mapLevelFingerprint({ kind: "topic", memberIds: ["d", "c", "b", "a"] })).toBe(mapLevelFingerprint(targets[1]));
  });
});
