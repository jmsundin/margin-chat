import { expect, test } from "bun:test";

// The eval harness end to end with the oracle model: line anchors, retrieval,
// hidden documents and the grounding check, against the fixture vault.
test("the Ratchet eval harness passes the example set with the oracle model", async () => {
  const run = Bun.spawn(["bun", "scripts/ratchet-eval.ts", "--set", "tests/fixtures/ratchet/example-set.json"], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(run.stdout).text(), new Response(run.stderr).text(), run.exited]);
  expect(stderr).toBe("");
  const report = JSON.parse(stdout);
  expect(report.scores).toEqual({ extractionRecall: 1, verdictAccuracy: 1, citationGrounding: 1, inventedClaims: 0 });
  expect(report.cases.find((row: { id?: string }) => row.id === "EX-005")).toMatchObject({ got: "insufficient-evidence" });
  expect(code).toBe(0);
}, 30_000);
