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

export function detectVisitorPlatform(): VisitorPlatform {
  if (typeof navigator === "undefined") return "unknown";
  return detectPlatform(navigator.userAgent ?? "", navigator.maxTouchPoints ?? 0);
}

export interface DownloadLinks {
  /** Signed .dmg for macOS. Empty until a build is published. */
  mac: string;
  /** Chrome Web Store listing. Empty until the extension is published. */
  chromeExtension: string;
}

export function readDownloadLinks(env: Record<string, unknown> = import.meta.env): DownloadLinks {
  const value = (key: string) => (typeof env[key] === "string" ? (env[key] as string).trim() : "");
  return { mac: value("VITE_MAC_DOWNLOAD_URL"), chromeExtension: value("VITE_CHROME_EXTENSION_URL") };
}

export interface PrimaryDownload {
  /** Desktop download when one exists for this platform, otherwise the web app. */
  kind: "desktop" | "web";
  label: string;
  note: string;
}

export function primaryDownload(platform: VisitorPlatform, links: DownloadLinks): PrimaryDownload {
  if (platform === "mac" && links.mac) return { kind: "desktop", label: "Download for macOS", note: "Apple Silicon and Intel" };
  if (platform === "mac") return { kind: "web", label: "Open the web app", note: "The Mac app is coming soon. Margin Chat runs in your browser today." };
  if (platform === "ios" || platform === "android") return { kind: "web", label: "Open the web app", note: "Runs in your phone's browser. Add it to your Home Screen." };
  if (platform === "windows" || platform === "linux") return { kind: "web", label: "Open the web app", note: `The ${PLATFORM_LABELS[platform]} app is coming soon. Margin Chat runs in your browser today.` };
  return { kind: "web", label: "Open the web app", note: "Works in any modern browser." };
}
