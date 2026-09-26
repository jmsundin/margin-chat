import { expect, test } from "bun:test";
import { createVercelApi } from "../scripts/release/vercel-updates.mjs";
import { promoteVerifiedDeployment } from "../scripts/release/promote.mjs";

function fixture({ status = 201, jobStatus = "succeeded", target = "old", candidate = {}, rejectPost = false } = {}) {
  const requests: Array<{ path: string; method: string }> = [];
  let posted = false, polls = 0, clock = 0;
  const api = createVercelApi({ config: { orgId: "team_test" }, token: "secret", fetchImpl: async (url: URL, options: any) => {
    expect(url.searchParams.get("teamId")).toBe("team_test");
    requests.push({ path: url.pathname, method: options.method });
    if (url.pathname === "/v13/deployments/new") return Response.json({ id: "new", projectId: "prj_test",
      target: "production", readyState: "READY", meta: { marginReleaseSha: "sha" }, ...candidate });
    if (options.method === "POST") {
      expect(url.pathname).toBe("/v10/projects/prj_test/promote/new");
      expect(options.body).toBe("{}");
      posted = true;
      return new Response(rejectPost ? "private provider error" : null, { status: rejectPost ? 403 : status });
    }
    expect(url.pathname).toBe("/v9/projects/prj_test");
    if (posted) polls++;
    return Response.json({ id: "prj_test", targets: { production: { id: posted && polls > 1 ? "new" : target } },
      ...(posted ? { lastAliasRequest: polls > 1 && jobStatus === "cleared" ? null : { toDeploymentId: "new", jobStatus: polls > 1 ? jobStatus : "pending" } } : {}) });
  } });
  return { requests, args: { api, projectId: "prj_test", deploymentId: "new", previousDeploymentId: "old", expectedSha: "sha",
    sleep: async (ms: number) => { clock += ms; }, now: () => clock, timeoutMs: 5, pollMs: 1 } };
}

test("project-scoped promotion handles empty accepted responses and waits for alias completion without user access", async () => {
  for (const status of [201, 202]) {
    const f = fixture({ status });
    expect(await promoteVerifiedDeployment(f.args)).toEqual({ deployment: "new" });
    expect(f.requests.filter(r => r.method === "POST")).toHaveLength(1);
    expect(f.requests.some(r => r.path.includes("user") || r.path.includes("teams"))).toBe(false);
  }
});

test("promotion accepts the completed target when Vercel clears its alias-job record", async () => {
  const f = fixture({ jobStatus: "cleared" });
  expect(await promoteVerifiedDeployment(f.args)).toEqual({ deployment: "new" });
});

test("promotion refuses changed production, wrong candidates, or a lost release lock before writing", async () => {
  for (const change of [{ target: "other" }, ...[{ id: "wrong" }, { projectId: "wrong" }, { target: "preview" },
    { readyState: "BUILDING" }, { meta: { marginReleaseSha: "wrong" } }].map(candidate => ({ candidate }))]) {
    const f = fixture(change);
    await expect(promoteVerifiedDeployment(f.args)).rejects.toThrow();
    expect(f.requests.some(r => r.method === "POST")).toBe(false);
  }
  const f = fixture();
  await expect(promoteVerifiedDeployment({ ...f.args, assertLock: async () => { throw new Error("lost lock"); } })).rejects.toThrow("lost lock");
  expect(f.requests.some(r => r.method === "POST")).toBe(false);
});

test("failed or still pending aliases are never treated as successful promotion or automatically retried", async () => {
  for (const jobStatus of ["failed", "skipped", "pending"]) {
    const f = fixture({ jobStatus });
    await expect(promoteVerifiedDeployment(f.args)).rejects.toThrow(jobStatus === "pending" ? "Timed out" : "did not complete");
    expect(f.requests.filter(r => r.method === "POST")).toHaveLength(1);
  }
  const f = fixture({ rejectPost: true });
  await expect(promoteVerifiedDeployment(f.args)).rejects.toThrow("Vercel POST request failed (403)");
  expect(f.requests.filter(r => r.method === "POST")).toHaveLength(1);
});
