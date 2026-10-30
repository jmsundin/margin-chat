import { describe, expect, test } from "bun:test";
import { emptyExploration, PREVIEW_CARD, type ExploredBatch } from "../client/src/lib/mapExploration";
import {
  addRoot, aiChildren, aiSearchQuestion, aiSubgraphContext, aiSubtopicQuestion, arrange, boundsOf, descendants, explorerStorageKey, fitView, layoutExplorer, readExplorer, removeBranch, wikipediaChildren,
} from "../client/src/lib/topicExplorer";
import { keepExploredItems } from "../client/src/lib/keepExplored";
import { findQuote, passageMarkdown, passageTitle, sanitizePageHtml, WIKIPEDIA_STYLESHEETS, wikipediaPageDocument } from "../client/src/lib/wikipediaReader";
import { parseHTML } from "linkedom";
import { createEmptyState } from "../client/src/initialState";
import type { PublicExpansion, PublicTopic } from "../client/src/lib/publicKnowledge";
import { addExplored, setExpansion } from "../client/src/lib/mapExploration";

const at = "2026-10-30T01:00:00.000Z";
const topic = (id: string, label: string): PublicTopic => ({ id, aliases: [], label, description: `${label} description`, wikidataUrl: `https://www.wikidata.org/wiki/${id}`,
  wikipediaUrl: `https://en.wikipedia.org/wiki/${label.replace(/ /g, "_")}`, retrievedAt: at });
const batch: ExploredBatch = { id: "explore-1", title: "Aging", createdAt: at };
const aging = topic("Q11455", "Aging");
const expansion = (source: PublicTopic, children: Array<[PublicTopic, string]>): PublicExpansion => ({
  topic: source, topics: children.map(([child]) => child), hasMore: false, nextOffset: children.length,
  relations: children.map(([child, kind]) => ({ id: `${source.id}:${kind}:${child.id}`, sourceId: source.id, targetId: child.id, propertyId: `wikipedia-${kind}`, label: kind, sourceUrl: "" })),
});

function explored() {
  let state = addRoot(emptyExploration(), aging, batch);
  const wiki = wikipediaChildren(state, "topic:Q11455", expansion(aging, [
    [topic("Q1", "Biology"), "broader"], [topic("Q2", "Senescence"), "lead"], [topic("Q3", "Longevity"), "section"], [topic("Q4", "Telomere"), "see-also"],
  ]), batch, at);
  state = setExpansion(addExplored(state, batch, wiki), { kind: "item", id: "topic:Q11455" }, { nextOffset: 4, hasMore: false });
  const ai = aiChildren(state, "topic:Q2", { question: "q", answer: "a", related: [
    { id: "Q5", label: "SASP", description: "", relation: "mechanism of" }, { id: "Q3", label: "Longevity", description: "", relation: "already here" },
  ] }, batch, at);
  return addExplored(state, batch, ai);
}

describe("topic explorer", () => {
  test("a Wikipedia subgraph leaves out broader topics and topics already on the map", () => {
    const state = explored();
    expect(Object.keys(state.items).sort()).toEqual(["topic:Q11455", "topic:Q2", "topic:Q3", "topic:Q4", "topic:Q5"]);
    expect(state.items["topic:Q2"].parent).toEqual({ kind: "item", id: "topic:Q11455" });
    expect(state.items["topic:Q5"]).toMatchObject({ via: "AI · mechanism of", parent: { kind: "item", id: "topic:Q2" }, connection: { kind: "related", label: "mechanism of" } });
    expect(state.items["topic:Q3"].parent).toEqual({ kind: "item", id: "topic:Q11455" });
    expect(addRoot(state, aging, batch)).toBe(state);
  });

  test("lays branches out on both sides of the starting topic without overlaps", () => {
    const state = addRoot(explored(), topic("Q6", "Organoid"), { ...batch, id: "explore-2", createdAt: "2026-10-30T02:00:00.000Z" });
    const { boxes, edges } = layoutExplorer(state);
    expect(boxes.size).toBe(6);
    const root = boxes.get("topic:Q11455")!;
    // Branches alternate sides in the order they were found (by title within one lookup).
    expect(boxes.get("topic:Q3")!.x).toBeGreaterThan(root.x + root.width);
    expect(boxes.get("topic:Q2")!.x + PREVIEW_CARD.width).toBeLessThan(root.x);
    expect(boxes.get("topic:Q4")!.x).toBeGreaterThan(root.x + root.width);
    expect(boxes.get("topic:Q5")!.x).toBeLessThan(boxes.get("topic:Q2")!.x);
    expect(edges.find((edge) => edge.to === "topic:Q2")?.side).toBe("left");
    expect(edges.find((edge) => edge.to === "topic:Q5")?.side).toBe("left");
    // The second starting topic sits below the first tree.
    const firstBottom = Math.max(...["topic:Q11455", "topic:Q2", "topic:Q3", "topic:Q4", "topic:Q5"].map((id) => boxes.get(id)!.y + PREVIEW_CARD.height));
    expect(boxes.get("topic:Q6")!.y).toBeGreaterThan(firstBottom);
    const list = [...boxes.values()];
    for (const a of list) for (const b of list) if (a !== b) expect(a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height).toBe(false);
  });

  test("removing a node removes its branches and their expansions", () => {
    const state = explored();
    expect(descendants(state, "topic:Q2").sort()).toEqual(["topic:Q2", "topic:Q5"]);
    const next = removeBranch(state, "topic:Q11455");
    expect(next.items).toEqual({});
    expect(next.expansions).toEqual({});
    expect(next.batches).toEqual({});
    expect(Object.keys(removeBranch(state, "topic:Q2").items).sort()).toEqual(["topic:Q11455", "topic:Q3", "topic:Q4"]);
  });

  test("saving a deep node saves the path that leads to it as connected topic notes", () => {
    const state = explored();
    const { state: vault, kept } = keepExploredItems(createEmptyState(), state, ["topic:Q5"], { createdAt: at, newNote: () => ({ id: "n", noteId: "n" }) });
    expect(Object.keys(kept).sort()).toEqual(["topic:Q11455", "topic:Q2", "topic:Q5"]);
    const titles = Object.values(vault.conversations).filter((conversation) => conversation.publicTopic).map((conversation) => conversation.title).sort();
    expect(titles).toEqual(["Aging", "SASP", "Senescence"]);
  });

  test("reads its own stored copy, apart from the map's previews", () => {
    const state = explored();
    const storage = { getItem: (key: string) => key === explorerStorageKey("w") ? JSON.stringify(state) : null };
    expect(Object.keys(readExplorer(storage, "w").items).length).toBe(5);
    expect(readExplorer(storage, "other")).toEqual(emptyExploration());
    expect(readExplorer({ getItem: () => "{broken" }, "w")).toEqual(emptyExploration());
  });

  test("asks AI for what is not explored yet and fits views", () => {
    expect(aiSubtopicQuestion("Aging", [])).toContain("subtopics");
    expect(aiSubtopicQuestion("Aging", ["Senescence", "Longevity"])).toContain("Leave out Senescence, Longevity");
    expect(aiSubtopicQuestion("A".repeat(300), Array(20).fill("B".repeat(40))).length).toBeLessThanOrEqual(500);
    const bounds = boundsOf([{ x: 0, y: 0, width: 100, height: 50 }, { x: 300, y: 200, width: 100, height: 50 }])!;
    expect(bounds).toEqual({ x: 0, y: 0, width: 400, height: 250 });
    const view = fitView(bounds, 1000, 800);
    expect(view.scale).toBe(1);
    expect(view.x).toBe(300);
    expect(fitView(bounds, 300, 300).scale).toBeLessThan(1);
    expect(boundsOf([])).toBeNull();
  });
});

describe("topic explorer arrangements", () => {
  const many = () => {
    let state = explored();
    const extra = wikipediaChildren(state, "topic:Q3", expansion(topic("Q3", "Longevity"), Array.from({ length: 9 }, (_, i) => [topic(`Q9${i}`, `Longevity topic ${i}`), "section"] as [PublicTopic, string])), batch, at);
    state = addExplored(state, batch, extra);
    return addRoot(state, topic("Q6", "Organoid"), { ...batch, id: "explore-2", createdAt: "2026-10-30T02:00:00.000Z" });
  };
  const overlaps = (boxes: Map<string, { x: number; y: number; width: number; height: number }>) => {
    const list = [...boxes.values()];
    return list.some((a, i) => list.slice(i + 1).some((b) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height));
  };

  for (const arrangement of ["tree", "radial", "network", "grid"] as const) {
    test(`${arrangement} shows every topic without overlaps`, () => {
      const state = many();
      const layout = arrange(state, arrangement);
      expect(layout.boxes.size).toBe(Object.keys(state.items).length);
      expect(overlaps(layout.boxes)).toBe(false);
      expect(layout.edges.length).toBe(Object.keys(state.items).length - 2);
      expect(arrange(state, arrangement)).toEqual(layout);
    });
  }

  test("focus shows a topic with its parent above, branches below and siblings beside", () => {
    const state = many();
    const { boxes, edges } = arrange(state, "brain", { focusId: "topic:Q3" });
    const focus = boxes.get("topic:Q3")!;
    expect(boxes.get("topic:Q11455")!.y).toBeLessThan(focus.y);
    expect(boxes.get("topic:Q90")!.y).toBeGreaterThan(focus.y);
    expect(boxes.get("topic:Q2")!.x).toBeGreaterThan(focus.x + focus.width);
    expect(boxes.has("topic:Q5")).toBe(false);
    expect(boxes.size).toBe(1 + 1 + 2 + 9);
    expect(overlaps(boxes)).toBe(false);
    expect(edges).toContainEqual({ from: "topic:Q3", to: "topic:Q90" });
    // With no focus it starts from the first starting topic, beside the other one.
    const start = arrange(state, "brain");
    expect(start.boxes.get("topic:Q11455")).toEqual({ x: -PREVIEW_CARD.width / 2, y: -PREVIEW_CARD.height / 2, ...PREVIEW_CARD });
    expect(start.boxes.has("topic:Q6")).toBe(true);
  });

  test("canvas keeps dragged spots and places new branches beside their parent", () => {
    const state = many();
    const { boxes } = arrange(state, "canvas", { positions: { "topic:Q3": { x: 1000, y: 1000 } } });
    expect(boxes.get("topic:Q3")).toMatchObject({ x: 1000, y: 1000 });
    expect(boxes.get("topic:Q90")!.x).toBe(1000 + PREVIEW_CARD.width + 48);
    expect(overlaps(boxes)).toBe(false);
  });
});

describe("explore reading and AI context", () => {
  test("AI subgraph context names the path, siblings and branches, and the prompt leads the question", () => {
    const state = explored();
    const context = aiSubgraphContext(state, "topic:Q2");
    expect(context).toContain("Path from the starting topic: Aging (Aging description) → Senescence (Senescence description)");
    expect(context).toContain("Other branches beside it: Longevity, Telomere");
    expect(context).toContain("Branches it already has: SASP");
    expect(aiSubgraphContext(state, "topic:Q11455")).not.toContain("Path from the starting topic: Aging (Aging description) →");
    expect(aiSubgraphContext(state, "missing")).toBe("");
    const question = aiSubtopicQuestion("Senescence", ["SASP"], "  drugs that\nclear senescent cells ");
    expect(question).toContain("Focus on: drugs that clear senescent cells.");
    expect(question.indexOf("Focus on")).toBeLessThan(question.indexOf("Leave out"));
  });

  test("the article page keeps Wikipedia's markup and styling hooks but nothing active", () => {
    const html = `<body><header><h1 class="pcs-edit-section-title">Ageing</h1></header>
      <section data-mw-section-id="0" class="pcs-section"><p onclick="steal()" class="lead" style="color:red">Ageing is <a rel="mw:WikiLink" href="./Cellular_senescence" title="Cellular senescence">senescence</a>, <a href="https://example.org/x">a site</a>, <a href="#cite_note-1">[1]</a> and <a href="javascript:alert(1)">bad</a>.</p>
      <span class="pcs-lazy-load-placeholder pcs-lazy-load-placeholder-pending" data-class="mw-file-element" data-src="//upload.wikimedia.org/a.png" data-width="220" data-height="140" data-alt="Diagram" data-srcset="//upload.wikimedia.org/a2.png 2x, https://evil.example/b.png 3x"><span></span></span>
      <img src="https://evil.example/x.png"><img src="//upload.wikimedia.org/c.png" onerror="steal()">
      <span class="pcs-edit-section-link-container"><a href="/edit">edit</a></span>
      <div style="background:url(https://evil.example/t.png)">styled</div>
      <script>alert(1)</script><iframe src="https://evil.example"></iframe><form><input></form><link rel="stylesheet" href="https://evil.example/s.css"><style>body{}</style>
      <table class="infobox"><tr><td colspan="2">Box</td></tr></table></section></body>`;
    const out = sanitizePageHtml(html, (text) => parseHTML(`<!doctype html><html>${text}</html>`).document as unknown as Document);
    expect(out).toContain('data-wiki-title="Cellular senescence"');
    expect(out).toContain('href="https://en.wikipedia.org/wiki/Cellular_senescence"');
    expect(out).toContain('class="lead"');
    expect(out).toContain('style="color:red"');
    expect(out).toContain('href="#cite_note-1"');
    expect(out).toContain('src="https://upload.wikimedia.org/a.png"');
    expect(out).toContain('srcset="https://upload.wikimedia.org/a2.png 2x"');
    expect(out).toContain('alt="Diagram"');
    expect(out).toContain('src="https://upload.wikimedia.org/c.png"');
    expect(out).toContain('class="infobox"');
    expect(out).toContain('colspan="2"');
    expect(out).toMatch(/<a [^>]*target="_blank"[^>]*>a site<\/a>/);
    for (const gone of ["<script", "onclick", "onerror", "evil.example", "javascript:", "<iframe", "<form", "<input", "<link", "<style", "pcs-lazy-load-placeholder", "/edit", "url("]) expect(out).not.toContain(gone);
  });

  test("the frame page uses Wikipedia's stylesheets and the app's theme", () => {
    const page = wikipediaPageDocument({ title: "Ageing", url: "https://en.wikipedia.org/wiki/Ageing", html: "<p>Text</p>" }, "dark");
    for (const href of WIKIPEDIA_STYLESHEETS) expect(page).toContain(`<link rel="stylesheet" href="${href}">`);
    expect(page).toContain('class="pcs-theme-dark"');
    expect(page).toContain("::highlight(explore-passage-notes)");
    expect(page).not.toContain("<script");
    expect(wikipediaPageDocument({ title: "A", url: "", html: "" }, "light")).toContain('class="pcs-theme-default"');
  });

  test("passages become quoted markdown with their source, and quotes are found loosely", () => {
    expect(passageMarkdown({ article: "Ageing", url: "https://en.wikipedia.org/wiki/Ageing", quote: "Cells stop\n\ndividing.", text: "Check this" }))
      .toBe("> Cells stop\n>\n> dividing.\n\n— [Ageing](https://en.wikipedia.org/wiki/Ageing), Wikipedia\n\nCheck this\n");
    expect(passageTitle("one two three four five six seven eight nine ten")).toBe("one two three four five six seven eight…");
    expect(findQuote("a  cell\nstops dividing here", "cell stops dividing")).toEqual({ start: 3, end: 22 });
    expect(findQuote("nothing", "cell")).toBeNull();
  });
});

test("the AI search question names what was typed and stays short", () => {
  const question = aiSearchQuestion("  how do   cells age?  ");
  expect(question).toContain('"how do cells age?"');
  expect(aiSearchQuestion("x".repeat(2000)).length).toBeLessThanOrEqual(500);
});
