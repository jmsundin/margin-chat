import { expect, test } from "bun:test";
import { detectPlatform, primaryDownload, readDownloadLinks } from "../client/src/lib/platform";
import { resolveSiteRoute } from "../client/src/lib/siteRoutes";

const at = (pathname: string, search = "", protocol = "https:") => ({ pathname, search, protocol });

test("site routes send visitors to marketing, sign-in or the app", () => {
  expect(resolveSiteRoute(at("/"))).toEqual({ kind: "marketing", page: "home" });
  expect(resolveSiteRoute(at("/pricing"))).toEqual({ kind: "marketing", page: "pricing" });
  expect(resolveSiteRoute(at("/download/"))).toEqual({ kind: "marketing", page: "download" });
  expect(resolveSiteRoute(at("/login"))).toEqual({ kind: "auth", mode: "login" });
  expect(resolveSiteRoute(at("/signup"))).toEqual({ kind: "auth", mode: "signup" });
  // Reset links, Stripe returns and capture handoffs carry a query and need the app.
  expect(resolveSiteRoute(at("/", "?reset_token=abc"))).toEqual({ kind: "app" });
  expect(resolveSiteRoute(at("/", "?session_id=cs_test"))).toEqual({ kind: "app" });
  expect(resolveSiteRoute(at("/somewhere"))).toEqual({ kind: "app" });
  // The extension and the desktop app never show the marketing pages.
  expect(resolveSiteRoute(at("/"), true)).toEqual({ kind: "app" });
  expect(resolveSiteRoute(at("/", "", "margin:"))).toEqual({ kind: "app" });
});

test("platform detection reads the user agent", () => {
  expect(detectPlatform("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605.1.15")).toBe("mac");
  expect(detectPlatform("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605.1.15", 5)).toBe("ios");
  expect(detectPlatform("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Safari/604.1")).toBe("ios");
  expect(detectPlatform("Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/140.0 Safari/537.36")).toBe("windows");
  expect(detectPlatform("Mozilla/5.0 (Linux; Android 15; Pixel 9) Chrome/140.0 Mobile Safari/537.36")).toBe("android");
  expect(detectPlatform("Mozilla/5.0 (X11; Linux x86_64) Chrome/140.0 Safari/537.36")).toBe("linux");
  expect(detectPlatform("Mozilla/5.0 (X11; CrOS x86_64 16000.0.0) Chrome/140.0 Safari/537.36")).toBe("chromeos");
  expect(detectPlatform("curl/8.0")).toBe("unknown");
});

test("the main button offers the Mac download only when a build is published", () => {
  const published = readDownloadLinks({ VITE_MAC_DOWNLOAD_URL: " https://downloads.example/Margin.dmg ", VITE_CHROME_EXTENSION_URL: "" });
  expect(published).toEqual({ mac: "https://downloads.example/Margin.dmg", chromeExtension: "" });
  expect(primaryDownload("mac", published)).toMatchObject({ kind: "desktop", label: "Download for macOS" });
  expect(primaryDownload("mac", { mac: "", chromeExtension: "" })).toMatchObject({ kind: "web", label: "Open the web app" });
  expect(primaryDownload("windows", published).kind).toBe("web");
  expect(primaryDownload("windows", published).note).toContain("Windows app is coming soon");
  expect(primaryDownload("ios", published).note).toContain("Home Screen");
});

test("signed-out visitors see the marketing pages and can reach sign-in", async () => {
  const child = Bun.spawn([process.execPath, "tests/helpers/marketingSiteHarness.ts"], {
    cwd: new URL("..", import.meta.url).pathname,
    stdout: "pipe",
    stderr: "pipe",
  });
  const timeout = setTimeout(() => child.kill(), 10000);
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  clearTimeout(timeout);
  if (exitCode !== 0) throw new Error(`Marketing site harness failed:\n${stdout}\n${stderr}`);
  expect(JSON.parse(stdout.trim().split("\n").at(-1)!).result).toBe("pass");
}, 15000);
