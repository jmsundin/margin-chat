export type MarketingPage = "home" | "pricing" | "download";
export type AuthPageMode = "login" | "signup";

export type SiteRoute =
  | { kind: "marketing"; page: MarketingPage }
  | { kind: "auth"; mode: AuthPageMode }
  | { kind: "app" };

export const MARKETING_PATHS: Record<MarketingPage, string> = { home: "/", pricing: "/pricing", download: "/download" };
export const AUTH_PATHS: Record<AuthPageMode, string> = { login: "/login", signup: "/signup" };

interface RouteLocation { pathname: string; search: string; protocol: string }

// The extension and the desktop app open straight into sign-in; only the website shows the marketing pages.
export function resolveSiteRoute(location: RouteLocation, embedded = false): SiteRoute {
  if (embedded || location.protocol === "margin:") return { kind: "app" };
  const path = location.pathname.replace(/\/+$/, "") || "/";
  if (path === "/pricing") return { kind: "marketing", page: "pricing" };
  if (path === "/download") return { kind: "marketing", page: "download" };
  if (path === "/login") return { kind: "auth", mode: "login" };
  if (path === "/signup") return { kind: "auth", mode: "signup" };
  // Query strings carry reset tokens, Stripe returns and capture handoffs, which all need the app.
  if (path === "/" && !location.search) return { kind: "marketing", page: "home" };
  return { kind: "app" };
}
