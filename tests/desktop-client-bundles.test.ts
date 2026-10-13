import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createClientBundles, isNewerBuild, validateManifest } from "../desktop/clientBundles.mjs";
import { newerShell } from "../desktop/updates.mjs";
import { listBundleFiles } from "../client/build/desktop-bundle.mjs";

const version = (letter: string, committedAt: string) => ({ commit: letter.repeat(40), committedAt });
const v1 = version("a", "2026-10-01T10:00:00.000Z");
const v2 = version("b", "2026-10-05T10:00:00.000Z");
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const temps: string[] = [];
afterEach(async () => { for (const dir of temps.splice(0)) await rm(dir, { recursive: true, force: true }); });

async function writeClient(dir: string, current: typeof v1, files: Record<string, string>) {
  for (const [name, text] of Object.entries({ ...files, "version.json": JSON.stringify(current) })) {
    await mkdir(path.dirname(path.join(dir, name)), { recursive: true });
    await writeFile(path.join(dir, name), text);
  }
}

async function setup() {
  const base = await mkdtemp(path.join(tmpdir(), "margin-bundles-"));
  temps.push(base);
  const bundledDir = path.join(base, "installed");
  await writeClient(bundledDir, v1, { "index.html": "<p>v1</p>", "assets/shared-1234abcd.js": "shared", "assets/old-1111aaaa.js": "old" });
  // What production serves for the next release.
  const site: Record<string, string> = { "index.html": "<p>v2</p>", "assets/shared-1234abcd.js": "shared", "assets/new-2222bbbb.js": "new", "version.json": JSON.stringify(v2) };
  const manifest = { ...v2, files: Object.entries(site).map(([name, text]) => ({ path: name, size: Buffer.byteLength(text), sha256: sha(text) })) };
  const requests: string[] = [];
  const fetchImpl = async (url: URL) => {
    const name = url.pathname.slice(1);
    requests.push(name);
    if (name === "desktop-bundle.json") return Response.json(manifest);
    return name in site ? new Response(site[name]) : new Response("missing", { status: 404 });
  };
  const root = path.join(base, "client-bundles");
  const create = () => createClientBundles({ root, bundledDir, origin: "https://www.marginchat.com", fetchImpl: fetchImpl as any });
  return { root, bundledDir, site, manifest, requests, create };
}

test("builds are ordered by commit time and only a newer one counts", () => {
  expect(isNewerBuild(v1, v2)).toBe(true);
  expect(isNewerBuild(v2, v1)).toBe(false);
  expect(isNewerBuild(v2, v2)).toBe(false);
  expect(isNewerBuild({ commit: "unknown", committedAt: null }, v2)).toBe(true);
  expect(isNewerBuild(v1, { commit: "nope", committedAt: v2.committedAt })).toBe(false);
});

test("file lists that could escape the bundle folder are refused", () => {
  const file = { size: 1, sha256: "0".repeat(64) };
  expect(() => validateManifest({ ...v2, files: [{ path: "index.html", ...file }] }, v1)).toThrow("does not match");
  for (const bad of ["../evil.js", "/etc/passwd", "assets/../../x", "a\\b", "assets//x"]) {
    expect(() => validateManifest({ ...v2, files: [{ path: "index.html", ...file }, { path: bad, ...file }] }, v2)).toThrow("not valid");
  }
  expect(() => validateManifest({ ...v2, files: [{ path: "app.js", ...file }] }, v2)).toThrow("index.html");
});

test("a newer client downloads once, reuses unchanged files and is served first", async () => {
  const { root, bundledDir, requests, create } = await setup();
  const bundles = create();
  expect(await bundles.load()).toEqual(v1);
  expect(await bundles.update()).toEqual(v2);
  // The unchanged chunk was copied from the installed client, not downloaded.
  expect(requests.sort()).toEqual(["assets/new-2222bbbb.js", "desktop-bundle.json", "index.html", "version.json", "version.json"].sort());
  expect(bundles.dirs()).toEqual([path.join(root, v2.commit), bundledDir]);
  expect(await readFile(path.join(root, v2.commit, "assets/shared-1234abcd.js"), "utf8")).toBe("shared");
  expect(await bundles.update()).toBeNull();

  // The next launch starts on the downloaded client.
  const relaunched = create();
  expect(await relaunched.load()).toEqual(v2);
  expect(relaunched.dirs()[0]).toBe(path.join(root, v2.commit));
});

test("a file that fails its checksum leaves the current client in place", async () => {
  const { root, bundledDir, site, create } = await setup();
  site["assets/new-2222bbbb.js"] = "tampered";
  const bundles = create();
  await bundles.load();
  await expect(bundles.update()).rejects.toThrow("checksum");
  expect(bundles.dirs()).toEqual([bundledDir]);
  expect((await readdir(root)).filter((name) => !name.endsWith(".partial"))).toEqual([]);
  expect(await create().load()).toEqual(v1);
});

test("a newer installer wins over an older download", async () => {
  const { bundledDir, create } = await setup();
  const bundles = create();
  await bundles.load();
  await bundles.update();
  await writeClient(bundledDir, version("c", "2026-10-09T10:00:00.000Z"), { "index.html": "<p>v3</p>" });
  const relaunched = create();
  expect((await relaunched.load())?.commit).toBe("c".repeat(40));
  expect(relaunched.dirs()).toEqual([bundledDir]);
});

test("the build lists every client file with its checksum", async () => {
  const { bundledDir } = await setup();
  const files = listBundleFiles(bundledDir);
  expect(files.map((file: { path: string }) => file.path)).toEqual(["assets/old-1111aaaa.js", "assets/shared-1234abcd.js", "index.html", "version.json"]);
  expect(files[1]).toEqual({ path: "assets/shared-1234abcd.js", size: 6, sha256: sha("shared") });
});

test("only a higher installer version asks for a new install", () => {
  expect(newerShell({ version: "0.1.0" }, { version: "0.2.0", commit: v2.commit })?.version).toBe("0.2.0");
  expect(newerShell({ version: "0.10.0" }, { version: "0.9.9" })).toBeNull();
  expect(newerShell({ version: "0.2.0" }, { version: "0.2.0" })).toBeNull();
  expect(newerShell({ version: "0.2.0" }, { version: null })).toBeNull();
});
