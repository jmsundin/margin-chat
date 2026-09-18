export const RELEASE_STEPS = [
  "validate", "lock", "checkpoint", "rehearse", "migrate", "stage", "jobs", "verifyCandidate", "promote", "verifyProduction",
];
export const VERCEL_SYNC_STEPS = RELEASE_STEPS.flatMap((name) => name === "stage" ? ["configure", name] : [name]);

/** Effects are explicit and injectable so failure ordering is testable without cloud access. */
export async function executeRelease({ effects, onEvent = () => {}, automaticAppRollback = false, postDeploy = false }) {
  const report = { status: "running", steps: [], startedAt: new Date().toISOString() };
  let locked = false;
  let promotionAttempted = false;
  try {
    for (const name of postDeploy ? VERCEL_SYNC_STEPS : RELEASE_STEPS) {
      const step = { name, status: "running", startedAt: new Date().toISOString() };
      report.steps.push(step);
      await onEvent(report);
      if (name === "promote") promotionAttempted = true;
      const result = await effects[name]();
      if (name === "lock") locked = true;
      step.status = "complete";
      step.completedAt = new Date().toISOString();
      if (result !== undefined) step.result = result;
      await onEvent(report);
    }
    report.status = "complete";
  } catch (error) {
    report.status = "failed";
    const step = report.steps.at(-1);
    if (step) step.status = "failed";
    report.error = effects.describeError?.(error) ?? error.message;
    // A timed-out promotion may already have changed routing. The adapter must
    // inspect current routing before deciding whether rollback is applicable.
    if (promotionAttempted && automaticAppRollback) {
      try { report.rollback = await effects.rollback(); }
      catch (rollbackError) { report.rollback = { status: "failed", error: effects.describeError?.(rollbackError) ?? rollbackError.message }; }
    }
  } finally {
    if (locked) {
      try { await effects.unlock(); }
      catch (error) { report.status = "failed"; report.unlockError = effects.describeError?.(error) ?? error.message; }
    }
    report.completedAt = new Date().toISOString();
    await onEvent(report);
  }
  return report;
}
