import { setTimeout as delay } from "node:timers/promises";

const GITHUB_API = "https://api.github.com";

/**
 * Reuses the repository's CI result for the exact release commit instead of
 * re-running the tests and builds. Waits while CI is still running on that
 * commit (a release is often started right after a merge). Returns null when
 * no CI run on the commit can vouch for it (none, cancelled, or no API access),
 * so the caller falls back to validating locally; a failed run stops the release.
 *
 * With `background`, a run still in progress returns `{ pending }` at once: a
 * promise for the passed result that rejects if CI fails, or resolves null if
 * the run stops without a result (e.g. cancelled), so the release can prepare
 * while CI finishes.
 */
export async function ciResultForCommit({ sha, repository, token, workflow = "ci.yml", fetchImpl = fetch, sleep = delay,
  now = Date.now, timeoutMs = 15 * 60_000, pollMs = 15_000, onProgress = () => {}, background = false }) {
  if (!token || !repository || !/^[\w.-]+\/[\w.-]+$/u.test(repository) || !/^[a-f0-9]{40}$/u.test(sha ?? "")) return null;
  const url = `${GITHUB_API}/repos/${repository}/actions/workflows/${encodeURIComponent(workflow)}/runs?${new URLSearchParams({ head_sha: sha, per_page: "20" })}`;
  const deadline = now() + timeoutMs;
  // "running": CI has not finished. "unavailable": the API could not be read.
  // null: no run on the commit can vouch for it.
  async function check() {
    let runs;
    try {
      const response = await fetchImpl(url, { headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
        signal: AbortSignal.timeout(30_000) });
      if (!response.ok) return "unavailable";
      runs = ((await response.json())?.workflow_runs ?? []).filter((run) => run?.head_sha === sha);
    } catch { return "unavailable"; }
    const passed = runs.find((run) => run.status === "completed" && run.conclusion === "success");
    if (passed) return { workflow, runId: passed.id, url: passed.html_url };
    if (runs.some((run) => run.status === "completed" && run.conclusion === "failure")) {
      throw new Error("CI failed on this commit. Fix it and release a commit whose CI passed.");
    }
    return runs.some((run) => run.status !== "completed") ? "running" : null;
  }
  async function wait() {
    for (;;) {
      if (now() >= deadline) throw new Error("CI was still running on this commit after 15 minutes. Start the release again once it finishes.");
      await sleep(pollMs);
      const result = await check();
      // A run seen in progress is worth waiting for through a brief API outage.
      if (result !== "running" && result !== "unavailable") return result;
    }
  }
  const first = await check();
  if (first === "unavailable") return null;
  if (first !== "running") return first;
  if (!background) {
    onProgress("validate: waiting for CI to finish on this commit");
    return wait();
  }
  onProgress("validate: CI is still running on this commit; preparing the release meanwhile, and nothing in production changes until it passes");
  const pending = wait().then((result) => {
    onProgress(result ? `CI passed on this commit (run ${result.runId})` : "CI stopped on this commit without a result; validating locally instead");
    return result;
  });
  pending.catch(() => {}); // Observed later by the release; avoid an unhandled rejection meanwhile.
  return { pending };
}
