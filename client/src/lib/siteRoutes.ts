export type MarketingPage = "home" | "pricing" | "download" | "connect" | "terms" | "privacy";
export type AuthPageMode = "login" | "signup";

export type SiteRoute =
  | { kind: "marketing"; page: MarketingPage }
  | { kind: "auth"; mode: AuthPageMode }
  // An MCP connector (ChatGPT, claude.ai) asking the member to approve it.
  | { kind: "oauth" }
  | { kind: "app" };

export const MARKETING_PATHS: Record<MarketingPage, string> = { home: "/", pricing: "/pricing", download: "/download", connect: "/connect", terms: "/terms", privacy: "/privacy" };
// Shown on the legal pages, the site footer, Settings and the sign-in screen.
export const SUPPORT_EMAIL = "support@marginchat.com";
// Shown on the setup guides. The www host matters: some connectors refuse to follow redirects.
export const MCP_SERVER_URL = "https://www.marginchat.com/api/mcp";
export const AUTH_PATHS: Record<AuthPageMode, string> = { login: "/login", signup: "/signup" };

interface RouteLocation { pathname: string; search: string; protocol: string }

// The extension and the desktop app open straight into sign-in; only the website shows the marketing pages.
export function resolveSiteRoute(location: RouteLocation, embedded = false): SiteRoute {
  if (embedded || location.protocol === "margin:") return { kind: "app" };
  const path = location.pathname.replace(/\/+$/, "") || "/";
  if (path === "/pricing") return { kind: "marketing", page: "pricing" };
  if (path === "/download") return { kind: "marketing", page: "download" };
  if (path === "/connect") return { kind: "marketing", page: "connect" };
  if (path === "/terms") return { kind: "marketing", page: "terms" };
  if (path === "/privacy") return { kind: "marketing", page: "privacy" };
  if (path === "/login") return { kind: "auth", mode: "login" };
  if (path === "/signup") return { kind: "auth", mode: "signup" };
  if (path === "/oauth/authorize") return { kind: "oauth" };
  // Query strings carry reset tokens, Stripe returns and capture handoffs, which all need the app.
  if (path === "/" && !location.search) return { kind: "marketing", page: "home" };
  return { kind: "app" };
}
