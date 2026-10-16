export type VisitorPlatform = "mac" | "windows" | "linux" | "chromeos" | "ios" | "android" | "unknown";

export const PLATFORM_LABELS: Record<Exclude<VisitorPlatform, "unknown">, string> = {
  mac: "macOS",
  windows: "Windows",
  linux: "Linux",
  chromeos: "ChromeOS",
  ios: "iPhone and iPad",
  android: "Android",
};

export function detectPlatform(userAgent: string, maxTouchPoints = 0): VisitorPlatform {
  if (/iPhone|iPad|iPod/.test(userAgent)) return "ios";
  if (/Android/.test(userAgent)) return "android";
  if (/CrOS/.test(userAgent)) return "chromeos";
  // iPadOS Safari reports itself as a Mac; touch support gives it away.
  if (/Macintosh|Mac OS X/.test(userAgent)) return maxTouchPoints > 1 ? "ios" : "mac";
  if (/Windows/.test(userAgent)) return "windows";
  if (/Linux/.test(userAgent)) return "linux";
  return "unknown";
}

/** The Margin Chat desktop app: its built-in client on margin://, or the Vite dev server loaded in its window. */
export function isDesktopApp(
  location: { protocol: string } | undefined = typeof window === "undefined" ? undefined : window.location,
  userAgent: string = typeof navigator === "undefined" ? "" : navigator.userAgent ?? "",
): boolean {
  return location?.protocol === "margin:" || /\bElectron\/\d/.test(userAgent);
}

export function detectVisitorPlatform(): VisitorPlatform {
  if (typeof navigator === "undefined") return "unknown";
  return detectPlatform(navigator.userAgent ?? "", navigator.maxTouchPoints ?? 0);
}

export interface DownloadLinks {
  /** macOS .dmg (Apple Silicon and Intel). Empty until a build is published. */
  mac: string;
  /** Windows installer (.exe). Empty until a build is published. */
  windows: string;
  /** Linux AppImage. Empty until a build is published. */
  linux: string;
  /** Linux .deb for Debian, Ubuntu and ChromeOS. Empty until a build is published. */
  linuxDeb: string;
  /** Version of the published desktop build, when there is one. */
  desktopVersion: string;
  /** Chrome Web Store listing. Empty until the extension is published. */
  chromeExtension: string;
}

export function readDownloadLinks(env: Record<string, unknown> = import.meta.env): DownloadLinks {
  const value = (key: string) => (typeof env[key] === "string" ? (env[key] as string).trim() : "");
  return { mac: value("VITE_MAC_DOWNLOAD_URL"), windows: "", linux: "", linuxDeb: "", desktopVersion: "", chromeExtension: value("VITE_CHROME_EXTENSION_URL") };
}

/** What GET /api/downloads/desktop answers: the latest published desktop build. */
export interface DesktopReleaseInfo {
  version?: string | null;
  files?: Partial<Record<"mac" | "windows" | "linux" | "linux-deb", { href?: string }>>;
}

/** Downloads go through the server, which records them and then sends the
 * installer; `source` says which button was used. */
export function withDesktopRelease(links: DownloadLinks, release: DesktopReleaseInfo | null | undefined): DownloadLinks {
  const href = (target: keyof NonNullable<DesktopReleaseInfo["files"]>, fallback: string) => {
    const path = release?.files?.[target]?.href;
    return typeof path === "string" && path.startsWith("/api/") ? path : fallback;
  };
  return {
    ...links,
    mac: href("mac", links.mac),
    windows: href("windows", links.windows),
    linux: href("linux", links.linux),
    linuxDeb: href("linux-deb", links.linuxDeb),
    desktopVersion: typeof release?.version === "string" ? release.version : links.desktopVersion,
  };
}

export async function fetchDesktopRelease(fetchImpl: typeof fetch = fetch): Promise<DesktopReleaseInfo | null> {
  try {
    const response = await fetchImpl("/api/downloads/desktop");
    return response.ok ? await response.json() as DesktopReleaseInfo : null;
  } catch {
    return null;
  }
}

/** Tags a download link with where on the site it was clicked. */
export function downloadHref(href: string, source: string): string {
  return href.startsWith("/api/") ? `${href}?from=${encodeURIComponent(source)}` : href;
}

export interface PrimaryDownload {
  /** Desktop download when one exists for this platform, otherwise the web app. */
  kind: "desktop" | "web";
  label: string;
  note: string;
  /** The installer to download when kind is "desktop". */
  href?: string;
}

export function primaryDownload(platform: VisitorPlatform, links: DownloadLinks): PrimaryDownload {
  if (platform === "mac" && links.mac) return { kind: "desktop", label: "Download for macOS", note: "Apple Silicon and Intel", href: links.mac };
  if (platform === "windows" && links.windows) return { kind: "desktop", label: "Download for Windows", note: "Windows 10 and 11, 64-bit", href: links.windows };
  if (platform === "linux" && links.linux) return { kind: "desktop", label: "Download for Linux", note: "AppImage for 64-bit Intel and AMD", href: links.linux };
  if (platform === "mac" || platform === "windows" || platform === "linux") return { kind: "web", label: "Open the web app", note: `The ${PLATFORM_LABELS[platform]} app is coming soon. Margin Chat runs in your browser today.` };
  if (platform === "ios" || platform === "android") return { kind: "web", label: "Open the web app", note: "Runs in your phone's browser. Add it to your Home Screen." };
  return { kind: "web", label: "Open the web app", note: "Works in any modern browser." };
}
