import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configurationGaps, readReleaseConfig, redact, REQUIRED_RELEASE_SECRETS } from "../scripts/release/config.mjs";

const completeConfig = () => ({
  schemaVersion: 1,
  vercel: { projectId: "prj_test", orgId: "team_test" },
  neon: { projectId: "test-project", productionBranchId: "br-production", databaseName: "app", roleName: "owner" },
  productionUrl: "https://production.example.test",
  blob: { productionStoreId: "production123", backupStoreId: "backup123", rehearsalStoreId: "rehearsal123" },
  jobs: [],
  compatibility: { oldApplication: true, oldClients: true, automaticAppRollback: false },
  observation: { checks: 3, intervalSeconds: 10 },
});
const completeEnv = Object.fromEntries(REQUIRED_RELEASE_SECRETS.map((key) => [key, `test-only-${key}`]));

describe("production release configuration", () => {
  let directory: string;
  beforeAll(async () => { directory = await mkdtemp(join(tmpdir(), "margin-release-config-")); });
  afterAll(async () => { await rm(directory, { recursive: true, force: true }); });
  async function readFixture(config: unknown) {
    const path = join(directory, `${crypto.randomUUID()}.json`);
    await writeFile(path, JSON.stringify(config));
    return readReleaseConfig(path);
  }

  test("loads an explicit backward-compatible release with no implicit jobs", async () => {
    const config = completeConfig();
    expect(await readFixture(config)).toEqual(config);
    expect(configurationGaps(config, completeEnv)).toEqual([]);
  });

  test("rejects unknown schema, duplicate jobs and non-string job ids", async () => {
    await expect(readFixture(null)).rejects.toThrow("schemaVersion");
    await expect(readFixture({ ...completeConfig(), schemaVersion: 2 })).rejects.toThrow("schemaVersion");
    await expect(readFixture({ ...completeConfig(), jobs: ["vault-projection-v1", "vault-projection-v1"] })).rejects.toThrow("unique");
    await expect(readFixture({ ...completeConfig(), jobs: [1] })).rejects.toThrow("job IDs");
  });

  test("requires compatibility with both old server code and delayed browser clients", async () => {
    for (const field of ["oldApplication", "oldClients"]) {
      const config = completeConfig();
      (config.compatibility as any)[field] = false;
      await expect(readFixture(config)).rejects.toThrow("expand/migrate/contract");
    }
    await expect(readFixture({ ...completeConfig(), compatibility: { oldApplication: true, oldClients: true } })).rejects.toThrow("automaticAppRollback");
  });

  test("bounds production observation and rejects fractional counts", async () => {
    for (const observation of [{ checks: 0, intervalSeconds: 10 }, { checks: 31, intervalSeconds: 10 },
      { checks: 1.5, intervalSeconds: 10 }, { checks: 3, intervalSeconds: 0 }, { checks: 3, intervalSeconds: 61 }]) {
      await expect(readFixture({ ...completeConfig(), observation })).rejects.toThrow("Observation");
    }
  });

  test("reports missing provider identity and all required credentials without exposing values", () => {
    const gaps = configurationGaps({ vercel: {}, neon: {}, productionUrl: "" });
    expect(gaps).toEqual(expect.arrayContaining([
      "vercel.projectId", "vercel.orgId", "neon.projectId", "neon.productionBranchId", "neon.databaseName", "neon.roleName",
      "productionUrl (HTTPS origin)", ...REQUIRED_RELEASE_SECRETS,
    ]));
    const config = completeConfig();
    config.neon.roleName = "   ";
    expect(configurationGaps(config, completeEnv)).toEqual(["neon.roleName"]);
    expect(configurationGaps({ ...completeConfig(), vercel: { projectId: 1, orgId: "team_test" } }, completeEnv)).toEqual(["vercel.projectId"]);
  });

  test("production destination must be a credential-free HTTPS origin", () => {
    for (const productionUrl of ["http://production.example.test", "https://user:password@production.example.test",
      "https://production.example.test/app", "https://production.example.test?redirect=other", "https://production.example.test#fragment"]) {
      expect(configurationGaps({ ...completeConfig(), productionUrl }, completeEnv)).toEqual(["productionUrl (HTTPS origin)"]);
    }
  });

  test("redacts explicit secrets, connection URLs and Blob tokens from failure messages", () => {
    const result = redact(
      "Failed abc-longer-secret then abc-longer postgres://user:password@host.example.test/db?sslmode=require and vercel_blob_rw_Example123_secretvalue",
      ["abc-longer", "abc-longer-secret"],
    );
    expect(result).toContain("Failed [redacted] then [redacted]");
    expect(result).toContain("[redacted database URL]");
    expect(result).toContain("[redacted Blob token]");
    expect(result).not.toContain("password");
    expect(result).not.toContain("secretvalue");
    expect(result).not.toContain("abc-longer");
  });
});
