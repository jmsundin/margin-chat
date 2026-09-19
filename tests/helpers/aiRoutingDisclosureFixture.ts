import type { AIExecutionRecord } from "../../client/src/types";

type Routing = { method: "jev" | "jev-task" | "rules" | "manual"; selectedModel: string };
export type DisclosureReceipt = AIExecutionRecord & { routing?: Routing };

/** Synthetic receipt only: no provider calls, account state, or private workspace data. */
export function routingReceipt(overrides: Partial<DisclosureReceipt> = {}): DisclosureReceipt {
  return {
    schemaVersion: 1,
    model: "gpt-6-astra",
    provider: "openai-api",
    mode: "balanced",
    task: "coding",
    reason: "This request needs careful code reasoning and enough context to compare the alternatives.",
    profileVersion: "routing-preview-v1",
    routing: { method: "jev", selectedModel: "gpt-6-astra" },
    sources: [{ kind: "note", id: "synthetic-source", title: "Project constraints", excerpt: "Keep the saved workspace portable." }],
    truncated: false,
    fallbacks: [],
    warnings: [],
    durationMs: 1800,
    completedAt: "2026-09-19T12:00:00.000Z",
    status: "complete",
    ...overrides,
  };
}
