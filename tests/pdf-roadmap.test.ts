import { describe, expect, test } from "bun:test";
import type { PdfOutlineEntry } from "../client/src/lib/pdfOutline";
import { pdfContentsDraftGoal, pdfOutlineRoadmapProposal, pdfPageFromLinkTarget, pdfPageLink, pdfRoadmapTitle, PDF_ROADMAP_MAX_STEPS } from "../client/src/lib/pdfRoadmap";
import { createDocumentLinkResolver } from "../client/src/lib/documentRelations";
import { resolveWikiLinkDocument } from "../client/src/lib/wikiLinkSuggestions";
import { applyRoadmapDraft, buildRoadmapGraph, getRoadmap, roadmapDraftIds } from "../client/src/lib/roadmap";
import { createEmptyState, createStandaloneNoteConversation } from "../client/src/initialState";
import type { AppState, Conversation } from "../client/src/types";

let made = 0;
const entry = (title: string, page: number | null, items: PdfOutlineEntry[] = []): PdfOutlineEntry =>
  ({ id: `e${made += 1}`, title, page, top: null, bold: false, italic: false, items });
const options = { roadmapId: "roadmap", roadmapTitle: "Biology roadmap", pdfTitle: "Biology.pdf", pageCount: 300 };

describe("roadmap from a PDF's contents", () => {
  test("chapters become stages and their sections steps, each with its pages and a page link", () => {
    const proposal = pdfOutlineRoadmapProposal([
      entry("Cover", 1),
      entry("Contents", 3),
      entry("Chapter 1 Cells", 10, [entry("1.1 Membranes", 10), entry("1.2 Organelles", 24, [entry("Mitochondria", 30)])]),
      entry("Chapter 2 Aging", 50, [entry("2.1 Hallmarks", 50)]),
      entry("Appendix", 280),
      entry("Index", 295),
    ], options)!;
    expect(proposal.stages.map((stage) => stage.title)).toEqual(["Chapter 1 Cells", "Chapter 2 Aging", "Appendix"]);
    const [membranes, organelles] = proposal.stages[0].steps;
    expect(membranes).toEqual({ key: "s1", title: "1.1 Membranes", notes: "Read [[Biology.pdf#page=10|pages 10–23]] of Biology.pdf.", needs: [] });
    expect(organelles.notes).toBe("Read [[Biology.pdf#page=24|pages 24–49]] of Biology.pdf.\n- [[Biology.pdf#page=30|Mitochondria]] (p. 30)");
    expect(organelles.needs).toEqual(["s1"]);
    // A chapter with no sections is a stage of one step; the last one runs to the next entry, even one left off.
    expect(proposal.stages[2].steps).toEqual([{ key: "s4", title: "Appendix", notes: "Read [[Biology.pdf#page=280|pages 280–294]] of Biology.pdf.", needs: ["s3"] }]);
  });

  test("a book wrapped in one entry starts a level down, and a flat list is one stage", () => {
    const wrapped = pdfOutlineRoadmapProposal([entry("Biology", 1, [entry("Part I", 2, [entry("Ch 1", 2)]), entry("Part II", 40, [entry("Ch 2", 40)])])], options)!;
    expect(wrapped.stages.map((stage) => stage.title)).toEqual(["Part I", "Part II"]);
    const flat = pdfOutlineRoadmapProposal([entry("One", 1), entry("Two", 9), entry("Three", null)], options)!;
    expect(flat.stages).toHaveLength(1);
    expect(flat.stages[0].steps.map((step) => [step.title, step.notes])).toEqual([
      ["One", "Read [[Biology.pdf#page=1|pages 1–8]] of Biology.pdf."], ["Two", "Read [[Biology.pdf#page=9|pages 9–300]] of Biology.pdf."], ["Three", ""]]);
  });

  test("too many sections: chapters become the steps, with their sections as notes", () => {
    const chapters = Array.from({ length: 30 }, (_, chapter) => entry(`Chapter ${chapter + 1}`, chapter * 10 + 1,
      Array.from({ length: 8 }, (_, section) => entry(`${chapter + 1}.${section + 1}`, chapter * 10 + 1 + section))));
    const proposal = pdfOutlineRoadmapProposal(chapters, options)!;
    expect(30 * 8).toBeGreaterThan(PDF_ROADMAP_MAX_STEPS);
    expect(proposal.stages).toHaveLength(1);
    expect(proposal.stages[0].steps).toHaveLength(30);
    expect(proposal.stages[0].steps[0].notes).toContain("- [[Biology.pdf#page=2|1.2]] (p. 2)");
  });

  test("printed page labels show in the notes; links keep real page numbers", () => {
    const labels = Array.from({ length: 300 }, (_, index) => index < 10 ? ["i", "ii", "iii", "iv", "v", "vi", "vii", "viii", "ix", "x"][index] : String(index - 9));
    const proposal = pdfOutlineRoadmapProposal([entry("Preface", 5), entry("Chapter 1", 11)], { ...options, labels })!;
    expect(proposal.stages[0].steps[0].notes).toBe("Read [[Biology.pdf#page=5|pages v–x]] of Biology.pdf.");
  });

  test("nothing to study gives no roadmap", () => {
    expect(pdfOutlineRoadmapProposal([], options)).toBeNull();
    expect(pdfOutlineRoadmapProposal([entry("Cover", 1), entry("Index", 9)], options)).toBeNull();
  });

  test("names, links and the AI fallback's goal", () => {
    expect(pdfRoadmapTitle("Biology.pdf")).toBe("Biology roadmap");
    expect(pdfPageLink("Bio.pdf", 4, "A [b] | c")).toBe("[[Bio.pdf#page=4|A b c]]");
    expect(pdfPageFromLinkTarget("Bio.pdf#page=12")).toBe(12);
    expect(pdfPageFromLinkTarget("Bio.pdf#Heading")).toBeNull();
    const goal = pdfContentsDraftGoal("Bio.pdf", ["", "Contents\n1 Cells .... 3"]);
    expect(goal).toContain("[Page 2]\nContents\n1 Cells .... 3");
    expect(goal).not.toContain("[Page 1]");
  });
});

describe("links to a PDF page", () => {
  const pdf: Conversation = { ...createStandaloneNoteConversation({ id: "pdf-doc", noteId: "n1", createdAt: "2026-11-21T00:00:00.000Z" }), title: "Biology.pdf",
    vaultFile: { path: "Books/Biology.pdf", kind: "pdf" } };
  const conversations = { [pdf.id]: pdf };
  test("resolve to the PDF and carry the page", () => {
    expect(createDocumentLinkResolver(conversations)("Biology.pdf#page=12")).toBe("pdf-doc");
    expect(resolveWikiLinkDocument("Biology.pdf#page=12", conversations)).toMatchObject({ id: "pdf-doc", page: 12 });
    expect(resolveWikiLinkDocument("Biology.pdf", conversations)?.page).toBeUndefined();
  });
  test("a title with # in it still resolves as written", () => {
    const sharp = { ...createStandaloneNoteConversation({ id: "sharp", noteId: "n2", createdAt: "2026-11-21T00:00:00.000Z" }), title: "C# basics" };
    expect(createDocumentLinkResolver({ sharp })("C# basics")).toBe("sharp");
  });
});

describe("applying the roadmap", () => {
  test("each step becomes a document under the roadmap, in order", () => {
    const at = "2026-11-21T00:00:00.000Z";
    const roadmap = { ...createStandaloneNoteConversation({ id: "roadmap", noteId: "n3", createdAt: at }), title: "Biology roadmap" };
    const state: AppState = { ...createEmptyState(), conversations: { roadmap } };
    const proposal = pdfOutlineRoadmapProposal([entry("Ch 1", 1, [entry("1.1", 1), entry("1.2", 5)]), entry("Ch 2", 9)], options)!;
    let n = 0;
    const result = applyRoadmapDraft(state, proposal, roadmapDraftIds(proposal, (prefix) => `${prefix}-${n += 1}`), { updatedAt: at })!;
    expect(result.created).toBe(3);
    const graph = buildRoadmapGraph(getRoadmap(result.state.conversations.roadmap), result.state.conversations);
    expect(graph.stages.map((stage) => stage.title)).toEqual(["Ch 1", "Ch 2"]);
    const titles = getRoadmap(result.state.conversations.roadmap).nodes.map((node) => result.state.conversations[node.target.docId].title);
    expect(titles).toEqual(["1.1", "1.2", "Ch 2"]);
  });
});
