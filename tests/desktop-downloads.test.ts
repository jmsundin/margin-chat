import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { loadMigrations, migrateDatabase } from "../server/db/migrations.mjs";
import { recordDesktopDownload } from "../server/db/downloadRepository.mjs";
import { createDesktopDownloadService, describeDownloadRequest, parseDesktopRelease } from "../server/downloads/index.mjs";
import { createApiHandler } from "../server/routes/api.mjs";
import { primaryDownload, readDownloadLinks, withDesktopRelease, downloadHref } from "../client/src/lib/platform";

const release = {
  tag_name: "desktop-v0.2.0",
  published_at: "2026-10-11T20:00:00Z",
  assets: [
    { id: 1, name: "Margin-Chat-0.2.0-mac-universal.dmg", size: 250 },
    { id: 2, name: "Margin-Chat-0.2.0-win-x64-setup.exe", size: 120 },
    { id: 3, name: "Margin-Chat-0.2.0-linux-x86_64.AppImage", size: 130 },
    { id: 4, name: "Margin-Chat-0.2.0-linux-amd64.deb", size: 90 },
    { id: 5, name: "version.json", size: 1 },
  ],
};
const version = { commit: "a".repeat(40), committedAt: "2026-10-11T19:00:00.000Z" };

function fakeGitHub(calls: string[] = [], { latest = release }: { latest?: unknown } = {}) {
  return (async (url: string, init: any = {}) => {
    calls.push(url);
    if (url.startsWith("https://signed.example/")) return Response.json(version);
    expect(init.headers.Authorization).toBe("Bearer token");
    if (url.endsWith("/releases/latest")) return latest ? Response.json(latest) : new Response("", { status: 404 });
    const asset = /\/releases\/assets\/(\d+)$/u.exec(url);
    if (asset) {
      expect(init.redirect).toBe("manual");
      return new Response(null, { status: 302, headers: { Location: `https://signed.example/${asset[1]}` } });
    }
    throw new Error(`Unexpected request ${url}`);
  }) as unknown as typeof fetch;
}

test("a release lists one installer per system and carries the build's commit", () => {
  const parsed = parseDesktopRelease(release, version)!;
  expect(parsed.version).toBe("0.2.0");
  expect(parsed.commit).toBe(version.commit);
  expect(Object.fromEntries(Object.entries(parsed.files).map(([target, file]) => [target, file.id]))).toEqual({ mac: 1, windows: 2, linux: 3, "linux-deb": 4 });
  expect(parseDesktopRelease({ tag_name: "desktop-v0.1.0", assets: [] })!.files).toEqual({});
  expect(parseDesktopRelease(null)).toBeNull();
});

test("download details read location only from a trusted proxy", () => {
  const request = { headers: {
    "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/140.0",
    "accept-language": "en-US,en;q=0.9",
    "x-vercel-ip-country": "US", "x-vercel-ip-country-region": "CA", "x-vercel-ip-city": "San%20Francisco",
    "x-vercel-ip-latitude": "37.77", "x-vercel-ip-longitude": "-122.41", "x-vercel-ip-timezone": "America/Los_Angeles",
  } };
  const url = new URL("https://www.marginchat.com/api/downloads/desktop/windows?from=hero");
  expect(describeDownloadRequest(request, { address: "203.0.113.9", trustProxyHeaders: true, url })).toMatchObject({
    ipAddress: "203.0.113.9", os: "windows", source: "hero", acceptLanguage: "en-US,en;q=0.9",
    country: "US", region: "CA", city: "San Francisco", latitude: 37.77, longitude: -122.41, timezone: "America/Los_Angeles",
  });
  expect(describeDownloadRequest(request, { address: "203.0.113.9", url })).toMatchObject({ country: null, city: null, latitude: null });
});

test("without a token or a release nothing is offered", async () => {
  const none = createDesktopDownloadService({ database: {}, env: {}, fetchImpl: fakeGitHub() });
  expect(await none.describe()).toEqual({ available: false, version: null, files: {} });
  const empty = createDesktopDownloadService({ database: {}, env: { DESKTOP_RELEASES_TOKEN: "token" }, fetchImpl: fakeGitHub([], { latest: null }) });
  expect((await empty.describe()).available).toBe(false);
  expect(await empty.download({ target: "mac", details: {} })).toBeNull();
});

test("the release is cached and recording stops per address after the limit", async () => {
  const calls: string[] = [];
  const saved: any[] = [];
  const service = createDesktopDownloadService({
    database: { recordDesktopDownload: async (row: any) => { saved.push(row); } },
    env: { DESKTOP_RELEASES_TOKEN: "token" },
    fetchImpl: fakeGitHub(calls),
  });
  const described = await service.describe();
  expect(described).toMatchObject({ available: true, version: "0.2.0", commit: version.commit, committedAt: version.committedAt });
  expect(described.files.windows).toMatchObject({ href: "/api/downloads/desktop/windows", name: "Margin-Chat-0.2.0-win-x64-setup.exe" });
  for (let index = 0; index < 32; index += 1) {
    expect(await service.download({ target: "linux", details: { ipAddress: "198.51.100.1" } })).toBe("https://signed.example/3");
  }
  expect(saved).toHaveLength(30);
  expect(saved[0]).toMatchObject({ target: "linux", platform: "linux", version: "0.2.0", assetName: "Margin-Chat-0.2.0-linux-x86_64.AppImage" });
  expect(calls.filter((url) => url.endsWith("/releases/latest"))).toHaveLength(1);
});

describe("download routes", () => {
  let server: Server;
  let origin: string;
  let pg: PGlite;
  beforeAll(async () => {
    pg = new PGlite({ extensions: { vector } });
    const client = {
      async query(sql: string, params?: unknown[]) {
        const result = params === undefined && sql.includes(";") ? (await pg.exec(sql)).at(-1) ?? { rows: [] } : await pg.query(sql, params);
        return { ...result, rowCount: result.rows.length || (result as any).affectedRows || 0 };
      },
    };
    await migrateDatabase(client, { migrations: await loadMigrations() });
    await client.query("insert into marginchat_users (id, email, password_hash, display_name) values ('u1', 'u1@example.com', 'x', 'One')");
    const desktopDownloadService = createDesktopDownloadService({
      database: { recordDesktopDownload: (row: any) => recordDesktopDownload(client, row) },
      env: { DESKTOP_RELEASES_TOKEN: "token" },
      fetchImpl: fakeGitHub(),
    });
    server = createServer(createApiHandler({
      runtimeConfig: { host: "127.0.0.1", port: 0, trustProxyHeaders: true },
      authService: { getAuthContext: async (request: any) => ({ user: request.headers["x-test-user"] ? { id: request.headers["x-test-user"] } : null }) },
      desktopDownloadService,
    } as any));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    origin = `http://127.0.0.1:${(server.address() as any).port}`;
  }, 30_000);
  afterAll(async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); });

  test("a download is saved with who asked, then redirects to the installer", async () => {
    const response = await fetch(`${origin}/api/downloads/desktop/mac?from=hero`, {
      redirect: "manual",
      headers: { "x-test-user": "u1", "x-forwarded-for": "203.0.113.7", "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", "x-vercel-ip-country": "DE" },
    });
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("https://signed.example/1");
    const { rows } = await pg.query<any>("select * from marginchat_desktop_downloads");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ target: "mac", platform: "mac", version: "0.2.0", user_id: "u1", ip_address: "203.0.113.7", os: "mac", source: "hero", country: "DE" });
  });

  test("the release summary is public and unknown systems are not routes", async () => {
    const summary = await (await fetch(`${origin}/api/downloads/desktop`)).json();
    expect(Object.keys(summary.files).sort()).toEqual(["linux", "linux-deb", "mac", "windows"]);
    expect((await fetch(`${origin}/api/downloads/desktop/solaris`, { redirect: "manual" })).status).not.toBe(302);
  });
});

test("the site offers each system's installer once a release is published", () => {
  const links = withDesktopRelease(readDownloadLinks({}), {
    version: "0.2.0",
    files: { mac: { href: "/api/downloads/desktop/mac" }, windows: { href: "/api/downloads/desktop/windows" }, linux: { href: "https://elsewhere.example/x" } },
  });
  expect(links).toMatchObject({ mac: "/api/downloads/desktop/mac", windows: "/api/downloads/desktop/windows", linux: "", desktopVersion: "0.2.0" });
  expect(primaryDownload("windows", links)).toMatchObject({ kind: "desktop", label: "Download for Windows", href: "/api/downloads/desktop/windows" });
  expect(primaryDownload("linux", links).kind).toBe("web");
  expect(downloadHref("/api/downloads/desktop/mac", "hero")).toBe("/api/downloads/desktop/mac?from=hero");
});
