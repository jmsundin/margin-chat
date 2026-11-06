import { expect, test } from "bun:test";
import { describeDesktopSync } from "../client/src/lib/desktopSyncStatus";
import type { BridgeSyncStatus } from "../packages/vault-sync/bridgeProtocol";

const base: BridgeSyncStatus = { state: "synced", lastSyncedAt: null, pending: 0, attention: null, held: null, folder: null, cloud: true, paused: false, lastError: null };

test("the sync indicator says one quiet thing, and raises attention only when the person is needed", () => {
  const now = Date.parse("2026-11-06T12:00:00Z");
  expect(describeDesktopSync({ ...base, lastSyncedAt: now - 2 * 60_000 }, now)).toMatchObject({ label: expect.stringMatching(/^Synced · /u), tone: "ok" });
  expect(describeDesktopSync(base, now)).toMatchObject({ label: "Synced", tone: "ok" });
  expect(describeDesktopSync({ ...base, state: "syncing", pending: 3 }, now)).toMatchObject({ label: "Syncing…", detail: "3 changes waiting to sync", tone: "busy" });
  expect(describeDesktopSync({ ...base, state: "offline", pending: 1 }, now)).toMatchObject({ label: "Offline — changes saved locally", detail: expect.stringContaining("1 change waiting"), tone: "muted" });
  expect(describeDesktopSync({ ...base, state: "paused", paused: true }, now)).toMatchObject({ label: "Paused", tone: "muted" });
  expect(describeDesktopSync({ ...base, state: "local", cloud: false }, now)).toMatchObject({ label: "Saved in this folder", tone: "muted" });
  expect(describeDesktopSync({ ...base, state: "attention", attention: { kind: "deletion-hold", message: "12 files are missing." } }, now))
    .toEqual({ label: "Needs attention", detail: "12 files are missing.", tone: "attention" });
  // A single failure is not attention; the Sync settings page shows it as the last problem instead.
  expect(describeDesktopSync({ ...base, lastError: "The vault is changing on another device." }, now).tone).toBe("ok");
});
