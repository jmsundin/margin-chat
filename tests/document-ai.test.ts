import { expect, test } from "bun:test";
import { createMainConversation } from "../client/src/initialState";
import { buildDiagramAIMessage, buildDocumentAIMessage } from "../client/src/lib/documentAI";
import type { Message } from "../client/src/types";

test("document AI frames the complete current text and selected passage without expanding the saved prompt", () => {
  const conversation = createMainConversation({ id: "framing", createdAt: "2026-09-20T00:00:00.000Z" });
  conversation.title = "Reading plan";
  conversation.messages = [{ id: "old", role: "assistant", content: "Removed historical wording", createdAt: conversation.createdAt }];
  conversation.notes = [{ id: "private", kind: "comment", content: "Private margin annotation", sourceMessageId: "old", startOffset: 0, endOffset: 7, quote: "Removed", createdAt: conversation.createdAt, updatedAt: conversation.createdAt }];
  const beginning = `Beginning of current document\n\n${"A useful paragraph. ".repeat(2000)}`;
  const ending = "The final current paragraph, with a selected phrase.";
  conversation.document = { schemaVersion: 1, prompts: [], generations: [], blocks: [beginning, ending].map((content, index) => ({ id: `part-${index}`, kind: "markdown", content, createdAt: conversation.createdAt, updatedAt: conversation.createdAt })) };
  const prompt: Message = { id: "prompt", role: "user", content: "Make the next action clearer.", createdAt: conversation.createdAt };
  const original = structuredClone(prompt);
  const request = buildDocumentAIMessage(conversation, prompt, "selected phrase");
  const framed = JSON.parse(request.content.split("\n\n")[2]);
  expect(framed).toEqual({ title: "Reading plan", document: `${beginning}\n\n${ending}`, selectedPassage: "selected phrase" });
  expect(request.content.endsWith(prompt.content)).toBe(true);
  expect(request.id).toBe(prompt.id);
  expect(request.content).not.toContain("Removed historical wording");
  expect(request.content).not.toContain("Private margin annotation");
  expect(prompt).toEqual(original);
  expect(conversation.messages).toHaveLength(1);
});

test("a Mermaid diagram the reply replaces asks for the whole updated diagram as one fence", () => {
  const conversation = createMainConversation({ id: "diagram", createdAt: "2026-10-22T00:00:00.000Z" });
  const diagram = "```mermaid\nflowchart TD\n  A --> B\n```";
  conversation.document = { schemaVersion: 1, prompts: [], generations: [], blocks: [{ id: "d", kind: "markdown", content: diagram, createdAt: conversation.createdAt, updatedAt: conversation.createdAt }] };
  const prompt: Message = { id: "prompt", role: "user", content: "Add a step after A.", createdAt: conversation.createdAt };
  const replacing = buildDocumentAIMessage(conversation, prompt, diagram, { replaceSelection: true }).content;
  expect(replacing).toContain("The selected passage is a Mermaid diagram, and your reply replaces it.");
  expect(JSON.parse(replacing.split("\n\n")[2]).selectedPassage).toBe(diagram);
  // Asking about a diagram without replacing it, or replacing ordinary text, keeps the usual framing.
  expect(buildDocumentAIMessage(conversation, prompt, diagram).content).not.toContain("Mermaid");
  expect(buildDocumentAIMessage(conversation, prompt, "plain text", { replaceSelection: true }).content).not.toContain("Mermaid");
});

test("Ask AI in the diagram editor sends the diagram, the selected lines and the document, and asks for one fence back", () => {
  const conversation = createMainConversation({ id: "diagram-dialog", createdAt: "2026-10-22T00:00:00.000Z" });
  conversation.title = "Trip planning";
  conversation.document = { schemaVersion: 1, prompts: [], generations: [], blocks: [{ id: "p", kind: "markdown", content: "Museums close Mondays.", createdAt: conversation.createdAt, updatedAt: conversation.createdAt }] };
  const prompt: Message = { id: "ask", role: "user", content: "Add a Monday check", createdAt: conversation.createdAt };
  const diagram = "flowchart TD\n  A[Pack] --> B{Rain?}\n  B -->|yes| C[Museum]";
  const selected = buildDiagramAIMessage(conversation, prompt, { diagram, selection: "  B -->|yes| C[Museum]\n" });
  const parts = selected.content.split("\n\n");
  expect(parts[0]).toContain("one ```mermaid fenced code block");
  expect(parts[0]).toContain("the request is about those lines");
  expect(JSON.parse(parts[2])).toEqual({ title: "Trip planning", document: "Museums close Mondays.", diagram, selectedLines: "B -->|yes| C[Museum]" });
  expect(selected.content.endsWith("Add a Monday check")).toBe(true);
  const whole = buildDiagramAIMessage(conversation, prompt, { diagram });
  expect(whole.content).not.toContain("selected part");
  expect(JSON.parse(whole.content.split("\n\n")[2])).not.toHaveProperty("selectedLines");
});
