import { describe, expect, test } from "bun:test";
import { buildAgentInstruction, buildSystemInstruction } from "../server/chat/systemPrompt.mjs";
import { roadmapDiveDeeperPrompt, roadmapDraftPrompt, roadmapExplainPrompt, roadmapLanguageLine, roadmapLanguageNote, roadmapOutlinePrompt } from "../client/src/lib/roadmap";

// Jon's ask (2026-11-17): a German goal asking for English explanations with German examples and translations.
const GERMAN_GOAL = "Erstelle mir bitte einen strukturierten Lernplan, mit dem ich in zwölf Monaten Deutsch von Niveau A1 bis B2 lerne, mit wöchentlichen Zielen, Grammatikthemen, Wortschatz und Übungen, und erkläre alles auf Englisch mit deutschen Beispielsätzen und Übersetzungen.";

const chatRequest = (content: string) => ({ ai: { mode: "balanced" }, conversation: { id: "roadmap", title: "Deutsch A1 bis B2", ancestorContext: [] }, messages: [{ role: "user", content }] });

describe("roadmaps follow the language of the goal", () => {
  test("every chat is told to answer in the user's language, and to keep a mix the user asks for", () => {
    const system = buildSystemInstruction(chatRequest("Hallo"));
    expect(system).toContain("Answer in the language the user writes in, not in English by default");
    expect(system).toContain("mix included");
    expect(buildAgentInstruction(chatRequest("Hallo"), { proposals: true })).toContain("in the language the user's request asks for, or, when it names none, in the language the user wrote it in");
  });

  test("the draft ask quotes the goal and puts its language first, with no English default", () => {
    const prompt = roadmapDraftPrompt(GERMAN_GOAL);
    expect(prompt).toContain(`Draft a learning roadmap for: ${GERMAN_GOAL}`);
    const line = roadmapLanguageLine({ messages: [{ id: "m", role: "user", content: prompt, createdAt: "" }] });
    expect(line).toContain(`“${GERMAN_GOAL}”`);
    expect(line).toContain("in the language that goal asks for, or, if it names none, in the language it is written in, not in English by default");
    expect(line).toContain("explanations in one language with examples and translations in another, follow it exactly");
    // Not in Language mode: a goal to learn a language still gets words, examples with translations and practice.
    expect(line).toContain("If the goal is to learn a language, give every step words and phrases in that language");
    // Link drafts and drafts without Agent mode say the same.
    expect(roadmapDraftPrompt("https://roadmap.sh/ai/roadmap/fastapi-development-s56nq auf Deutsch bitte")).toContain("Language: my goal for this roadmap is");
    expect(roadmapOutlinePrompt(GERMAN_GOAL)).toContain(`“${GERMAN_GOAL}”`);
    expect(roadmapOutlinePrompt(GERMAN_GOAL)).toContain("# <what the roadmap is for, in a few words>");
  });

  test("in Language mode the draft knows the language being learned and the reader's own", () => {
    const note = roadmapLanguageNote("Ich will Deutsch lernen", { target: "de", base: "en" });
    expect(note).toContain("I'm learning German and my own language is English");
    expect(note).toContain("example sentences in German with English translations, and a short practice exercise");
    expect(note).toContain("unless the goal says otherwise");
    expect(roadmapDraftPrompt(GERMAN_GOAL, { pair: { target: "de", base: "en" } })).toContain("I'm learning German");
  });

  test("Explain, lessons and Dive deeper carry the roadmap's language line", () => {
    const roadmap = { messages: [
      { id: "a", role: "user" as const, content: roadmapDraftPrompt(GERMAN_GOAL, { pair: { target: "de", base: "en" } }), createdAt: "" },
      { id: "b", role: "assistant" as const, content: "Fertig.", createdAt: "" },
    ] };
    const line = roadmapLanguageLine(roadmap);
    expect(roadmapExplainPrompt("Der Akkusativ", "Deutsch A1 bis B2", "", { web: true, language: line }).startsWith(`${line}\n\nExplain “Der Akkusativ”`)).toBe(true);
    expect(roadmapDiveDeeperPrompt("Der Akkusativ", "Deutsch A1 bis B2", line).startsWith(line)).toBe(true);
    // A sub-roadmap made by Dive deeper passes the line on again.
    expect(roadmapLanguageLine({ messages: [{ id: "c", role: "user", content: roadmapDiveDeeperPrompt("Der Akkusativ", "Deutsch", line), createdAt: "" }] })).toBe(line);
    // Roadmaps drafted before this change have no line, and their asks are as they were.
    expect(roadmapLanguageLine({ messages: [{ id: "d", role: "user", content: "Draft a learning roadmap for: Kubernetes", createdAt: "" }] })).toBe("");
    expect(roadmapExplainPrompt("Pods", "Kubernetes")).toStartWith("Explain");
  });
});

describe("a German roadmap draft against a stubbed model", () => {
  const originalFetch = globalThis.fetch;
  const sse = (events: unknown[]) => new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "Content-Type": "text/event-stream" } });

  test("the model gets the goal and the language rules, and its German-and-English roadmap comes back as written", async () => {
    const sent: any[] = [];
    const step = (key: string, title: string, notes: string, needs: string[] = []) => ({ key, document_id: "", title, notes, why: "", needs });
    // What a model following the ask writes: German topics, English explanations, German examples with translations.
    const roadmap = { roadmap_id: "", goal: "Deutsch von A1 bis B2 in zwölf Monaten", summary: "Weekly goals, explained in English with German examples.", stages: [
      { title: "A1: Grundlagen (Wochen 1–12)", steps: [
        step("a", "Begrüßungen und sich vorstellen", "- Goal: introduce yourself.\n- *Ich heiße Jon.* = My name is Jon.\n- Practice: write three sentences about yourself."),
        step("b", "Der Akkusativ", "- Why: direct objects change the article.\n- *Ich sehe den Hund.* = I see the dog.", ["a"]) ] },
    ] };
    const written = JSON.stringify(roadmap);
    let calls = 0;
    globalThis.fetch = (async (_url: any, init: any) => {
      calls += 1;
      sent.push(JSON.parse(init.body));
      if (calls > 1) return sse([{ type: "response.completed", response: { status: "completed", output_text: "Hier ist dein Lernplan.", output: [] } }]);
      return sse([{ type: "response.output_item.added", item: { id: "item_1", type: "function_call", name: "propose_roadmap" } },
        { type: "response.function_call_arguments.delta", item_id: "item_1", delta: written },
        { type: "response.completed", response: { status: "completed", output: [{ id: "item_1", type: "function_call", name: "propose_roadmap", call_id: "call_1", arguments: written }] } }]);
    }) as typeof fetch;
    try {
      const { runAgent } = await import("../server/chat/agent/runner.mjs");
      const request = chatRequest(roadmapDraftPrompt(GERMAN_GOAL, { pair: { target: "de", base: "en" } }));
      const result = await runAgent({ provider: "meta", apiKey: "meta", model: "muse-wonder-1.0", systemInstruction: buildAgentInstruction(request, { proposals: true }),
        maxOutputTokens: 500, usageMeter: null, proposals: true, chatRequest: request });
      const first = JSON.stringify(sent[0]);
      expect(first).toContain(JSON.stringify(GERMAN_GOAL).slice(1, -1));
      expect(first).toContain("not in English by default");
      expect(first).toContain("I'm learning German and my own language is English");
      const [proposal] = result.agent.proposals;
      expect(proposal.goal).toBe("Deutsch von A1 bis B2 in zwölf Monaten");
      expect(proposal.stages[0].title).toBe("A1: Grundlagen (Wochen 1–12)");
      expect(proposal.stages[0].steps.map((item: any) => item.title)).toEqual(["Begrüßungen und sich vorstellen", "Der Akkusativ"]);
      expect(proposal.stages[0].steps[1].notes).toContain("*Ich sehe den Hund.* = I see the dog.");
      expect(result.reply).toBe("Hier ist dein Lernplan.");
    } finally { globalThis.fetch = originalFetch; }
  });
});
