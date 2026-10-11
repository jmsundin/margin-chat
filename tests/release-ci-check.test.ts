import { describe, expect, test } from "bun:test";
import { ciResultForCommit } from "../scripts/release/ci-check.mjs";

const sha = "a".repeat(40);
const base = { sha, repository: "owner/repo", token: "token" };

function github(pages: any[][]) {
  const requests: string[] = [];
  const fetchImpl = async (url: string) => {
    requests.push(url);
    return Response.json({ workflow_runs: pages[Math.min(requests.length - 1, pages.length - 1)] });
  };
  return { fetchImpl, requests };
}

describe("release reuses CI for the release commit", () => {
  test("accepts a passed CI run on the exact commit", async () => {
    const api = github([[{ id: 7, head_sha: sha, status: "completed", conclusion: "success", html_url: "https://ci" }]]);
    expect(await ciResultForCommit({ ...base, fetchImpl: api.fetchImpl })).toEqual({ workflow: "ci.yml", runId: 7, url: "https://ci" });
    expect(api.requests[0]).toContain(`/repos/owner/repo/actions/workflows/ci.yml/runs?head_sha=${sha}`);
  });

  test("waits while CI is still running, then uses its result", async () => {
    const api = github([[{ id: 8, head_sha: sha, status: "in_progress" }], [{ id: 8, head_sha: sha, status: "completed", conclusion: "success" }]]);
    const waits: number[] = [];
    const progress: string[] = [];
    const result = await ciResultForCommit({ ...base, fetchImpl: api.fetchImpl, sleep: async (ms: number) => { waits.push(ms); }, onProgress: (line: string) => progress.push(line) });
    expect(result?.runId).toBe(8);
    expect(waits).toEqual([15_000]);
    expect(progress).toEqual(["validate: waiting for CI to finish on this commit"]);
  });

  test("stops the release when CI failed on the commit", async () => {
    const api = github([[{ id: 9, head_sha: sha, status: "completed", conclusion: "failure" }]]);
    await expect(ciResultForCommit({ ...base, fetchImpl: api.fetchImpl })).rejects.toThrow("CI failed on this commit");
  });

  test("falls back to local validation when nothing vouches for the commit", async () => {
    expect(await ciResultForCommit({ ...base, fetchImpl: github([[]]).fetchImpl })).toBeNull();
    expect(await ciResultForCommit({ ...base, fetchImpl: github([[{ head_sha: sha, status: "completed", conclusion: "cancelled" }]]).fetchImpl })).toBeNull();
    expect(await ciResultForCommit({ ...base, fetchImpl: github([[{ head_sha: "b".repeat(40), status: "completed", conclusion: "success" }]]).fetchImpl })).toBeNull();
    expect(await ciResultForCommit({ ...base, fetchImpl: async () => new Response("no", { status: 403 }) })).toBeNull();
    expect(await ciResultForCommit({ ...base, token: undefined, fetchImpl: async () => { throw new Error("not called"); } })).toBeNull();
  });

  test("gives up waiting after the time limit", async () => {
    let clock = 0;
    const api = github([[{ head_sha: sha, status: "queued" }]]);
    await expect(ciResultForCommit({ ...base, fetchImpl: api.fetchImpl, now: () => clock, sleep: async (ms: number) => { clock += ms; }, timeoutMs: 30_000 }))
      .rejects.toThrow("still running");
  });

  test("in the background, returns at once while CI runs and settles when it finishes", async () => {
    const api = github([[{ id: 8, head_sha: sha, status: "in_progress" }], [{ id: 8, head_sha: sha, status: "in_progress" }], [{ id: 8, head_sha: sha, status: "completed", conclusion: "success" }]]);
    const progress: string[] = [];
    let release = () => {};
    const gate = new Promise<void>((done) => { release = done; });
    const result: any = await ciResultForCommit({ ...base, fetchImpl: api.fetchImpl, background: true, sleep: () => gate, onProgress: (line: string) => progress.push(line) });
    expect(api.requests).toHaveLength(1);
    release();
    expect((await result.pending).runId).toBe(8);
    expect(progress.at(-1)).toBe("CI passed on this commit (run 8)");
  });

  test("in the background, a failed run rejects the pending result and a cancelled one leaves it to local validation", async () => {
    const failed: any = await ciResultForCommit({ ...base, background: true, sleep: async () => {},
      fetchImpl: github([[{ head_sha: sha, status: "queued" }], [{ head_sha: sha, status: "completed", conclusion: "failure" }]]).fetchImpl });
    await expect(failed.pending).rejects.toThrow("CI failed on this commit");
    const cancelled: any = await ciResultForCommit({ ...base, background: true, sleep: async () => {},
      fetchImpl: github([[{ head_sha: sha, status: "queued" }], [{ head_sha: sha, status: "completed", conclusion: "cancelled" }]]).fetchImpl });
    expect(await cancelled.pending).toBeNull();
  });
});
