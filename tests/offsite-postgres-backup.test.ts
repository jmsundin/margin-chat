import { expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { databaseUrl, runPostgresBackup } from "../scripts/offsite-postgres-backup.mjs";

const env = {
  OFFSITE_BACKUP_S3_ENDPOINT: "https://account.r2.cloudflarestorage.com",
  OFFSITE_BACKUP_S3_BUCKET: "backups",
  OFFSITE_BACKUP_S3_ACCESS_KEY_ID: "key",
  OFFSITE_BACKUP_S3_SECRET_ACCESS_KEY: "secret",
  OFFSITE_BACKUP_DATABASE_URL: "postgresql://reader:pw@db.example/neondb?sslmode=require",
};

function fakeBucket() {
  const objects = new Map<string, { bytes: Uint8Array; contentType?: string }>();
  return { objects, async put(pathname: string, bytes: Uint8Array, options: { contentType?: string }) { objects.set(pathname, { bytes, contentType: options.contentType }); return { pathname }; } };
}

test("dumps, checks and uploads the database under a dated name", async () => {
  const bucket = fakeBucket();
  const calls: string[][] = [];
  const result = await runPostgresBackup({
    env, bucket, now: () => new Date("2026-10-25T07:23:00Z"),
    async runCommand(command: string, args: string[], childEnv: Record<string, string>) {
      calls.push([command, ...args]);
      expect(Object.keys(childEnv)).not.toContain("OFFSITE_BACKUP_S3_SECRET_ACCESS_KEY");
      if (command === "pg_dump") await writeFile(args.find((arg) => arg.startsWith("--file="))!.slice(7), "PGDMP fake dump");
      return command === "pg_restore" ? "; Archive\n3; 0 0 TABLE DATA public marginchat_users\n4; 0 0 TABLE DATA public marginchat_chats\n" : "";
    },
  });
  expect(result).toMatchObject({ pathname: "postgres/20261025072300.dump", tables: 2 });
  expect(calls.map(([command]) => command)).toEqual(["pg_dump", "pg_restore"]);
  expect(calls[0]).toContain("--format=custom");
  expect(new TextDecoder().decode(bucket.objects.get("postgres/20261025072300.dump")!.bytes)).toBe("PGDMP fake dump");
});

test("refuses an empty dump and a missing or wrong connection string", async () => {
  const bucket = fakeBucket();
  await expect(runPostgresBackup({
    env, bucket,
    async runCommand(command: string, args: string[]) {
      if (command === "pg_dump") await writeFile(args.find((arg) => arg.startsWith("--file="))!.slice(7), "PGDMP");
      return "";
    },
  })).rejects.toThrow("no table data");
  expect(bucket.objects.size).toBe(0);
  expect(() => databaseUrl({})).toThrow("add OFFSITE_BACKUP_DATABASE_URL");
  expect(() => databaseUrl({ OFFSITE_BACKUP_DATABASE_URL: "mysql://x" })).toThrow("postgresql://");
});
