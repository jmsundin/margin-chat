import { useEffect, useState } from "react";
import { forgetOfflineUser } from "./offlineSession";
import { isDesktopApp } from "./platform";

/**
 * The desktop app runs either on its own with no account ("local", docs/desktop-local-mode.md) or signed in
 * to marginchat.com ("account"). The app itself answers these paths and restarts in the other mode.
 */
export type DesktopMode = "local" | "account";
export const DESKTOP_CAPABILITIES_PATH = "/__margin/capabilities";
export const DESKTOP_MODE_PATHS: Record<DesktopMode, string> = { account: "/__margin/use-account", local: "/__margin/use-local" };

/** The mode this desktop app is in, or null on the web and in an app too old to switch (it answers with the page). */
export async function readDesktopMode(fetchImpl: typeof fetch = fetch): Promise<DesktopMode | null> {
  if (!isDesktopApp()) return null;
  try {
    const response = await fetchImpl(DESKTOP_CAPABILITIES_PATH, { cache: "no-store" });
    if (!response.ok || !response.headers.get("content-type")?.includes("application/json")) return null;
    const body = await response.json() as { modes?: unknown; mode?: unknown };
    return body.modes === true && (body.mode === "local" || body.mode === "account") ? body.mode : null;
  } catch {
    return null;
  }
}

export function useDesktopMode() {
  const [mode, setMode] = useState<DesktopMode | null>(null);
  useEffect(() => {
    let active = true;
    void readDesktopMode().then((value) => { if (active) setMode(value); });
    return () => { active = false; };
  }, []);
  return mode;
}

/** Restarts the app in the other mode. Nothing on this computer is deleted: each mode keeps its own data. */
export function switchDesktopMode(mode: DesktopMode) {
  // The person remembered for opening offline belongs to the mode being left; the other mode checks afresh.
  forgetOfflineUser();
  window.location.assign(DESKTOP_MODE_PATHS[mode]);
}
