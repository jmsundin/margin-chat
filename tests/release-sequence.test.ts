import { describe, expect, test } from "bun:test";
import { executeRelease, RELEASE_STEPS } from "../scripts/release/sequence.mjs";

function scenario({ fail, failRollback = false, failUnlock = false }: { fail?: string; failRollback?: boolean; failUnlock?: boolean } = {}) {
  const calls: string[] = [];
  const events: any[] = [];
  const effects = Object.fromEntries(RELEASE_STEPS.map((name) => [name, async () => {
    calls.push(name);
    if (name === fail) throw new Error(`failure during ${name}`);
    return { receipt: name };
  }]));
  effects.rollback = async () => {
    calls.push("rollback");
    if (failRollback) throw new Error("rollback failed");
    return { status: "complete", persistence: "retained" };
  };
  effects.unlock = async () => {
    calls.push("unlock");
    if (failUnlock) throw new Error("unlock failed");
  };
  return { calls, events, effects,
    onEvent: (report: any) => { events.push(structuredClone(report)); },
  };
}

describe("production release sequencing", () => {
  test("successful release records each stage and releases its lock after production verification", async () => {
    const fixture = scenario();
    const report = await executeRelease(fixture);
    expect(fixture.calls).toEqual([...RELEASE_STEPS, "unlock"]);
    expect(report.status).toBe("complete");
    expect(report.steps.map(({ name, status }: any) => [name, status])).toEqual(RELEASE_STEPS.map((name) => [name, "complete"]));
    expect(fixture.events.at(-1).status).toBe("complete");
    expect(report.steps.find(({ name }: any) => name === "checkpoint").result).toEqual({ receipt: "checkpoint" });
  });

  test("every failed stage blocks later stages and only acquired locks are released", async () => {
    for (const [index, fail] of RELEASE_STEPS.entries()) {
      const fixture = scenario({ fail });
      const report = await executeRelease(fixture);
      const locked = index > RELEASE_STEPS.indexOf("lock");
      expect(fixture.calls).toEqual([...RELEASE_STEPS.slice(0, index + 1), ...(locked ? ["unlock"] : [])]);
      expect(report.status).toBe("failed");
      expect(report.steps.at(-1)).toMatchObject({ name: fail, status: "failed" });
      expect(report.steps).toHaveLength(index + 1);
      expect(fixture.calls.includes("rollback")).toBe(false);
    }
  });

  test("an uncertain promotion triggers routing-aware application rollback before unlocking", async () => {
    const fixture = scenario({ fail: "promote" });
    const report = await executeRelease({ ...fixture, automaticAppRollback: true });
    expect(fixture.calls).toEqual([...RELEASE_STEPS.slice(0, RELEASE_STEPS.indexOf("promote") + 1), "rollback", "unlock"]);
    expect(report.rollback).toEqual({ status: "complete", persistence: "retained" });
    expect(report.status).toBe("failed");
    expect(fixture.calls).not.toContain("verifyProduction");
  });

  test("production verification failure rolls application back but a rehearsal failure cannot", async () => {
    const production = scenario({ fail: "verifyProduction" });
    expect((await executeRelease({ ...production, automaticAppRollback: true })).rollback).toMatchObject({ status: "complete" });
    expect(production.calls.slice(-3)).toEqual(["verifyProduction", "rollback", "unlock"]);
    const rehearsal = scenario({ fail: "rehearse" });
    const report = await executeRelease({ ...rehearsal, automaticAppRollback: true });
    expect(report.rollback).toBeUndefined();
    expect(rehearsal.calls).toEqual(["validate", "lock", "checkpoint", "rehearse", "unlock"]);
  });

  test("rollback failure is retained alongside original failure and still releases the lock", async () => {
    const fixture = scenario({ fail: "promote", failRollback: true });
    const report = await executeRelease({ ...fixture, automaticAppRollback: true });
    expect(report.error).toBe("failure during promote");
    expect(report.rollback).toEqual({ status: "failed", error: "rollback failed" });
    expect(fixture.calls.at(-1)).toBe("unlock");
  });

  test("an unlock failure cannot report release success", async () => {
    const fixture = scenario({ failUnlock: true });
    const report = await executeRelease(fixture);
    expect(report.steps.every(({ status }: any) => status === "complete")).toBe(true);
    expect(report.status).toBe("failed");
    expect(report.unlockError).toBe("unlock failed");
    expect(fixture.events.at(-1).status).toBe("failed");
  });

  test("reporting failure after lock acquisition still releases the lock and blocks data mutation", async () => {
    const fixture = scenario();
    let failed = false;
    const report = await executeRelease({ ...fixture, onEvent: (state: any) => {
      if (!failed && state.steps.at(-1)?.name === "lock" && state.steps.at(-1).status === "complete") {
        failed = true;
        throw new Error("release report could not be saved");
      }
    } });
    expect(report.status).toBe("failed");
    expect(fixture.calls).toEqual(["validate", "lock", "unlock"]);
  });

  test("error formatting applies to both failure and recovery errors", async () => {
    const fixture = scenario({ fail: "promote", failRollback: true, failUnlock: true });
    const effects = { ...fixture.effects, describeError: () => "[redacted]" };
    const report = await executeRelease({ ...fixture, effects, automaticAppRollback: true });
    expect(report.error).toBe("[redacted]");
    expect(report.rollback.error).toBe("[redacted]");
    expect(report.unlockError).toBe("[redacted]");
  });
});
