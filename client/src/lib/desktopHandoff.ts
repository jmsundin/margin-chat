import type { VisitorPlatform } from "./platform";

/**
 * On a computer with the desktop app, the desktop app is Margin Chat's default:
 * the website offers to open it, and once someone has chosen it, opens it for
 * them. Phones, tablets, the extension and computers without the app keep the
 * full web app with nothing in the way.
 */
export type DesktopPreference = "app" | "web";

export const DESKTOP_PREFERENCE_KEY = "margin.desktopPreference";
// The app opens by itself once per browser session, so a reload or a second tab stays put.
export const DESKTOP_AUTO_OPENED_KEY = "margin.desktopAutoOpened";
export const DESKTOP_SCHEME = "marginchat";

const DESKTOP_PLATFORMS: readonly VisitorPlatform[] = ["mac", "windows", "linux"];

export interface DesktopOfferContext {
  platform: VisitorPlatform;
  /** Already running inside the desktop app. */
  inDesktopApp: boolean;
  /** Inside the browser extension's frame. */
  inExtension: boolean;
  /** The page's query string. One-time flows (Stripe returns, resets, capture handoffs) finish where they started. */
  search: string;
  /** An installer for this computer has been published. */
  hasInstaller: boolean;
}

export function shouldOfferDesktopApp(context: DesktopOfferContext): boolean {
  if (context.inDesktopApp || context.inExtension || !context.hasInstaller) return false;
  if (!DESKTOP_PLATFORMS.includes(context.platform)) return false;
  return !context.search || context.search === "?";
}

/** The link that opens the desktop app at the same page. */
export function desktopAppLink(pathname: string): string {
  const path = pathname.startsWith("/") && !pathname.startsWith("//") ? pathname : "/";
  return path === "/" ? `${DESKTOP_SCHEME}://open` : `${DESKTOP_SCHEME}://open?path=${encodeURIComponent(path)}`;
}

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function storage(kind: "localStorage" | "sessionStorage"): StorageLike | null {
  try {
    return typeof window === "undefined" ? null : window[kind];
  } catch {
    return null;
  }
}

export function readDesktopPreference(store: StorageLike | null = storage("localStorage")): DesktopPreference | null {
  try {
    const value = store?.getItem(DESKTOP_PREFERENCE_KEY);
    return value === "app" || value === "web" ? value : null;
  } catch {
    return null;
  }
}

export function saveDesktopPreference(preference: DesktopPreference | null, store: StorageLike | null = storage("localStorage")): void {
  try {
    if (preference) store?.setItem(DESKTOP_PREFERENCE_KEY, preference);
    else store?.removeItem(DESKTOP_PREFERENCE_KEY);
  } catch {
    // Private windows can refuse storage; the choice then lasts for this page only.
  }
}

/** True the first time in this browser session, so the app opens by itself once. */
export function claimAutoOpen(store: StorageLike | null = storage("sessionStorage")): boolean {
  try {
    if (!store || store.getItem(DESKTOP_AUTO_OPENED_KEY)) return false;
    store.setItem(DESKTOP_AUTO_OPENED_KEY, "1");
    return true;
  } catch {
    return false;
  }
}

export interface LaunchWatch {
  /** Fires once: true when the page lost focus, which is what an app coming forward does. */
  done: Promise<boolean>;
  cancel(): void;
}

/**
 * Asks the system to open the desktop app. Browsers don't say whether an app
 * answered, so this watches for the page losing focus or being hidden.
 */
export function launchDesktopApp(
  link: string,
  {
    target = typeof window === "undefined" ? undefined : window,
    timeoutMs = 2500,
  }: { target?: Window; timeoutMs?: number } = {},
): LaunchWatch {
  if (!target) return { done: Promise.resolve(false), cancel() {} };
  let finish: (opened: boolean) => void = () => {};
  const done = new Promise<boolean>((resolve) => { finish = resolve; });
  let settled = false;
  const settle = (opened: boolean) => {
    if (settled) return;
    settled = true;
    target.clearTimeout(timer);
    target.removeEventListener("blur", onLeave);
    target.document.removeEventListener("visibilitychange", onLeave);
    finish(opened);
  };
  const onLeave = () => {
    if (target.document.visibilityState === "hidden" || !target.document.hasFocus()) settle(true);
  };
  target.addEventListener("blur", onLeave);
  target.document.addEventListener("visibilitychange", onLeave);
  const timer = target.setTimeout(() => settle(false), timeoutMs);
  target.location.assign(link);
  return { done, cancel: () => settle(false) };
}
