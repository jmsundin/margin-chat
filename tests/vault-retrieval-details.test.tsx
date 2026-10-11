import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createMarkdownWorkspace, normalizeAIExecution, parseMarkdownWorkspace, type AIRetrievalRecord } from "@margin-chat/workspace-contracts";
import AIResponseDetails from "../client/src/components/AIResponseDetails";
import { createEmptyState } from "../client/src/initialState";
import { normalizeAppState } from "../server/db/validation.mjs";
import { markCitedPassages } from "../server/chat/index.mjs";
import { routingReceipt } from "./helpers/aiRoutingDisclosureFixture";

const used: AIRetrievalRecord = {
  status: "used", meaning: true, alreadyIncluded: 1,
  passages: [
    { label: "Vault 1", id: "guide", kind: "document", title: "Car guide", heading: "Tyres", matched: "meaning", similarity: 0.61,
      excerpt: "Rotate the tyres every season.", openId: "guide", cited: true },
    { label: "Vault 2", id: "file-1", kind: "file", title: "Manual.pdf", heading: "Page 4", matched: "keyword", excerpt: "Pressure is 2.3 bar.", openId: "chat-9" },
  ],
};

function render(retrieval: AIRetrievalRecord, overrides = {}) {
  const html = renderToStaticMarkup(<AIResponseDetails execution={routingReceipt({ retrieval, ...overrides })} onOpenSource={() => {}}/>).replaceAll("&#x27;", "'");
  const summary = html.match(/<summary\b[^>]*>[\s\S]*?<\/summary>/)?.[0] ?? "";
  return { html, summary, body: html.replace(summary, "") };
}

describe("vault search in a reply's details", () => {
  test("the receipt keeps only well-formed retrieval fields and survives Markdown and SQL validation", () => {
    const execution = normalizeAIExecution(routingReceipt({ retrieval: {
      ...used,
      passages: [...used.passages,
        { id: "bad", kind: "spreadsheet", title: "Dropped", matched: "both" } as any,
        { id: "x", kind: "note", title: "Long", matched: "both", similarity: 0.123456, excerpt: "y".repeat(500), cited: "yes" } as any],
      extra: "dropped",
    } as any }))!;
    expect(execution.retrieval?.passages.map((passage) => passage.id)).toEqual(["guide", "file-1", "x"]);
    expect(execution.retrieval?.passages[2]).toEqual({ id: "x", kind: "note", title: "Long", matched: "both", similarity: 0.12, excerpt: "y".repeat(240) });
    expect(execution.retrieval).not.toHaveProperty("extra");
    expect(normalizeAIExecution(routingReceipt({ retrieval: { status: "maybe", passages: [] } as any }))).not.toHaveProperty("retrieval");

    const state = createEmptyState();
    const conversation = state.conversations[state.rootId];
    conversation.messages = [{ id: "answer", role: "assistant", content: "Answer.", createdAt: conversation.createdAt, execution }];
    const markdown = createMarkdownWorkspace(state);
    const parsed = parseMarkdownWorkspace(markdown.manifest, markdown.files)!;
    expect(parsed.conversations[conversation.id].messages[0].execution).toEqual(execution);
    expect(normalizeAppState(parsed).conversations.find((item: any) => item.id === conversation.id).messages[0].execution).toEqual(execution);
  });

  test("marks the passages a reply cites as [Vault N]", () => {
    const retrieval = { ...used, passages: [...used.passages, { ...used.passages[1], label: "Vault 3", id: "c", cited: undefined }].map(({ cited, ...passage }) => passage) };
    const cited = (reply: string) => markCitedPassages(retrieval, reply)!.passages.filter((passage: any) => passage.cited).map((passage: any) => passage.label);
    expect(cited("Every season [Vault 1].")).toEqual(["Vault 1"]);
    expect(cited("See [Vault 1, 3] and [vault 2].")).toEqual(["Vault 1", "Vault 2", "Vault 3"]);
    expect(cited("Nothing cited [1] or [Source 2].")).toEqual([]);
  });

  test("shows what the search found, how it matched and what the answer cited", () => {
    const { summary, body } = render(used, { sources: [
      { kind: "note", id: "picked", title: "Picked note" },
      { kind: "conversation", id: "guide", title: "Car guide", excerpt: "Rotate the tyres every season." },
    ] });
    expect(summary).toContain("Vault · 2 passages · 1 cited");
    expect(body).toContain("Vault search");
    expect(body).toContain("Found 2 passages in your vault and gave them to the model.");
    expect(body).toContain("1 was found by meaning only, so searching for the same words would have missed it.");
    expect(body).toContain("The answer cites 1 of them.");
    expect(body).toContain("[Vault 1]");
    expect(body).toMatch(/<button type="button">Car guide<\/button>/);
    expect(body).toContain(" › Tyres");
    expect(body).toContain("Meaning only");
    expect(body).toContain("similarity 0.61");
    expect(body).toContain("Cited in the answer");
    expect(body).toContain("Same words");
    expect(body).toContain("1 more match was already in the request in full.");
    // A vault passage is listed once, under Vault search; what the user picked stays under Context used.
    const context = body.slice(body.indexOf("Context used"));
    expect(context).toContain("Picked note");
    expect(context).not.toContain("Car guide");
  });

  test("while the answer is still being written, says nothing about citations", () => {
    expect(render(used, { status: "streaming" }).body).not.toContain("The answer cites");
    expect(render({ ...used, passages: used.passages.map(({ cited, ...passage }) => passage) }).body).toContain("The answer doesn't cite any of them.");
  });

  test("explains a reply that didn't search the vault, or found nothing", () => {
    const skipped = render({ status: "not-searched", meaning: false, passages: [], note: "Your vault wasn't searched for this reply." });
    expect(skipped.summary).not.toContain("Vault ·");
    expect(skipped.body).toContain("Your vault wasn't searched for this reply.");
    const empty = render({ status: "none-found", meaning: true, passages: [] });
    expect(empty.summary).toContain("Vault · no close matches");
    expect(empty.body).toContain("Your vault was searched, but nothing matched closely enough to include.");
  });

  test("Agent mode lists its searches and the documents they found", () => {
    const { summary, body } = render({ status: "used", agent: true, meaning: true, queries: ["tyre rotation", "tyre pressure"],
      passages: used.passages.map(({ label, cited, ...passage }) => passage) });
    expect(summary).toContain("Vault · 2 documents");
    expect(body).toContain("The agent searched your vault 2 times and found 2 relevant documents.");
    expect(body).toContain("Searched for “tyre rotation”, “tyre pressure”");
    expect(body).not.toContain("The answer cites");
  });
});
