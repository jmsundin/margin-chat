import { describe, expect, test } from "bun:test";
import { normalizeAIExecution } from "@margin-chat/workspace-contracts";
import { createProposalTools } from "../server/chat/agent/proposalTools.mjs";
import { officialRoadmapOutline, readRoadmapSh, roadmapShLocation } from "../server/chat/agent/roadmapSh.mjs";
import { readImportPage } from "../server/chat/agent/webImport.mjs";
import { pastedWebAddresses } from "../server/chat/agent/webTools.mjs";
import { createEmptyState, createStandaloneNoteConversation } from "../client/src/initialState";
import { applyRoadmapDraft, buildRoadmapGraph, getRoadmap, roadmapDraftIds, roadmapDraftLink, roadmapDraftPrompt, roadmapNodeTitle } from "../client/src/lib/roadmap";
import { getEditableDocument } from "../client/src/lib/editableDocument";
import type { AgentRoadmapProposal, AppState } from "../client/src/types";

const at = "2026-11-13T12:00:00.000Z";
const AI_URL = "https://roadmap.sh/ai/roadmap/fastapi-development-s56nq";

describe("Draft with AI from a link", () => {
  test("finds the link in what was typed, with or without https", () => {
    expect(roadmapDraftLink("Biology of aging")).toBeNull();
    expect(roadmapDraftLink("e.g. cells")).toBeNull();
    expect(roadmapDraftLink(AI_URL)).toBe(AI_URL);
    expect(roadmapDraftLink("roadmap.sh/frontend")).toBe("https://roadmap.sh/frontend");
    expect(roadmapDraftLink("see https://x.com/someone/status/123.")).toBe("https://x.com/someone/status/123");
  });

  test("asks the agent to follow the page, and the server lets it read that address", () => {
    expect(roadmapDraftPrompt("Biology of aging")).toContain("Draft a learning roadmap for: Biology of aging");
    const prompt = roadmapDraftPrompt(`roadmap.sh/ai/roadmap/fastapi-development-s56nq only the basics`);
    expect(prompt).toContain(`Build this roadmap from the page at ${AI_URL}`);
    expect(prompt).toContain("Also keep in mind: only the basics");
    expect(pastedWebAddresses({ messages: [{ role: "user", content: prompt }] })).toEqual([AI_URL]);
  });
});

describe("roadmap.sh pages", () => {
  test("tells roadmaps from the site's other pages", () => {
    expect(roadmapShLocation(AI_URL)).toEqual({ kind: "ai", slug: "fastapi-development-s56nq" });
    expect(roadmapShLocation("https://roadmap.sh/frontend")).toEqual({ kind: "official", slug: "frontend" });
    expect(roadmapShLocation("https://roadmap.sh/guides")).toBeNull();
    expect(roadmapShLocation("https://roadmap.sh/frontend/html")).toBeNull();
    expect(roadmapShLocation("https://example.com/frontend")).toBeNull();
  });

  test("reads an AI roadmap's outline from the site's data, since the page needs JavaScript", async () => {
    const asked: string[] = [];
    const page = await readImportPage(AI_URL, { fetchPage: async (address: string) => {
      asked.push(address);
      return { html: JSON.stringify({ title: "FastAPI Development", description: "Step by step", data: "# FastAPI Development\n\n## Introduction\n### Python Basics\n- Syntax and variables\n" }) };
    } });
    expect(asked).toEqual(["https://roadmap.sh/api/v1-get-ai-roadmap/fastapi-development-s56nq"]);
    expect(page.title).toBe("FastAPI Development");
    expect(page.markdown).toBe(`# FastAPI Development\n\nStep by step\n\nSource: ${AI_URL}\n\n## Introduction\n### Python Basics\n- Syntax and variables`);
  });

  test("turns one of the site's own roadmaps into topics with their subtopics, top to bottom", async () => {
    const node = (id: string, type: string, label: string, x: number, y: number) => ({ id, type, position: { x, y }, data: { label } });
    const data = { title: { page: "Frontend Developer" }, description: "Guide in @currentYear@",
      nodes: [node("t2", "topic", "HTML", 0, 200), node("t1", "topic", "Internet", 0, 100), node("s1", "subtopic", "What is HTTP?", 300, 110),
        node("s2", "subtopic", "DNS", 300, 90), node("s3", "subtopic", "Forms", -300, 210), node("b", "button", "Visit", 0, 0)],
      edges: [{ source: "t1", target: "s1" }, { source: "s2", target: "t1" }] };
    expect(officialRoadmapOutline(data)).toBe("## Internet\n- DNS\n- What is HTTP?\n\n## HTML\n- Forms");
    const page = await readRoadmapSh({ kind: "official", slug: "frontend" }, async () => ({ html: JSON.stringify(data) }), "https://roadmap.sh/frontend");
    expect(page?.title).toBe("Frontend Developer");
    expect(page?.markdown).toContain(`Guide in ${new Date().getFullYear()}`);
    // A page that isn't a roadmap after all is read as an ordinary page.
    expect(await readRoadmapSh({ kind: "official", slug: "nope" }, async () => ({ html: "<html>" }), "https://roadmap.sh/nope")).toBeNull();
  });
});

const tools = () => createProposalTools({
  chatRequest: { ai: { mode: "balanced" }, conversation: { id: "roadmap", ancestorContext: [] }, messages: [{ role: "user", content: "Build this roadmap" }] },
  snapshots: new Map(), reachable: (id: string) => id === "python",
});
const args = (steps: unknown[]) => ({ roadmap_id: "", goal: "FastAPI", summary: "", stages: [{ title: "Introduction", steps }] });

describe("roadmap steps that make new documents", () => {
  test("propose_roadmap takes steps with notes instead of a document", () => {
    const run = tools();
    const result = run.run("propose_roadmap", args([
      { key: "python", document_id: "python", title: "", notes: null, why: "", needs: [] },
      { key: "web", document_id: "", title: "Web Concepts", notes: "- HTTP protocol basics\n- Request methods", why: "", needs: ["python"] },
    ]));
    expect(result.ok).toBe(true);
    const [proposal] = run.list();
    expect(proposal.stages[0].steps).toEqual([{ key: "python", documentId: "python", needs: [] },
      { key: "web", notes: "- HTTP protocol basics\n- Request methods", title: "Web Concepts", needs: ["python"] }]);
    const saved = normalizeAIExecution({ schemaVersion: 1, model: "m", provider: "meta-api", agent: { steps: [], stopReason: "answered", proposals: [proposal] } });
    expect(saved?.agent?.proposals).toEqual([proposal]);
    const error = (step: unknown) => (tools().run("propose_roadmap", args([step])) as { error?: string }).error;
    expect(error({ key: "a", document_id: "", title: "", notes: "- x", why: "", needs: [] })).toContain("no title");
    // Missing notes make an empty new document, and long notes are cut to fit, rather than failing the roadmap.
    const lenient = tools();
    expect(lenient.run("propose_roadmap", args([{ key: "a", document_id: "", title: "A", notes: null, why: "", needs: [] }, { key: "b", document_id: "", title: "B", notes: "x".repeat(2_001), why: "", needs: [] }]))).toMatchObject({ ok: true });
    expect(lenient.list()[0].stages[0].steps.map((item: any) => item.notes.length)).toEqual([0, 2_000]);
  });

  test("approving creates the documents under the roadmap and points the steps at them", () => {
    const state: AppState = createEmptyState();
    for (const id of ["roadmap", "python"]) {
      const note = createStandaloneNoteConversation({ createdAt: at, id, noteId: `${id}-note` });
      note.title = id === "python" ? "Python" : "FastAPI";
      state.conversations[id] = note;
    }
    const proposal: AgentRoadmapProposal = { id: "proposal-1", kind: "roadmap", roadmapId: "roadmap", roadmapTitle: "FastAPI", goal: "FastAPI", summary: "",
      stages: [{ title: "Introduction", steps: [{ key: "python", documentId: "python", needs: [] },
        { key: "web", title: "Web Concepts", notes: "- HTTP protocol basics\n- Request methods", needs: ["python"] }] },
      { title: "Core", steps: [{ key: "paths", title: "Path Parameters", notes: "", needs: ["web"] }] }] };
    let made = 0;
    const ids = roadmapDraftIds(proposal, (prefix) => `${prefix}-${made += 1}`);
    const once = applyRoadmapDraft(state, proposal, ids, { updatedAt: at })!;
    expect(once).toMatchObject({ added: 3, created: 2, skipped: 0 });
    // The same IDs give the same result, however often the state update runs.
    expect(applyRoadmapDraft(state, proposal, ids, { updatedAt: at })!.state).toEqual(once.state);
    const roadmap = getRoadmap(once.state.conversations.roadmap);
    const web = once.state.conversations[ids.documents!.web.conversation];
    expect(web.title).toBe("Web Concepts");
    expect(web.parentId).toBe("roadmap");
    expect(getEditableDocument(web).blocks.map((block) => block.content).join("\n")).toContain("HTTP protocol basics");
    expect(roadmap.stages.map((stage) => stage.title)).toEqual(["Introduction", "Core"]);
    expect(roadmap.nodes.map((node) => roadmapNodeTitle(node, once.state.conversations))).toEqual(["Python", "Web Concepts", "Path Parameters"]);
    const graph = buildRoadmapGraph(roadmap, once.state.conversations);
    expect(graph.edges).toHaveLength(2);
    expect(graph.missing.size).toBe(0);
    // Without IDs for new documents (an older caller), those steps are left out rather than half made.
    expect(applyRoadmapDraft(state, proposal, roadmapDraftIds(proposal), { updatedAt: at })).toMatchObject({ added: 1, skipped: 2, created: 0 });
  });
});

describe("a roadmap written live", () => {
  const originalFetch = globalThis.fetch;
  const sse = (events: unknown[]) => new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "Content-Type": "text/event-stream" } });
  const step = (key: string, title: string) => ({ key, document_id: "", title, notes: `- About ${title}`, why: "", needs: [] });
  const sent: any[] = [];
  const whole = { roadmap_id: "", goal: "FastAPI", stages: [{ title: "Introduction", steps: [step("a", "Python Basics"), step("b", "Web Concepts")] },
    { title: "Core", steps: [step("c", "Path Parameters"), step("d", "Request Body")] }], summary: "Follows the page." };

  async function run(written: string, status: "completed" | "incomplete", maxInputCharacters?: number) {
    const drafts: any[] = [];
    sent.length = 0;
    let calls = 0;
    globalThis.fetch = (async (_url: any, init: any) => {
      calls += 1;
      sent.push(JSON.parse(init.body));
      if (calls > 1) return sse([{ type: "response.completed", response: { status: "completed", output_text: "Here is the roadmap.", output: [] } }]);
      const pieces = written.match(/[\s\S]{1,40}/gu) ?? [];
      return sse([{ type: "response.output_item.added", item: { id: "item_1", type: "function_call", name: "propose_roadmap" } },
        ...pieces.map((delta) => ({ type: "response.function_call_arguments.delta", item_id: "item_1", delta })),
        { type: `response.${status}`, response: { status, output: [{ id: "item_1", type: "function_call", name: "propose_roadmap", call_id: "call_1", arguments: written }] } }]);
    }) as typeof fetch;
    try {
      const { runAgent } = await import("../server/chat/agent/runner.mjs");
      const result = await runAgent({ provider: "meta", apiKey: "meta", model: "muse-wonder-1.0", systemInstruction: "Help.", maxOutputTokens: 500, usageMeter: null, proposals: true, maxInputCharacters,
        chatRequest: { ai: { mode: "balanced" }, conversation: { id: "roadmap", ancestorContext: [] }, messages: [{ role: "user", content: "Build this roadmap" }] },
        onRoadmapDraft: (draft: unknown) => { drafts.push(draft); } });
      return { drafts, result };
    } finally { globalThis.fetch = originalFetch; }
  }

  test("each finished step is sent on while the model is still writing the call", async () => {
    const { drafts, result } = await run(JSON.stringify(whole), "completed");
    expect(drafts.map((draft) => draft.stages.map((stage: any) => stage.steps.length))).toEqual([[1], [2], [2, 1], [2, 2]]);
    expect(drafts.at(-1)).toEqual({ goal: "FastAPI", count: 6, stages: [{ title: "Introduction", steps: [{ title: "Python Basics" }, { title: "Web Concepts" }] },
      { title: "Core", steps: [{ title: "Path Parameters" }, { title: "Request Body" }] }] });
    expect(result.agent.proposals).toHaveLength(1);
  });

  test("a call cut off at the output limit keeps the steps it finished instead of failing the run", async () => {
    const written = JSON.stringify(whole);
    const { result } = await run(written.slice(0, written.indexOf("Request Body")), "incomplete");
    const [proposal] = result.agent.proposals;
    expect(proposal.stages.map((stage: any) => stage.steps.map((item: any) => item.title))).toEqual([["Python Basics", "Web Concepts"], ["Path Parameters"]]);
    expect(result.reply).toBe("Here is the roadmap.");
  });

  const long = { ...whole, stages: whole.stages.map((stage) => ({ ...stage, steps: stage.steps.map((item) => ({ ...item, notes: `- ${"Learn this well. ".repeat(60)}` })) })) };

  test("a roadmap longer than the room left in the history is still kept, and the model's next call gets a shortened copy", async () => {
    const { result } = await run(JSON.stringify(long), "completed", 2_500);
    expect(result.agent.proposals[0].stages.flatMap((stage: any) => stage.steps).every((item: any) => item.notes.length > 900)).toBe(true);
    expect(result.reply).toBe("Here is the roadmap.");
    const resent = sent[1].input.find((item: any) => item.type === "function_call");
    expect(JSON.parse(resent.arguments).stages[0].steps[0].notes.length).toBeLessThanOrEqual(120);
    expect(JSON.stringify(sent[1].input).length).toBeLessThan(2_500);
  });

  test("when nothing more can be shed, the run ends with the drafted roadmap instead of an error", async () => {
    const { result } = await run(JSON.stringify(long), "completed", 300);
    expect(sent).toHaveLength(1);
    expect(result.agent.proposals).toHaveLength(1);
    expect(result.reply).toBe("The roadmap is drafted and ready for you to review.");
  });
});
