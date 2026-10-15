import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { describeOnlyCopy } from "../client/src/components/OnlyCopyPrompt";
import { BACKUP_GRACE_MS, BACKUP_REMIND_MS, loadVaultBackup, onlyCopyReminder, saveVaultBackup, vaultFingerprint,
  type VaultBackupRecord } from "../client/src/lib/vaultBackupReminder";
import type { VaultFile } from "../client/src/lib/vaultTypes";

const DAY = 24 * 60 * 60 * 1000;
const now = Date.parse("2026-10-15T12:00:00.000Z");
const vault: Record<string, VaultFile> = {
  "Trip.md": { content: "# Trip\n\nKyoto in April." },
  "Scans/receipt.pdf": { content: "JVBERi0xLjQK", encoding: "base64", contentType: "application/pdf" },
  "workspace.json": { content: "{\"open\":[]}" },
};

function check(record: VaultBackupRecord, overrides: Partial<Parameters<typeof onlyCopyReminder>[0]> = {}) {
  return onlyCopyReminder({ cloudSync: false, folderChosen: false, hasDocuments: true, record, files: () => vault, now, ...overrides });
}

describe("only-copy reminder", () => {
  test("waits a day after documents first appear, then warns until there is a copy", () => {
    const first = check({});
    expect(first.reminder).toBeNull();
    expect(first.record.since).toBe(now);
    expect(check(first.record, { now: now + BACKUP_GRACE_MS - 1 }).reminder).toBeNull();
    expect(check(first.record, { now: now + BACKUP_GRACE_MS }).reminder).toEqual({ downloadedAt: null });
  });

  test("never warns with cloud sync, a connected folder or an empty vault", () => {
    const record = { since: now - 30 * DAY };
    expect(check(record).reminder).toEqual({ downloadedAt: null });
    expect(check(record, { cloudSync: true }).reminder).toBeNull();
    expect(check(record, { folderChosen: true }).reminder).toBeNull();
    expect(check(record, { hasDocuments: false }).reminder).toBeNull();
  });

  test("a download counts for a week, and after that only while nothing changed", () => {
    const downloadedAt = now - BACKUP_REMIND_MS;
    const record = { since: now - 30 * DAY, downloadedAt, fingerprint: vaultFingerprint(vault) };
    expect(check(record, { now: now - 1 }).reminder).toBeNull();
    expect(check(record).reminder).toBeNull();
    const edited = { ...vault, "Trip.md": { content: "# Trip\n\nKyoto in May." } };
    expect(check(record, { files: () => edited }).reminder).toEqual({ downloadedAt });
    const deleted = { ...vault };
    delete deleted["Trip.md"];
    expect(check(record, { files: () => deleted }).reminder).toEqual({ downloadedAt });
  });

  test("the vault is only read when a week-old download has to be compared", () => {
    let reads = 0;
    const files = () => { reads += 1; return vault; };
    check({ since: now - 30 * DAY }, { files });
    check({ since: now - 30 * DAY, downloadedAt: now - DAY, fingerprint: "x" }, { files });
    check({ since: now - 30 * DAY }, { files, cloudSync: true });
    expect(reads).toBe(0);
    check({ since: now - 30 * DAY, downloadedAt: now - 8 * DAY, fingerprint: "x" }, { files });
    expect(reads).toBe(1);
  });

  test("Later hides it for a week, and a clock set back or forward can't hide it for good", () => {
    const record = { since: now - 30 * DAY };
    expect(check({ ...record, snoozedUntil: now + BACKUP_REMIND_MS }).reminder).toBeNull();
    expect(check({ ...record, snoozedUntil: now }).reminder).toEqual({ downloadedAt: null });
    expect(check({ ...record, snoozedUntil: now + 365 * DAY }).reminder).toEqual({ downloadedAt: null });
    // A first-seen time in the future starts the grace period again from now.
    const future = check({ since: now + 365 * DAY });
    expect(future.reminder).toBeNull();
    expect(future.record.since).toBe(now);
    // So does a download dated in the future: it isn't counted.
    expect(check({ ...record, downloadedAt: now + DAY, fingerprint: vaultFingerprint(vault) }).reminder).toEqual({ downloadedAt: null });
  });

  test("the heading says how old the copy is", () => {
    expect(describeOnlyCopy({ downloadedAt: null }, now)).toBe("Your vault is only saved in this browser");
    expect(describeOnlyCopy({ downloadedAt: now - 8 * DAY - 1 }, now)).toBe("Your downloaded copy is 8 days old");
    expect(describeOnlyCopy({ downloadedAt: now - 2 * 3_600_000 }, now)).toBe("Your downloaded copy is 1 day old");
  });
});

describe("vault fingerprint", () => {
  test("changes with documents but not with settings or Margin Chat's own files", () => {
    const base = vaultFingerprint(vault);
    expect(vaultFingerprint({ ...vault })).toBe(base);
    expect(vaultFingerprint({ ...vault, "workspace.json": { content: "{\"open\":[\"Trip.md\"]}" } })).toBe(base);
    expect(vaultFingerprint({ ...vault, ".margin-chat/trash/k/1-Old.md": { content: "# Old" } })).toBe(base);
    expect(vaultFingerprint({ ...vault, "Trip.md": { content: "# Trip\n\nKyoto in april." } })).not.toBe(base);
    expect(vaultFingerprint({ ...vault, "Trips.md": vault["Trip.md"] })).not.toBe(base);
    expect(vaultFingerprint({ ...vault, "Scans/receipt.pdf": { ...vault["Scans/receipt.pdf"], content: "JVBERi0xLjUKJQ==" } })).not.toBe(base);
    // Where one string ends and the next begins matters.
    expect(vaultFingerprint({ "ab.md": { content: "c" } })).not.toBe(vaultFingerprint({ "a.md": { content: "bc" } }));
  });
});

describe("backup record", () => {
  let values: Map<string, string>;
  const original = (globalThis as any).localStorage;
  beforeEach(() => {
    values = new Map();
    (globalThis as any).localStorage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
      removeItem: (key: string) => { values.delete(key); },
    };
  });
  afterEach(() => { (globalThis as any).localStorage = original; });

  test("is kept per account in this browser and ignores damaged values", () => {
    saveVaultBackup("u", { downloadedAt: now, fingerprint: "1:abc", since: now - DAY });
    expect(loadVaultBackup("u")).toEqual({ downloadedAt: now, fingerprint: "1:abc", since: now - DAY });
    expect(loadVaultBackup("someone-else")).toEqual({});
    values.set("margin-chat:vault-backup:u", JSON.stringify({ downloadedAt: "yesterday", since: null, fingerprint: 4, snoozedUntil: now }));
    expect(loadVaultBackup("u")).toEqual({ snoozedUntil: now });
    values.set("margin-chat:vault-backup:u", "{not json");
    expect(loadVaultBackup("u")).toEqual({});
  });

  test("works without storage", () => {
    (globalThis as any).localStorage = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); } };
    expect(loadVaultBackup("u")).toEqual({});
    expect(() => saveVaultBackup("u", { downloadedAt: now })).not.toThrow();
  });
});
