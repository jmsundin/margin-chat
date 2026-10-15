import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createS3BlobSdk } from "../scripts/backup/s3BlobSdk.mjs";
import { latestOffsiteBackup, offsiteConfig, offsiteStoreId, restoreOffsiteBackup, runOffsiteBackup } from "../scripts/offsite-backup.mjs";
import { createVaultService } from "../server/vault/index.mjs";
import { createBlobVaultStorage, createFileVaultStorage } from "../server/vault/storage.mjs";

const sourceToken = "vercel_blob_rw_productionStore_fake";

/** The @vercel/blob calls the vault service and backups make, on one in-memory store. */
function vercelBlobFake() {
  const objects = new Map<string, { bytes: Buffer; contentType: string; etag: string }>();
  let serial = 0;
  return {
    objects,
    async get(pathname: string) {
      const record = objects.get(pathname);
      if (!record) return null;
      return { statusCode: 200, stream: new Response(record.bytes).body, blob: { pathname, etag: record.etag, size: record.bytes.length, contentType: record.contentType } };
    },
    async put(pathname: string, bytes: Buffer, options: any) {
      const existing = objects.get(pathname);
      if (existing && !options.allowOverwrite) throw new Error("exists");
      if (options.ifMatch && existing?.etag !== options.ifMatch) throw Object.assign(new Error("precondition"), { name: "BlobPreconditionFailedError" });
      objects.set(pathname, { bytes: Buffer.from(bytes), contentType: options.contentType ?? "application/octet-stream", etag: `"v${++serial}"` });
      return { pathname };
    },
    async list({ prefix = "", cursor, limit = 1000 }: any) {
      const keys = [...objects.keys()].filter((key) => key.startsWith(prefix)).sort();
      const start = Number(cursor ?? 0);
      const page = keys.slice(start, start + limit);
      return { blobs: page.map((pathname) => ({ pathname, etag: objects.get(pathname)!.etag, size: objects.get(pathname)!.bytes.length })),
        hasMore: start + limit < keys.length, cursor: String(start + limit) };
    },
  };
}

const xml = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Just enough of the S3 API (PUT, GET, HEAD, ListObjectsV2) for Bun's S3 client, like an R2 bucket. */
function fakeBucket({ pageSize = 2 } = {}) {
  const objects = new Map<string, { bytes: Uint8Array; type: string; etag: string }>();
  const requests: string[] = [];
  let serial = 0;
  const server = Bun.serve({ port: 0, async fetch(request) {
    const url = new URL(request.url);
    const key = decodeURIComponent(url.pathname.replace(/^\/backups\/?/, ""));
    requests.push(`${request.method} ${key}`);
    if (request.method === "GET" && url.searchParams.get("list-type") === "2") {
      const prefix = url.searchParams.get("prefix") ?? "";
      const delimiter = url.searchParams.get("delimiter");
      const max = Math.min(pageSize, Number(url.searchParams.get("max-keys") ?? 1000));
      const keys = [...objects.keys()].filter((name) => name.startsWith(prefix)).sort();
      const entries: Array<{ key: string } | { folder: string }> = [];
      const folders = new Set<string>();
      for (const name of keys) {
        const rest = name.slice(prefix.length);
        if (delimiter && rest.includes(delimiter)) {
          const folder = prefix + rest.slice(0, rest.indexOf(delimiter) + 1);
          if (!folders.has(folder)) { folders.add(folder); entries.push({ folder }); }
        } else entries.push({ key: name });
      }
      const start = Number(url.searchParams.get("continuation-token") ?? 0);
      const page = entries.slice(start, start + max);
      const more = start + max < entries.length;
      const body = `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><Name>backups</Name><Prefix>${xml(prefix)}</Prefix><KeyCount>${page.length}</KeyCount><MaxKeys>${max}</MaxKeys><IsTruncated>${more}</IsTruncated>${more ? `<NextContinuationToken>${start + max}</NextContinuationToken>` : ""}${
        page.map((entry) => "key" in entry
          ? `<Contents><Key>${xml(entry.key)}</Key><ETag>${xml(objects.get(entry.key)!.etag)}</ETag><Size>${objects.get(entry.key)!.bytes.length}</Size><LastModified>2026-10-15T00:00:00.000Z</LastModified></Contents>`
          : `<CommonPrefixes><Prefix>${xml(entry.folder)}</Prefix></CommonPrefixes>`).join("")}</ListBucketResult>`;
      return new Response(body, { headers: { "content-type": "application/xml" } });
    }
    if (request.method === "PUT") {
      // R2 quotes ETags in reads but listings are compared too; mix the forms like providers do.
      objects.set(key, { bytes: new Uint8Array(await request.arrayBuffer()), type: request.headers.get("content-type") ?? "application/octet-stream", etag: `"e${++serial}"` });
      return new Response(null, { headers: { etag: objects.get(key)!.etag } });
    }
    const record = objects.get(key);
    if (!record) return new Response(`<?xml version="1.0"?><Error><Code>NoSuchKey</Code></Error>`, { status: 404, headers: { "content-type": "application/xml" } });
    return new Response(request.method === "HEAD" ? null : record.bytes, { headers: {
      "content-type": record.type, etag: record.etag.replace(/"/g, ""), "content-length": String(record.bytes.length), "last-modified": new Date().toUTCString(),
    } });
  } });
  const env = {
    BLOB_READ_WRITE_TOKEN: sourceToken,
    OFFSITE_BACKUP_S3_ENDPOINT: `http://127.0.0.1:${server.port}`,
    OFFSITE_BACKUP_S3_BUCKET: "backups",
    OFFSITE_BACKUP_S3_ACCESS_KEY_ID: "key",
    OFFSITE_BACKUP_S3_SECRET_ACCESS_KEY: "secret",
  };
  return { objects, requests, server, env, sdk: () => createS3BlobSdk(offsiteConfig(env)) };
}

describe("off-site backups", () => {
  const production = vercelBlobFake();
  const vault = createVaultService({ storage: createBlobVaultStorage({ BLOB_READ_WRITE_TOKEN: sourceToken }, production), env: {} });
  const bucket = fakeBucket();
  const folders: string[] = [];
  const folder = async () => { const path = await mkdtemp(join(tmpdir(), "margin-offsite-")); folders.push(path); return path; };
  let first: Awaited<ReturnType<typeof runOffsiteBackup>>;

  beforeAll(async () => {
    await vault.commit("jon", [
      { path: "Notes/Trip.md", content: "# Trip\n\nKyoto in April.", baseRevision: null },
      { path: "Notes/Budget.md", content: "# Budget\n\nFlights first.", baseRevision: null },
    ]);
    await vault.commit("sam", [{ path: "Ideas.md", content: "# Ideas\n\nA garden.", baseRevision: null }]);
  });
  afterAll(async () => {
    bucket.server.stop(true);
    await Promise.all(folders.map((path) => rm(path, { recursive: true, force: true })));
  });

  test("copies every vault file into the bucket with a complete inventory", async () => {
    first = await runOffsiteBackup({ env: bucket.env, sdk: production, backupSdk: bucket.sdk(), now: () => new Date("2026-10-15T07:23:00Z") });
    expect(first.prefix).toBe("releases/20261015072300-daily");
    expect(first.backupStoreId).toBe(offsiteStoreId(offsiteConfig(bucket.env)));
    expect(first.objectCount).toBe(production.objects.size);
    expect(bucket.objects.has("releases/20261015072300-daily/inventory.json")).toBe(true);
    // Nothing is written to the production store.
    expect([...production.objects.keys()].every((key) => key.startsWith("vaults/"))).toBe(true);
  });

  test("the next day copies only what changed and still lists everything", async () => {
    const [trip] = Object.entries((await vault.snapshot("jon")).manifest.files).filter(([path]) => path === "Notes/Trip.md");
    await vault.commit("jon", [{ path: "Notes/Trip.md", content: "# Trip\n\nKyoto in May.", baseRevision: (trip[1] as any).revision }]);
    const before = bucket.requests.filter((line) => line.startsWith("PUT")).length;
    const second = await runOffsiteBackup({ env: bucket.env, sdk: production, backupSdk: bucket.sdk(), now: () => new Date("2026-10-16T07:23:00Z") });
    const puts = bucket.requests.filter((line) => line.startsWith("PUT")).length - before;
    expect(second.objectCount).toBe(production.objects.size);
    // The new body, the new history root, Jon's manifest and the inventory; not the unchanged files.
    expect(puts).toBeLessThan(first.objectCount);
    expect(second.inventory.objects.filter((object: any) => object.backupPathname.startsWith("releases/20261015072300-daily/")).length).toBeGreaterThan(0);
    expect(await latestOffsiteBackup(bucket.sdk())).toBe("20261016072300-daily");
  });

  test("restores the newest backup into a folder the local server opens as its vault store", async () => {
    const restored = await folder();
    const result = await restoreOffsiteBackup({ env: bucket.env, directory: restored, backupSdk: bucket.sdk() });
    expect(result.backupId).toBe("20261016072300-daily");
    expect(result.objectCount).toBe(production.objects.size);
    const local = createVaultService({ storage: createFileVaultStorage(restored), env: {} });
    const read = async (userId: string, path: string) => Buffer.from((await local.readFile({ userId, path })).bytes).toString("utf8");
    expect(await read("jon", "Notes/Trip.md")).toBe("# Trip\n\nKyoto in May.");
    expect(await read("jon", "Notes/Budget.md")).toBe("# Budget\n\nFlights first.");
    expect(await read("sam", "Ideas.md")).toBe("# Ideas\n\nA garden.");
    expect((await readdir(restored)).sort()).toEqual(["restored-from-20261016072300-daily.json", "vaults"]);
  });

  test("an older backup restores to how the vault was that day", async () => {
    const restored = await folder();
    await restoreOffsiteBackup({ env: bucket.env, directory: restored, backupId: "20261015072300-daily", backupSdk: bucket.sdk() });
    const local = createVaultService({ storage: createFileVaultStorage(restored), env: {} });
    expect(Buffer.from((await local.readFile({ userId: "jon", path: "Notes/Trip.md" })).bytes).toString("utf8")).toBe("# Trip\n\nKyoto in April.");
  });

  test("refuses a damaged copy, a folder that isn't empty and a bucket that isn't set up", async () => {
    const used = await folder();
    await writeFile(join(used, "keep.txt"), "mine");
    await expect(restoreOffsiteBackup({ env: bucket.env, directory: used, backupSdk: bucket.sdk() })).rejects.toThrow("isn't empty");
    expect(await readdir(used)).toEqual(["keep.txt"]);

    // Damage one file that the newest backup lists.
    const inventory = JSON.parse(new TextDecoder().decode(bucket.objects.get("releases/20261016072300-daily/inventory.json")!.bytes));
    const key = inventory.objects.find((object: any) => object.pathname.endsWith("/manifest.json")).backupPathname;
    const record = bucket.objects.get(key)!;
    const original = record.bytes;
    bucket.objects.set(key, { ...record, bytes: new TextEncoder().encode("tampered".padEnd(original.length, "!")) });
    await expect(restoreOffsiteBackup({ env: bucket.env, directory: await folder(), backupSdk: bucket.sdk() })).rejects.toThrow(/verification failed/);
    bucket.objects.set(key, { ...record, bytes: original });

    expect(() => offsiteConfig({ OFFSITE_BACKUP_S3_BUCKET: "backups" })).toThrow(
      "Off-site backups are not set up: add OFFSITE_BACKUP_S3_ENDPOINT, OFFSITE_BACKUP_S3_ACCESS_KEY_ID, OFFSITE_BACKUP_S3_SECRET_ACCESS_KEY");
    await expect(runOffsiteBackup({ env: { ...bucket.env, OFFSITE_BACKUP_S3_SECRET_ACCESS_KEY: " " }, sdk: production })).rejects.toThrow("not set up");
    // A wrong endpoint or key is named before any copying starts.
    await expect(runOffsiteBackup({ env: { ...bucket.env, OFFSITE_BACKUP_S3_ENDPOINT: "http://127.0.0.1:9" }, sdk: production }))
      .rejects.toThrow(/Couldn't open the off-site bucket .*Check the OFFSITE_BACKUP_S3_\* secrets/);
  });
});
