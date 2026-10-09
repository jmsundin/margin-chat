import { expect, test } from "bun:test";
import { newerRelease, watchForUpdates } from "../desktop/updates.mjs";

const version = (letter: string, committedAt: string | null) => ({ commit: letter.repeat(40), committedAt });
const own = version("a", "2026-10-01T10:00:00Z");

test("only a strictly newer production release is offered", () => {
  expect(newerRelease(own, version("b", "2026-10-05T10:00:00Z"))?.commit).toBe("b".repeat(40));
  expect(newerRelease(own, version("a", "2026-10-05T10:00:00Z"))).toBeNull();
  expect(newerRelease(own, version("b", "2026-09-30T10:00:00Z"))).toBeNull();
  expect(newerRelease(own, version("b", null))).toBeNull();
  expect(newerRelease({ commit: "unknown", committedAt: null }, version("b", "2026-10-05T10:00:00Z"))).toBeNull();
  expect(newerRelease(own, null)).toBeNull();
});

test("each release is offered once per launch and failed checks retry quietly", async () => {
  let remote: unknown = version("b", "2026-10-05T10:00:00Z");
  let failing = false;
  const offered: string[] = [];
  let timer: (() => Promise<void>) | undefined;
  const watcher = watchForUpdates({
    readLocal: async () => own,
    fetchRemote: async () => { if (failing) throw new Error("offline"); return remote; },
    notify: async (latest: { commit: string }) => { offered.push(latest.commit[0]); },
    setTimer: (callback: () => Promise<void>) => { timer = callback; return 1; },
    clearTimer: () => { timer = undefined; },
  });
  await watcher.check();
  expect(offered).toEqual(["b"]);
  await timer!();
  expect(offered).toEqual(["b"]);
  failing = true;
  await timer!();
  failing = false;
  remote = version("c", "2026-10-07T10:00:00Z");
  await timer!();
  expect(offered).toEqual(["b", "c"]);
  watcher.stop();
  expect(timer).toBeUndefined();
});
