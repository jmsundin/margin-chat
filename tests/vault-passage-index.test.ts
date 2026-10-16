import { describe, expect, test } from "bun:test";
import { AFTER_UPLOAD_MAX_MS, AFTER_UPLOAD_MS, scheduleVaultIndexing, type IndexClock } from "../client/src/lib/useVaultPassageIndex";

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Timers that only move when the test says so. */
function testClock() {
  let now = 0;
  let nextId = 1;
  const timers = new Map<number, { at: number; run: () => void }>();
  const clock: IndexClock = {
    now: () => now,
    setTimeout(run, ms) { const id = nextId++; timers.set(id, { at: now + ms, run }); return id; },
    clearTimeout(id) { timers.delete(id as number); },
  };
  return {
    clock,
    /** How long until the next run is due. */
    nextIn: () => Math.min(...[...timers.values()].map((timer) => timer.at - now)),
    async advance(ms: number) {
      const until = now + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].run();
        await settle();
      }
      now = until;
    },
  };
}

describe("indexing the vault for search", () => {
  test("runs at once, then every five minutes while nothing is uploaded", async () => {
    const time = testClock();
    let runs = 0;
    const schedule = scheduleVaultIndexing(async () => { runs++; }, time.clock);
    await settle();
    expect(runs).toBe(1);
    expect(time.nextIn()).toBe(5 * 60_000);
    await time.advance(5 * 60_000);
    expect(runs).toBe(2);
    schedule.stop();
  });

  test("runs shortly after an upload, once for a burst of uploads", async () => {
    const time = testClock();
    let runs = 0;
    const schedule = scheduleVaultIndexing(async () => { runs++; }, time.clock);
    await settle();
    await time.advance(60_000);
    schedule.uploaded();
    expect(time.nextIn()).toBe(AFTER_UPLOAD_MS);
    // Two more uploads while it waits push the run back, so the three make one run.
    await time.advance(5_000);
    schedule.uploaded();
    await time.advance(5_000);
    schedule.uploaded();
    await time.advance(AFTER_UPLOAD_MS - 1);
    expect(runs).toBe(1);
    await time.advance(1);
    expect(runs).toBe(2);
    expect(time.nextIn()).toBe(5 * 60_000);
    schedule.stop();
  });

  test("uploads that keep coming are still indexed within two minutes of the first", async () => {
    const time = testClock();
    let runs = 0;
    const schedule = scheduleVaultIndexing(async () => { runs++; }, time.clock);
    await settle();
    let waited = 0;
    while (runs === 1) {
      schedule.uploaded();
      await time.advance(5_000);
      waited += 5_000;
    }
    expect(waited).toBeLessThanOrEqual(AFTER_UPLOAD_MAX_MS + 5_000);
    expect(waited).toBeGreaterThanOrEqual(AFTER_UPLOAD_MAX_MS);
    schedule.stop();
  });

  test("an upload during a run is indexed shortly after it, and nothing runs once stopped", async () => {
    const time = testClock();
    let runs = 0;
    let finish: () => void = () => undefined;
    const schedule = scheduleVaultIndexing(() => { runs++; return new Promise<void>((resolve) => { finish = resolve; }); }, time.clock);
    await settle();
    schedule.uploaded();
    finish();
    await settle();
    expect(time.nextIn()).toBe(AFTER_UPLOAD_MS);
    await time.advance(AFTER_UPLOAD_MS);
    expect(runs).toBe(2);
    finish();
    await settle();
    schedule.stop();
    schedule.uploaded();
    await time.advance(10 * 60_000);
    expect(runs).toBe(2);
  });
});
