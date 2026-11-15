import { useEffect, useState } from "react";

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
