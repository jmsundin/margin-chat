import { describe, expect, test } from "bun:test";
import { keepLockSessionActive, LOCK_HEARTBEAT_MS } from "../scripts/release/lock-session.mjs";

function harness() {
  const queries: string[] = [];
  const pending: Array<{ resolve: () => void; reject: (error: Error) => void }> = [];
  const client = { query: (sql: string) => {
    queries.push(sql);
    return new Promise<void>((resolve, reject) => pending.push({ resolve, reject }));
  } };
  let tick: (() => void) | undefined;
  let scheduledMs: number | undefined;
  let cancelled = false;
  const stop = keepLockSessionActive(client, {
    schedule: (callback: () => void, ms: number) => { tick = callback; scheduledMs = ms; return { unref() {} }; },
    cancel: () => { cancelled = true; },
  });
  return { queries, pending, tick: () => tick?.(), scheduledMs, stop, cancelled: () => cancelled };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("release lock session heartbeat", () => {
  test("queries the lock session well inside Neon's five-minute scale-to-zero window", () => {
    const run = harness();
    expect(run.scheduledMs).toBe(LOCK_HEARTBEAT_MS);
    expect(LOCK_HEARTBEAT_MS).toBeLessThan(5 * 60_000);
    run.tick();
    expect(run.queries).toEqual(["select 1"]);
  });

  test("does not queue another query while one is still running", async () => {
    const run = harness();
    run.tick();
    run.tick();
    expect(run.queries).toHaveLength(1);
    run.pending[0].resolve();
    await settle();
    run.tick();
    expect(run.queries).toHaveLength(2);
  });

  test("a failed heartbeat neither throws nor stops later heartbeats", async () => {
    const run = harness();
    run.tick();
    run.pending[0].reject(new Error("Connection terminated unexpectedly"));
    await settle();
    run.tick();
    expect(run.queries).toHaveLength(2);
  });

  test("stopping cancels the timer", () => {
    const run = harness();
    run.stop();
    expect(run.cancelled()).toBe(true);
  });
});
