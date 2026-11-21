import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import AgentInbox from "../client/src/components/AgentInbox";
import { createEmptyState } from "../client/src/initialState";
import { collectAgentInbox } from "../client/src/lib/agentInbox";
import type { Conversation } from "../client/src/types";

const NOW = Date.parse("2026-11-19T12:00:00Z");
const execution = (agent: Record<string, unknown>) => ({ schemaVersion: 1, model: "muse-wonder-1.0", provider: "meta-api", mode: "balanced", task: "research",
  reason: "", profileVersion: "1", sources: [], truncated: false, agent: { steps: [{ kind: "tool", label: "Searched", ok: true }], ...agent } });

function vault(messagesByDoc: Record<string, unknown[]>): Record<string, Conversation> {
  const base = createEmptyState();
  const root = base.conversations[base.rootId];
  return Object.fromEntries(Object.entries(messagesByDoc).map(([id, messages]) => [id, { ...root, id, title: `Doc ${id}`, messages } as Conversation]));
}
const user = (id: string, at: string) => ({ id, role: "user", content: "go", createdAt: at });
const reply = (id: string, at: string, agent: Record<string, unknown>) => ({ id, role: "assistant", content: "…", createdAt: at, execution: execution(agent) });

describe("agent inbox", () => {
  test("lists an open question, undecided drafts and a run that stopped early, newest first", () => {
    const items = collectAgentInbox(vault({
      a: [user("u1", "2026-11-18T10:00:00Z"), reply("m1", "2026-11-18T10:01:00Z", { stopReason: "question", question: { text: "Which year?", options: ["2025", "2026"] } })],
      b: [user("u2", "2026-11-19T09:00:00Z"), reply("m2", "2026-11-19T09:01:00Z", { stopReason: "answered", spentMicros: 120_000, budgetMicros: 500_000, proposals: [
        { id: "p1", kind: "edit", summary: "Fix the date", documentId: "b", documentTitle: "Doc b", find: "x", replace: "y" },
        { id: "p2", kind: "edit", summary: "Done already", documentId: "b", documentTitle: "Doc b", find: "x", replace: "y", status: "approved" }] })],
      c: [user("u3", "2026-11-17T09:00:00Z"), reply("m3", "2026-11-17T09:05:00Z", { stopReason: "budget" })],
    }), new Set(), NOW);
    expect(items.map((item) => `${item.kind}:${item.conversationId}`)).toEqual(["proposal:b", "question:a", "stopped:c"]);
    expect(items[0].receipt).toMatchObject({ model: "muse-wonder-1.0", steps: 1, spentMicros: 120_000, budgetMicros: 500_000 });
  });

  test("a question that was answered and a stopped run that was continued are no longer waiting", () => {
    const items = collectAgentInbox(vault({
      a: [reply("m1", "2026-11-18T10:01:00Z", { stopReason: "question", question: { text: "Which year?", options: [] } }), user("u1", "2026-11-18T10:02:00Z")],
      c: [reply("m3", "2026-11-17T09:05:00Z", { stopReason: "time-limit" }), user("u2", "2026-11-17T09:06:00Z"), reply("m4", "2026-11-17T09:07:00Z", { stopReason: "answered" })],
    }), new Set(), NOW);
    expect(items).toEqual([]);
  });

  test("a stopped run can be cleared and ages out after a week; a draft stays until decided", () => {
    const docs = vault({
      c: [reply("m3", "2026-11-18T09:05:00Z", { stopReason: "round-limit" })],
      old: [reply("m5", "2026-11-01T09:05:00Z", { stopReason: "budget", proposals: [{ id: "p", kind: "create", summary: "", parentId: "old", parentTitle: "Doc old", title: "Notes", content: "" }] })],
    });
    expect(collectAgentInbox(docs, new Set(), NOW).map((item) => item.id)).toEqual(["m3:stopped", "m5:p"]);
    expect(collectAgentInbox(docs, new Set(["m3:stopped"]), NOW).map((item) => item.id)).toEqual(["m5:p"]);
  });

  test("the dialog says so in words when nothing is waiting, and shows a receipt when something is", () => {
    const noop = () => {};
    const empty = renderToStaticMarkup(<AgentInbox items={[]} onOpen={noop} onProposal={() => null} onClear={noop} onClose={noop} />);
    expect(empty).toContain("Nothing is waiting for you.");
    const items = collectAgentInbox(vault({ b: [reply("m2", "2026-11-19T09:01:00Z", { stopReason: "answered", spentMicros: 120_000, budgetMicros: 500_000,
      proposals: [{ id: "p1", kind: "edit", summary: "Fix the date", documentId: "b", documentTitle: "Doc b", find: "x", replace: "y" }] })] }), new Set(), NOW);
    const html = renderToStaticMarkup(<AgentInbox items={items} onOpen={noop} onProposal={() => null} onClear={noop} onClose={noop} />);
    expect(html).toContain("1 waiting for you");
    expect(html).toContain("Edit “Doc b”");
    expect(html).toContain("muse-wonder-1.0 · 1 step · $0.12 of $0.50");
    expect(html).toContain(">Approve<");
  });
});
