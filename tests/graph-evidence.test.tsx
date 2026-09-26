import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { GraphEvidenceView } from "../client/src/components/GraphEvidenceView";
import { normalizeGraphConcepts, readGraphConcepts, resolveGraphEvidence, writeGraphConcepts, type GraphConcept } from "../client/src/lib/graphExploration";
import { createMainConversation } from "../client/src/initialState";

const document = createMainConversation({ id: "source", createdAt: "2026-09-01T00:00:00.000Z" });
document.title = "Experiment results";
document.messages = [{ id: "message", role: "assistant", content: "A measured result.", createdAt: document.createdAt }];
const claim: GraphConcept = { id: "claim", label: "The intervention helps", description: "A claim to examine", kind: "claim", members: [
  { conversationId: "source", sourceKind: "message", messageId: "message", quote: "measured result", startOffset: 2, endOffset: 17, relation: "supports" },
] };

describe("curated graph evidence", () => {
  test("preserves claim types and explicit roles through account-scoped storage", () => {
    const values = new Map<string, string>();
    const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
    const concepts: GraphConcept[] = [claim, { ...claim, id: "concept", kind: "concept", members: [
      { ...claim.members[0], relation: "challenges" }, { conversationId: "source", sourceKind: "conversation", relation: "question" },
    ] }];
    expect(writeGraphConcepts("account", concepts, storage)).toBe(true);
    expect(readGraphConcepts("account", storage)).toEqual(concepts);
    expect(readGraphConcepts("other-account", storage)).toEqual([]);
  });
  test("older memberships remain unchanged; unsupported roles are never guessed", () => {
    const legacy: GraphConcept = { id: "legacy", label: "Topic", description: "", members: [{ conversationId: "source", sourceKind: "conversation" }] };
    expect(normalizeGraphConcepts([legacy])).toEqual([legacy]);
    const normalized = normalizeGraphConcepts([{ ...claim, kind: "inferred-truth", members: [{ ...claim.members[0], relation: "probably-supports" }] }]);
    expect(normalized[0].kind).toBeUndefined();
    expect(normalized[0].members[0].relation).toBeUndefined();
    expect(normalized[0].members[0].quote).toBe("measured result");
  });
  test("roles survive source edits without turning changed or missing text into evidence", () => {
    expect(resolveGraphEvidence({ source: document }, claim.members[0]).status).toBe("exact");
    const changed = { ...document, messages: [{ ...document.messages[0], content: "The result has been withdrawn." }] };
    expect(resolveGraphEvidence({ source: changed }, claim.members[0])).toMatchObject({ status: "stale", highlight: null });
    expect(resolveGraphEvidence({}, claim.members[0])).toMatchObject({ status: "missing", highlight: null });
    expect(normalizeGraphConcepts([claim])[0].members[0].relation).toBe("supports");
  });
  test("renders transparent source labels and manual roles with stale and missing references", () => {
    const concepts = [{ ...claim, members: [claim.members[0], { ...claim.members[0], quote: "old text", startOffset: 0, endOffset: 8, relation: "challenges" as const },
      { conversationId: "gone", sourceKind: "conversation" as const, relation: "question" as const },
      { conversationId: "source", sourceKind: "conversation" as const }] }];
    const html = renderToStaticMarkup(<GraphEvidenceView concepts={concepts} conversations={{ source: document }} selectedConceptId="claim" selectedConversationId="source"
      onSelectConcept={() => {}} onSaveConcepts={() => {}} onOpenEvidence={() => {}} />);
    expect(html).toContain("Exact passage");
    expect(html).toContain("Passage changed · verify this reference");
    expect(html).toContain("Source unavailable");
    expect(html).toContain("Whole document · no passage anchor");
    expect(html).toContain("Roles reflect your assessment");
    expect(html).toContain('data-evidence-role="supports"');
    expect(html).toContain("saved on this device");
  });
});

test("evidence view creates claims and attaches exact user-selected passages", async () => {
  const child = Bun.spawn([process.execPath, "tests/helpers/graphEvidenceHarness.tsx"], { cwd: new URL("..", import.meta.url).pathname, stdout: "pipe", stderr: "pipe" });
  const timeout = setTimeout(() => child.kill(), 10000);
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  clearTimeout(timeout);
  if (exitCode !== 0) throw new Error(`Evidence view interaction check failed:\n${stdout}\n${stderr}`);
  expect(stdout).toContain("Evidence creation, exact passage selection, role changes, source navigation, overlap, and removal passed.");
}, 15000);
