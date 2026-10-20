import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { normalizeAIExecution } from "@margin-chat/workspace-contracts";
import { readChatReplyStream, type AgentEvent } from "../client/src/lib/chatStream";
import AgentRunLog from "../client/src/components/AgentRunLog";
import AIResponseDetails from "../client/src/components/AIResponseDetails";

const lines = (events: Record<string, unknown>[]) => new Response(events.map((event) => JSON.stringify(event)).join("\n")).body!;
const metadata = { model: "m", requestedServiceId: "openai-api", resolvedServiceId: "openai-api" };

describe("agent thinking in Ask AI", () => {
  test("the stream hands over steps, thinking and activity in the order they arrive", async () => {
    const seen: AgentEvent[] = [];
    await readChatReplyStream(lines([
      { type: "metadata", metadata },
      { type: "thinking", delta: "Look in " }, { type: "thinking", delta: "the notes." },
      { type: "thinking", delta: 7 }, { type: "activity", activity: "dancing" },
      { type: "step", step: { kind: "thinking", label: "Look in the notes." }, spentMicros: 120 },
      { type: "activity", activity: "tool", label: "Reading a document" },
      { type: "activity", activity: "writing" },
      { type: "delta", delta: "Answer." }, { type: "done" },
    ]), undefined, undefined, (event) => seen.push(event));
    expect(seen).toEqual([
      { type: "thinking", delta: "Look in " }, { type: "thinking", delta: "the notes." },
      { type: "step", step: { kind: "thinking", label: "Look in the notes.", ok: true }, spentMicros: 120 },
      { type: "activity", activity: "tool", label: "Reading a document" },
      { type: "activity", activity: "writing" },
    ]);
  });

  test("live, the current thinking shows under what the agent is doing, without being read aloud piece by piece", () => {
    const html = renderToStaticMarkup(<AgentRunLog live activity="thinking" thinking={"**Checking notes**\n\nThe user asks <b>about</b> pricing."}
      steps={[{ kind: "tool", tool: "search_vault", label: "Searched your vault for “pricing”", detail: "3 results", ok: true }]}/>);
    expect(html).toContain("Thinking…");
    expect(html).toContain('<div class="agent-run-thinking is-live" aria-live="off"><p><strong>Checking notes</strong></p><p>The user asks &lt;b&gt;about&lt;/b&gt; pricing.</p></div>');
    expect(renderToStaticMarkup(<AgentRunLog live activity="writing" thinking="Done thinking." steps={[]}/>)).toContain("Writing the answer…");
    expect(renderToStaticMarkup(<AgentRunLog live steps={[]}/>)).toContain("Planning…");
    expect(renderToStaticMarkup(<AgentRunLog live activity="tool" label="Searching your vault for “pricing”" since={Date.now() - 12_000} steps={[]}/>))
      .toContain('<span class="agent-run-label">Searching your vault for “pricing”…</span> <small class="agent-run-elapsed">12s</small>');
  });

  test("saved, each call's thinking is a collapsed Thought with a preview, and a run without thinking says so", () => {
    const html = renderToStaticMarkup(<AgentRunLog reasoning="shared" steps={[
      { kind: "thinking", label: "**Plan**\n\nSearch the vault first.", ok: true },
      { kind: "tool", tool: "search_vault", label: "Searched your vault for “pricing”", ok: true },
    ]}/>);
    expect(html).toContain('<details class="agent-run-thought"><summary><span class="agent-run-label">Thought</span><span class="agent-run-thought-preview">Plan Search the vault first.</span></summary>');
    expect(html).not.toContain("share its thinking");
    expect(renderToStaticMarkup(<AgentRunLog reasoning="not-shared" steps={[]}/>))
      .toContain("The model didn&#x27;t share its thinking for this run, so only its steps are shown.");
  });

  test("a reply whose agent only thought still says it needed no tools", () => {
    const execution = normalizeAIExecution({ schemaVersion: 1, model: "claude-opus-5-5", provider: "anthropic-api", reason: "Chosen", sources: [],
      agent: { reasoning: "shared", steps: [{ kind: "thinking", label: "Simple question; answer directly." }], stopReason: "answered" } })!;
    const html = renderToStaticMarkup(<AIResponseDetails execution={execution}/>);
    expect(html).toContain("Agent · 0 steps");
    expect(html).toContain("Simple question; answer directly.");
    expect(html).toContain("The agent answered without needing any tools.");
  });
});
