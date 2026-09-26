import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";

// Use the project API directly: the CLI also looks up a user profile, which
// project-scoped credentials can lack even when deployment access succeeds.
export async function promoteVerifiedDeployment({ api, projectId, deploymentId, previousDeploymentId, expectedSha,
  assertLock = async () => {}, sleep = delay, now = Date.now, timeoutMs = 180_000, pollMs = 1_000 }) {
  const projectPath = `/v9/projects/${encodeURIComponent(projectId)}`;
  const candidate = await api(`/v13/deployments/${encodeURIComponent(deploymentId)}`);
  assert.equal(candidate.id, deploymentId);
  assert.equal(candidate.projectId, projectId);
  assert.equal(candidate.target, "production");
  assert.equal(candidate.readyState, "READY");
  assert.equal(candidate.meta?.marginReleaseSha, expectedSha);
  await assertLock();
  const project = await api(projectPath);
  assert.equal(project.id, projectId);
  assert.equal(project.targets?.production?.id, previousDeploymentId, "Production changed; promotion stopped.");
  await api(`/v10/projects/${encodeURIComponent(projectId)}/promote/${encodeURIComponent(deploymentId)}`,
    { method: "POST", body: {}, allowEmptyResponse: true });
  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    await assertLock();
    const current = await api(projectPath);
    assert.equal(current.id, projectId);
    const job = current.lastAliasRequest;
    if (job?.toDeploymentId === deploymentId && ["failed", "skipped"].includes(job.jobStatus)) {
      throw new Error("Vercel promotion did not complete; inspect deployment alias status before retrying.");
    }
    if (current.targets?.production?.id === deploymentId &&
        job?.toDeploymentId === deploymentId && job.jobStatus === "succeeded") return { deployment: deploymentId };
    if (![previousDeploymentId, deploymentId].includes(current.targets?.production?.id)) {
      throw new Error("Production changed during promotion; inspect routing before retrying.");
    }
    await sleep(Math.min(pollMs, Math.max(1, deadline - now())));
  }
  throw new Error("Timed out waiting for Vercel promotion; inspect routing before retrying.");
}
