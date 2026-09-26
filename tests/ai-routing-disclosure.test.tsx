import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createMarkdownWorkspace, normalizeAIExecution, parseMarkdownWorkspace } from "@margin-chat/workspace-contracts";
import AIResponseDetails from "../client/src/components/AIResponseDetails";
import { createEmptyState } from "../client/src/initialState";
import { routingReceipt } from "./helpers/aiRoutingDisclosureFixture";

/** Native closed details exposes only its summary; keep that trigger and remove the expanded-only body. */
function renderedDisclosure(execution = routingReceipt(), isStreaming = false) {
  const html = renderToStaticMarkup(<AIResponseDetails execution={execution} isStreaming={isStreaming} />);
  const details = html.match(/<details\b[^>]*>[\s\S]*?<\/details>/g) ?? [];
  const summaryPattern = /<summary\b[^>]*>[\s\S]*?<\/summary>/;
  const visible = details.reduce((markup, block) => markup.replace(block, block.match(summaryPattern)?.[0] ?? ""), html);
  const expandedOnly = details.map((block) => block.replace(summaryPattern, "")).join("");
  return { html, details, visible, expandedOnly };
}

describe("discreet model selection disclosure", () => {
  test("shows the model and a clear reason trigger while keeping explanations and context collapsed", () => {
    const receipt = routingReceipt();
    const { html, visible, details, expandedOnly } = renderedDisclosure(receipt);
    expect(html).toMatch(/<section\b[^>]*class="ai-response-details"[^>]*aria-label="Model selection"/);
    expect(html).not.toContain('class="ai-routing-summary"');
    expect(visible).toContain('class="ai-routing-model"');
    expect(visible).toContain('class="ai-routing-trigger"');
    for (const label of ["GPT-6 Astra", "OpenAI", "Why this model?"]) {
      expect(visible).toContain(label);
    }
    for (const text of ["Auto · selected by Jev", receipt.reason, "Project constraints", "Keep the saved workspace portable."]) {
      expect(visible).not.toContain(text);
      expect(expandedOnly).toContain(text);
    }
    expect(details).toHaveLength(1);
    expect(details[0]).toContain('class="ai-response-more"');
    expect(details[0]).not.toMatch(/<details\b[^>]*\sopen(?:[\s=>])/);
    expect(expandedOnly).toContain('class="ai-response-body"');
  });

  test.each([
    ["astra", "Auto · selected by GPT-6 Astra (low reasoning)"],
    ["astra-task", "Auto · GPT-6 Astra task matching"],
    ["jev-task", "Auto · Jev task matching"],
    ["rules", "Auto · standard routing"],
    ["manual", "Selected by you"],
  ] as const)("distinguishes %s routing without claiming Jev selected every answer", (method, label) => {
    const { visible, expandedOnly } = renderedDisclosure(routingReceipt({ routing: { method, selectedModel: "gpt-6-astra" } }));
    expect(visible).not.toContain(label);
    expect(expandedOnly).toContain(label);
    expect(expandedOnly).not.toContain("Auto · selected by Jev");
    if (method === "manual") expect(expandedOnly).not.toContain("Auto ·");
  });

  test("legacy receipts use a neutral label rather than inferring a selection method", () => {
    const { visible, expandedOnly } = renderedDisclosure(routingReceipt({ routing: undefined, profileVersion: "semantic-jev-legacy" }));
    expect(expandedOnly).toContain("Selection details");
    expect(visible).toContain("Why this model?");
    expect(visible).not.toContain("Selection details");
    expect(visible).not.toContain("Auto ·");
    expect(expandedOnly).not.toContain("Auto ·");
    expect(expandedOnly).not.toContain("Selected by you");
  });

  test("makes a fallback visible while preserving failed attempts in the expanded details", () => {
    const { visible, expandedOnly } = renderedDisclosure(routingReceipt({
      model: "gemini-3.8-flash", provider: "gemini-api",
      routing: { method: "rules", selectedModel: "gemini-3.8-flash" },
      reason: "The next available model can answer this request.",
      fallbacks: [{ provider: "openai-api", model: "gpt-6-astra", reason: "Provider temporarily unavailable" }],
    }));
    expect(visible).toContain("Gemini 3.8 Flash");
    expect(visible).toContain("Google Gemini");
    expect(visible).toContain("Fallback used");
    expect(visible).not.toContain("The next available model can answer this request.");
    expect(visible).not.toContain("Provider temporarily unavailable");
    expect(expandedOnly).toContain("The next available model can answer this request.");
    expect(expandedOnly).toContain("gpt-6-astra");
    expect(expandedOnly).toContain("Provider temporarily unavailable");
  });

  test("distinguishes the actual provider-resolved ID from the originally requested alias", () => {
    const { html, visible, details } = renderedDisclosure(routingReceipt({
      model: "gpt-6-astra-2026-09-01",
      routing: { method: "jev", selectedModel: "gpt-6-astra" },
    }));
    expect(visible).toContain("gpt-6-astra-2026-09-01");
    expect(visible).toContain("OpenAI");
    expect(html).toContain("gpt-6-astra-2026-09-01");
    expect(details[0]).toContain("Requested model ID");
    expect(details[0]).toContain(">gpt-6-astra<");
  });

  test("does not relabel an unknown actual model as the provider's catalog default", () => {
    const { visible } = renderedDisclosure(routingReceipt({
      model: "provider-experimental-model-42", routing: undefined,
    }));
    expect(visible).toContain("provider-experimental-model-42");
    expect(visible).not.toContain("GPT-6 Astra");
  });

  test("distinguishes a live stream from a reopened incomplete answer", () => {
    const receipt = routingReceipt({ status: "streaming", completedAt: undefined });
    const live = renderedDisclosure(receipt, true);
    const reopened = renderedDisclosure(receipt);
    expect(live.visible).toContain("Responding with");
    expect(reopened.visible).toContain("Partial response from");
    expect(reopened.visible).not.toContain("Responding with");
    expect(reopened.html).toContain("Partial answer saved; completion not recorded");
    for (const result of [live, reopened]) {
      expect(result.visible).toContain("Why this model?");
      expect(result.visible).not.toContain("Auto · selected by Jev");
      expect(result.expandedOnly).toContain("Auto · selected by Jev");
    }
  });

  test.each(["stopped", "failed"] as const)("keeps %s answers visibly partial with their routing explanation", (status) => {
    const receipt = routingReceipt({ status });
    const { visible, expandedOnly } = renderedDisclosure(receipt);
    expect(visible).toContain("Partial response from");
    expect(visible).not.toContain("Answered by");
    expect(visible).not.toContain(receipt.reason);
    expect(expandedOnly).toContain(receipt.reason);
  });

  test("an absent explanation is disclosed without inventing a selection rationale", () => {
    const { visible, expandedOnly } = renderedDisclosure(routingReceipt({ reason: "", routing: undefined }));
    expect(visible).toContain("Why this model?");
    expect(visible).not.toContain("No selection reason was recorded for this reply.");
    expect(expandedOnly).toContain("No selection reason was recorded for this reply.");
  });

  test("saved and reopened answers retain their original routing explanation and selected model", () => {
    const state = createEmptyState();
    const chat = state.conversations[state.rootId];
    const receipt = routingReceipt({
      model: "gpt-5.6-luna", task: "general", reason: "A short factual question benefits from a fast response.",
      routing: { method: "jev-task", selectedModel: "gpt-5.6-luna" },
    });
    chat.messages = [{ id: "synthetic-answer", role: "assistant", content: "A saved answer.", createdAt: chat.createdAt, execution: receipt }];
    const markdown = createMarkdownWorkspace(state);
    const reopened = parseMarkdownWorkspace(markdown.manifest, markdown.files)!;
    const saved = normalizeAIExecution(reopened.conversations[chat.id].messages[0].execution)!;
    expect(saved).toEqual(receipt);
    const { visible, expandedOnly } = renderedDisclosure(saved);
    expect(visible).toContain("GPT-5.6 Luna");
    expect(visible).toContain("Why this model?");
    expect(visible).not.toContain("Auto · Jev task matching");
    expect(visible).not.toContain(receipt.reason);
    expect(expandedOnly).toContain("Auto · Jev task matching");
    expect(expandedOnly).toContain(receipt.reason);
    expect(visible).not.toContain("GPT-6 Astra");
  });
});
