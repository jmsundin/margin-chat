import { useEffect } from "react";

/**
 * Saves what the workspace looks like, so the next time the app opens, index.html paints it straight away
 * (client/build/boot-snapshot.mjs) while the app's code loads and the documents are read, instead of a blank
 * screen. It is a picture only: it can't be clicked, and it goes as soon as the real workspace shows.
 */
const KEY = "margin-chat-boot-snapshot";
// Safari keeps about five megabytes of localStorage per site, two bytes a character, shared with everything
// else saved there. A big workspace is cut down until it fits rather than not shown at all.
const MAX_LENGTH = 600_000;
// Long documents and lists show only their start on screen; a second, smaller try keeps less of each.
const CHILD_LIMITS = [120, 30];
const SETTLE_MS = 1500;
const REFRESH_MS = 2 * 60 * 1000;
const DROP = "script, canvas, video, audio, iframe, object, embed, dialog, [role='dialog'], [role='menu'], [aria-modal], "
  + ".workspace-notifications, .selection-tooltip, .selection-mobile-composer, .cm-cursorLayer";
// The picture sits after the app in the page, so the app's own lookups find its real elements first. Until those
// exist, nothing in the picture may answer for them: ids and the attributes the app looks elements up by go.
const LOOKUP_ATTRIBUTES = ["id", "autofocus", "data-dictation-slot", "data-testid", "data-document-id", "data-document-tab-id", "data-margin-note-tree-node"];

const keyFor = (userId: string) => `${KEY}:${userId}`;
const stylesheetStem = (href: string) => href.replace(/^.*\//u, "").replace(/-[A-Za-z0-9_-]{8}\.css$/u, "");

export function captureBootSnapshot(root: ParentNode, stylesheets: readonly string[]) {
  if (!root.querySelector(".app-shell:not(.is-vault-opening)")) return null;
  const styles = [...new Set(stylesheets.filter((href) => /\/assets\/[^/]+\.css$/u.test(href)).map(stylesheetStem))];
  for (const [attempt, limit] of CHILD_LIMITS.entries()) {
    const copy = document.createElement("div");
    for (const child of Array.from(root.childNodes)) copy.appendChild(child.cloneNode(true));
    for (const element of Array.from(copy.querySelectorAll(DROP))) element.remove();
    // Pictures from this session's memory are gone after a restart.
    for (const image of Array.from(copy.querySelectorAll("img"))) if (/^blob:/u.test(image.getAttribute("src") ?? "")) image.remove();
    // Drawings and large Map views are mostly SVG; the smaller try leaves their space empty.
    if (attempt) for (const drawing of Array.from(copy.querySelectorAll("svg"))) if (drawing.outerHTML.length > 4000) drawing.remove();
    for (const element of Array.from(copy.querySelectorAll("*"))) {
      while (element.childElementCount > limit) element.lastElementChild!.remove();
      for (const name of LOOKUP_ATTRIBUTES) element.removeAttribute(name);
    }
    const html = copy.innerHTML;
    if (html && html.length <= MAX_LENGTH) return { html, styles };
  }
  return null;
}

export function saveBootSnapshot(userId: string) {
  const root = document.getElementById("root");
  if (!root) return;
  const stylesheets = Array.from(document.querySelectorAll<HTMLLinkElement>("link[rel='stylesheet']"), (link) => link.getAttribute("href") ?? "");
  const snapshot = captureBootSnapshot(root, stylesheets);
  try {
    // The old picture goes first, so its room is free for the new one.
    localStorage.removeItem(keyFor(userId));
    if (snapshot) localStorage.setItem(keyFor(userId), JSON.stringify({ ...snapshot, savedAt: Date.now() }));
  } catch {
    // Full storage: the page shows the splash screen instead.
  }
}

export function forgetBootSnapshot(userId: string) {
  try { localStorage.removeItem(keyFor(userId)); } catch { /* Storage is unavailable. */ }
}

/** Keeps the saved picture current: shortly after the documents show, now and then, and whenever the app is put away. */
export function useBootSnapshot(userId: string, ready: boolean, enabled: boolean) {
  useEffect(() => {
    if (!ready || !enabled) return;
    const save = () => saveBootSnapshot(userId);
    const hidden = () => { if (document.visibilityState === "hidden") save(); };
    const settle = window.setTimeout(save, SETTLE_MS);
    const refresh = window.setInterval(() => { if (document.visibilityState === "visible") save(); }, REFRESH_MS);
    document.addEventListener("visibilitychange", hidden);
    window.addEventListener("pagehide", save);
    return () => {
      window.clearTimeout(settle);
      window.clearInterval(refresh);
      document.removeEventListener("visibilitychange", hidden);
      window.removeEventListener("pagehide", save);
    };
  }, [userId, ready, enabled]);
}
