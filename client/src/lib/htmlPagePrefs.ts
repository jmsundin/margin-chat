import { useCallback, useEffect, useState, useSyncExternalStore } from "react";

/**
 * How one HTML page is shown, chosen per page and remembered on this device: whether it fills the
 * panel or flows inline with notes, and whether it follows the app's theme or is pinned to one.
 */
export type HtmlPageLayout = "fill" | "inline";
export type HtmlPageTheme = "auto" | "light" | "dark";
export interface HtmlPagePrefs { layout: HtmlPageLayout; theme: HtmlPageTheme }

export const DEFAULT_HTML_PAGE_PREFS: HtmlPagePrefs = { layout: "fill", theme: "auto" };
const key = (documentId: string) => `margin-chat:html-page-prefs:${documentId}`;

export function readHtmlPagePrefs(value: unknown): HtmlPagePrefs {
  const prefs = value && typeof value === "object" ? value as Record<string, unknown> : {};
  return {
    layout: prefs.layout === "inline" ? "inline" : "fill",
    theme: prefs.theme === "light" || prefs.theme === "dark" ? prefs.theme : "auto",
  };
}

export function loadHtmlPagePrefs(documentId: string): HtmlPagePrefs {
  try { return readHtmlPagePrefs(JSON.parse(localStorage.getItem(key(documentId)) ?? "null")); } catch { return DEFAULT_HTML_PAGE_PREFS; }
}

export function saveHtmlPagePrefs(documentId: string, prefs: HtmlPagePrefs) {
  try {
    if (prefs.layout === DEFAULT_HTML_PAGE_PREFS.layout && prefs.theme === DEFAULT_HTML_PAGE_PREFS.theme) localStorage.removeItem(key(documentId));
    else localStorage.setItem(key(documentId), JSON.stringify(prefs));
  } catch { /* The choice lasts while the page is open. */ }
}

// The panel around a page and the page's own view both follow the choice, so a change in one reaches the other at once.
const listeners = new Set<() => void>();
const cache = new Map<string, HtmlPagePrefs>();
const current = (documentId: string) => {
  let prefs = cache.get(documentId);
  if (!prefs) { prefs = loadHtmlPagePrefs(documentId); cache.set(documentId, prefs); }
  return prefs;
};

/** A page's remembered look, and a way to change it. */
export function useHtmlPagePrefs(documentId: string): [HtmlPagePrefs, (prefs: HtmlPagePrefs) => void] {
  const prefs = useSyncExternalStore(
    (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    () => current(documentId), () => DEFAULT_HTML_PAGE_PREFS);
  const set = useCallback((next: HtmlPagePrefs) => {
    cache.set(documentId, readHtmlPagePrefs(next));
    saveHtmlPagePrefs(documentId, next);
    for (const listener of listeners) listener();
  }, [documentId]);
  return [prefs, set];
}

/** The theme a page is given: its own pinned choice, otherwise the app's. */
export function htmlPageTheme(choice: HtmlPageTheme, app: "light" | "dark"): "light" | "dark" {
  return choice === "auto" ? app : choice;
}

const appTheme = (): "light" | "dark" => typeof document !== "undefined" && (document.documentElement.dataset.theme === "dark"
  || (!document.documentElement.dataset.theme && window.matchMedia?.("(prefers-color-scheme: dark)").matches)) ? "dark" : "light";

/** The app's theme now, and again whenever it changes (the app's own switch, or the device's when the app follows it). */
export function useAppTheme(): "light" | "dark" {
  const [theme, setTheme] = useState(appTheme);
  useEffect(() => {
    const update = () => setTheme(appTheme());
    const observer = new MutationObserver(update);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    const media = window.matchMedia?.("(prefers-color-scheme: dark)");
    media?.addEventListener?.("change", update);
    update();
    return () => { observer.disconnect(); media?.removeEventListener?.("change", update); };
  }, []);
  return theme;
}

/** Whether the window is phone sized, where a page always fills. */
export function useSmallScreen(): boolean {
  const [small, setSmall] = useState(() => typeof window !== "undefined" && Boolean(window.matchMedia?.("(max-width: 640px)").matches));
  useEffect(() => {
    const media = window.matchMedia?.("(max-width: 640px)");
    if (!media) return;
    const update = () => setSmall(media.matches);
    media.addEventListener?.("change", update);
    update();
    return () => media.removeEventListener?.("change", update);
  }, []);
  return small;
}

/** Phones always fill: a page flowing inline with notes leaves it a strip of a small screen. */
export function useHtmlPageLayout(choice: HtmlPageLayout): HtmlPageLayout {
  return useSmallScreen() ? "fill" : choice;
}
