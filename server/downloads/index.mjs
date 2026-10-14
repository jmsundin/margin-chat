import { createRateLimiter } from "../http/rateLimit.mjs";

// Desktop installers are published as GitHub releases by
// .github/workflows/desktop-release.yml. The server reads the latest release,
// records who asked for an installer, and sends them to its public download
// URL. A private repository needs DESKTOP_RELEASES_TOKEN, and then the
// visitor gets a short-lived signed URL instead.
export const DESKTOP_TARGETS = Object.freeze({
  mac: { platform: "mac", label: "macOS", match: (name) => /\.dmg$/iu.test(name) },
  windows: { platform: "windows", label: "Windows", match: (name) => /\.exe$/iu.test(name) },
  linux: { platform: "linux", label: "Linux (AppImage)", match: (name) => /\.AppImage$/iu.test(name) },
  "linux-deb": { platform: "linux", label: "Linux (.deb)", match: (name) => /\.deb$/iu.test(name) },
});

const RELEASE_CACHE_MS = 5 * 60 * 1000;
const GITHUB_API = "https://api.github.com";
// Bots and retries should not flood the table; every request still downloads.
const RECORDS_PER_ADDRESS = { max: 30, windowMs: 60 * 60 * 1000 };

export function parseDesktopRelease(release, version = null) {
  if (!release || typeof release.tag_name !== "string" || !Array.isArray(release.assets)) return null;
  const files = {};
  for (const [target, { match }] of Object.entries(DESKTOP_TARGETS)) {
    const asset = release.assets.find((item) => typeof item?.name === "string" && match(item.name));
    if (asset) files[target] = { id: asset.id, name: asset.name, size: Number(asset.size) || 0, url: typeof asset.browser_download_url === "string" ? asset.browser_download_url : null };
  }
  return {
    tag: release.tag_name,
    version: release.tag_name.replace(/^desktop-v/u, ""),
    publishedAt: release.published_at ?? null,
    commit: typeof version?.commit === "string" ? version.commit : null,
    committedAt: typeof version?.committedAt === "string" ? version.committedAt : null,
    files,
  };
}

/** The operating system a user agent names, as the download page detects it. */
export function userAgentPlatform(userAgent) {
  const value = String(userAgent ?? "");
  if (/iPhone|iPad|iPod/u.test(value)) return "ios";
  if (/Android/u.test(value)) return "android";
  if (/CrOS/u.test(value)) return "chromeos";
  if (/Macintosh|Mac OS X/u.test(value)) return "mac";
  if (/Windows/u.test(value)) return "windows";
  if (/Linux/u.test(value)) return "linux";
  return null;
}

function header(request, name, limit = 512) {
  const raw = request.headers[name];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== "string" || !value.trim()) return null;
  return value.trim().slice(0, limit);
}

function decoded(value) {
  if (value === null) return null;
  try { return decodeURIComponent(value); } catch { return value; }
}

function coordinate(value) {
  const number = Number(value);
  return value !== null && Number.isFinite(number) ? number : null;
}

/** Everything the request says about who is downloading. Location headers are
 * only set by Vercel's edge, so they are read only behind a trusted proxy. */
export function describeDownloadRequest(request, { address, trustProxyHeaders = false, url } = {}) {
  const proxied = (name, limit) => (trustProxyHeaders ? header(request, name, limit) : null);
  const userAgent = header(request, "user-agent", 1024);
  return {
    ipAddress: address && address !== "unknown" ? address : null,
    userAgent,
    os: userAgentPlatform(userAgent),
    acceptLanguage: header(request, "accept-language", 256),
    referer: header(request, "referer", 1024),
    source: url?.searchParams.get("from")?.slice(0, 64) || null,
    country: proxied("x-vercel-ip-country", 8),
    region: proxied("x-vercel-ip-country-region", 16),
    city: decoded(proxied("x-vercel-ip-city", 128)),
    postalCode: proxied("x-vercel-ip-postal-code", 32),
    latitude: coordinate(proxied("x-vercel-ip-latitude", 32)),
    longitude: coordinate(proxied("x-vercel-ip-longitude", 32)),
    timezone: proxied("x-vercel-ip-timezone", 64),
  };
}

export function createDesktopDownloadService({ database, env = process.env, fetchImpl = globalThis.fetch, now = Date.now }) {
  const repository = env.DESKTOP_RELEASES_REPO?.trim() || "jmsundin/margin-chat";
  const token = env.DESKTOP_RELEASES_TOKEN?.trim() || "";
  const recordsByAddress = createRateLimiter({ ...RECORDS_PER_ADDRESS, now });
  let cached = null;

  const github = (path, init = {}) => fetchImpl(`${GITHUB_API}/repos/${repository}${path}`, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "margin-chat-downloads",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...init.headers,
    },
  });

  // GitHub answers an asset request with a redirect to a signed URL that
  // works for a few minutes without credentials.
  async function signedAssetUrl(assetId, publicUrl = null) {
    if (!token && publicUrl) return publicUrl;
    const response = await github(`/releases/assets/${assetId}`, { headers: { Accept: "application/octet-stream" }, redirect: "manual" });
    const location = response.headers.get("location");
    if (response.status >= 300 && response.status < 400 && location) return location;
    throw new Error(`GitHub did not return a download link (${response.status}).`);
  }

  async function loadLatest() {
    const response = await github("/releases/latest");
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`GitHub releases request failed (${response.status}).`);
    const release = await response.json();
    // version.json tells the desktop app whether it is out of date.
    const versionAsset = release.assets?.find((asset) => asset?.name === "version.json");
    let version = null;
    if (versionAsset) {
      try {
        const file = await fetchImpl(await signedAssetUrl(versionAsset.id, versionAsset.browser_download_url));
        if (file.ok) version = await file.json();
      } catch { /* The installers still download without it. */ }
    }
    return parseDesktopRelease(release, version);
  }

  async function latest() {
    if (cached && cached.expiresAt > now()) return cached.value;
    try {
      const value = await loadLatest();
      cached = { value, expiresAt: now() + RELEASE_CACHE_MS };
      return value;
    } catch (error) {
      console.error("Desktop release lookup failed", error);
      // Keep serving the last good answer for a while rather than nothing.
      if (cached) return cached.value;
      return null;
    }
  }

  /** What the download page and the desktop update check read. */
  async function describe() {
    const release = await latest();
    if (!release) return { available: false, version: null, files: {} };
    return {
      available: Object.keys(release.files).length > 0,
      version: release.version,
      publishedAt: release.publishedAt,
      commit: release.commit,
      committedAt: release.committedAt,
      files: Object.fromEntries(Object.entries(release.files).map(([target, file]) => [target, {
        name: file.name, size: file.size, label: DESKTOP_TARGETS[target].label, href: `/api/downloads/desktop/${target}`,
      }])),
    };
  }

  /** Saves the download and returns where to send the visitor, or null when
   * nothing is published for that target. Recording never blocks a download. */
  async function download({ target, details, userId = null }) {
    const release = await latest();
    const file = release?.files[target];
    if (!file) return null;
    const location = await signedAssetUrl(file.id, file.url);
    const key = details.ipAddress ?? "unknown";
    try {
      recordsByAddress.check(key);
      recordsByAddress.record(key);
      await database.recordDesktopDownload({
        ...details, target, platform: DESKTOP_TARGETS[target].platform, version: release.version, assetName: file.name, userId,
      });
    } catch (error) {
      if (error?.statusCode !== 429) console.error("Recording a desktop download failed", error);
    }
    return location;
  }

  return { describe, download };
}
