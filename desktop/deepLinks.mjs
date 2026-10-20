// marginchat:// links open the desktop app from the website and from other apps,
// so the app can be the default for Margin Chat on a computer where it is installed.
export const DEEP_LINK_SCHEME = "marginchat";

const WEBSITE_HOSTS = new Set(["marginchat.com", "www.marginchat.com"]);
// Website pages that stay in the browser: the marketing site, sign-up and connector consent.
const WEBSITE_ONLY_PATHS = new Set(["/pricing", "/download", "/connect", "/signup", "/oauth/authorize"]);

/** The page inside the app to show: a root-relative path, never another site. */
function appPath(pathname) {
  if (typeof pathname !== "string" || !pathname.startsWith("/") || pathname.startsWith("//")) return null;
  const path = pathname.replace(/\/+$/, "") || "/";
  return WEBSITE_ONLY_PATHS.has(path) ? null : path;
}

/**
 * Where marginchat://open?path=/some/page leads inside the app, as a path on
 * margin://app, or null when the link is not one of ours.
 */
export function pathForDeepLink(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (url.protocol !== `${DEEP_LINK_SCHEME}:`) return null;
  // marginchat://open and marginchat:open both count; anything else just brings the app forward.
  return appPath(url.searchParams.get("path") ?? "/") ?? "/";
}

/**
 * A link to the website's app pages, clicked inside the desktop app, opens in
 * the app. Query strings carry one-time flows (password resets, Stripe
 * returns), which belong to the browser that started them.
 */
export function pathForWebsiteLink(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || !WEBSITE_HOSTS.has(url.hostname) || url.search) return null;
  return appPath(url.pathname);
}

/** Windows and Linux pass the link that launched the app on the command line. */
export function findDeepLink(argv) {
  return argv.find((arg) => typeof arg === "string" && arg.toLowerCase().startsWith(`${DEEP_LINK_SCHEME}:`)) ?? null;
}
