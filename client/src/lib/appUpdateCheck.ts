import { useSyncExternalStore } from "react";
import { DESKTOP_UPDATE_EVENT, reloadForDesktopUpdate, type DesktopUpdateKind } from "./appUpdateRestart";
import { isDesktopApp } from "./platform";

/**
 * "Check for updates" in Settings. Updates still download in the background and
 * install at a quiet moment (AppUpdateNotice); this only lets someone look now
 * and install now. AppUpdateNotice publishes the update it holds here, so the
 * toast and Settings restart the same way.
 */
export const DESKTOP_CHECK_UPDATES_PATH = "/__margin/check-updates";

export type ReadyUpdate = { restart: () => Promise<void> };

let ready: ReadyUpdate | null = null;
const listeners = new Set<() => void>();

export function publishReadyUpdate(update: ReadyUpdate | null) {
  ready = update;
  for (const listener of listeners) listener();
}

export function readReadyUpdate() { return ready; }

function subscribeReadyUpdate(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useReadyUpdate() {
  return useSyncExternalStore(subscribeReadyUpdate, readReadyUpdate, () => null);
}

export type UpdateCheckResult =
  | { status: "ready" }
  | { status: "latest" }
  /** A desktop app installed where it can't replace itself (a .deb, or run from the disk image). */
  | { status: "manual"; version: string; downloadUrl: string | null }
  | { status: "offline" }
  /** An installed desktop app from before Check for updates: it still checks by itself. */
  | { status: "automatic" }
  | { status: "unavailable" }
  | { status: "failed"; message: string };

export interface DesktopCheckAnswer {
  appVersion?: unknown;
  clientCommit?: unknown;
  app?: { version?: unknown; manual?: unknown } | null;
  downloadUrl?: unknown;
  errors?: unknown;
}

/** What the desktop app's answer means for this page, running client `ownCommit`. */
export function readDesktopAnswer(answer: DesktopCheckAnswer, ownCommit: string | undefined): {
  result: UpdateCheckResult; kind: DesktopUpdateKind | null; appVersion: string | null;
} {
  const appVersion = typeof answer.appVersion === "string" ? answer.appVersion : null;
  const app = answer.app && typeof answer.app.version === "string" ? answer.app : null;
  if (app && app.manual === true) {
    return { result: { status: "manual", version: app.version as string, downloadUrl: typeof answer.downloadUrl === "string" ? answer.downloadUrl : null }, kind: null, appVersion };
  }
  // A new app wins: it brings its own client.
  if (app) return { result: { status: "ready" }, kind: "app", appVersion };
  const served = typeof answer.clientCommit === "string" ? answer.clientCommit : null;
  if (served && ownCommit && served !== ownCommit) return { result: { status: "ready" }, kind: "client", appVersion };
  const errors = Array.isArray(answer.errors) ? answer.errors.filter((error): error is string => typeof error === "string") : [];
  if (errors.length) return { result: { status: "failed", message: errors[0] }, kind: null, appVersion };
  return { result: { status: "latest" }, kind: null, appVersion };
}

/** The desktop app's version number, or null on the web and in an app that can't say. */
let desktopAppVersion: string | null = null;
export function readDesktopAppVersion() { return desktopAppVersion; }

const waitForReady = (limit: number) => new Promise<boolean>((resolve) => {
  if (ready) { resolve(true); return; }
  const timer = setTimeout(() => { stop(); resolve(Boolean(ready)); }, limit);
  const stop = subscribeReadyUpdate(() => {
    if (!ready) return;
    clearTimeout(timer);
    stop();
    resolve(true);
  });
});

async function checkDesktop(ownCommit: string | undefined): Promise<UpdateCheckResult> {
  const response = await fetch(DESKTOP_CHECK_UPDATES_PATH, { cache: "no-store" });
  // An older app answers with the page itself: it still updates on its own.
  if (!response.ok || !response.headers.get("content-type")?.includes("application/json")) return { status: "automatic" };
  const { result, kind, appVersion } = readDesktopAnswer(await response.json() as DesktopCheckAnswer, ownCommit);
  desktopAppVersion = appVersion;
  if (kind) {
    // The app has told the page already when it downloaded this; say it again
    // in case that was before the page loaded.
    window.dispatchEvent(new CustomEvent(DESKTOP_UPDATE_EVENT, { detail: { kind } }));
    if (!(await waitForReady(1500))) publishReadyUpdate({ restart: () => reloadForDesktopUpdate(() => {}, { kind }) });
  }
  return result;
}

const INSTALL_LIMIT = 2 * 60 * 1000;

function installed(worker: ServiceWorker) {
  return new Promise<boolean>((resolve) => {
    if (worker.state === "installed" || worker.state === "activated") { resolve(true); return; }
    const timer = setTimeout(() => { worker.removeEventListener("statechange", changed); resolve(false); }, INSTALL_LIMIT);
    function changed() {
      if (worker.state === "installing") return;
      clearTimeout(timer);
      worker.removeEventListener("statechange", changed);
      resolve(worker.state === "installed" || worker.state === "activated");
    }
    worker.addEventListener("statechange", changed);
  });
}

async function checkWeb(ownCommit: string | undefined): Promise<UpdateCheckResult> {
  const registration = "serviceWorker" in navigator ? await navigator.serviceWorker.getRegistration("/") : undefined;
  if (!registration) {
    // No offline worker (a development build, or a browser without one): compare with what the site serves.
    if (!ownCommit) return { status: "unavailable" };
    const response = await fetch("/version.json", { cache: "no-store" });
    const latest = response.ok ? (await response.json() as { commit?: unknown }).commit : null;
    if (typeof latest !== "string") return { status: "unavailable" };
    if (latest === ownCommit) return { status: "latest" };
    if (!ready) publishReadyUpdate({ restart: () => reloadForDesktopUpdate(() => {}, { kind: "client" }) });
    return { status: "ready" };
  }
  if (!registration.waiting) {
    await registration.update();
    const worker = registration.installing;
    if (worker && registration.active && !(await installed(worker))) {
      return { status: "failed", message: "The new version didn't finish downloading. Try again in a minute." };
    }
  }
  if (!registration.waiting) return { status: "latest" };
  // AppUpdateNotice sees the waiting worker and publishes its restart.
  return (await waitForReady(3000)) ? { status: "ready" } : { status: "failed", message: "The new version is downloaded but can't start yet. Reload the page to use it." };
}

/** Looks for a newer version now. A found update is published with publishReadyUpdate. */
export async function checkForAppUpdate(ownCommit: string | undefined = import.meta.env.VITE_APP_COMMIT): Promise<UpdateCheckResult> {
  if (typeof navigator !== "undefined" && navigator.onLine === false) return { status: "offline" };
  try {
    if (ready) return { status: "ready" };
    return isDesktopApp() ? await checkDesktop(ownCommit) : await checkWeb(ownCommit);
  } catch (error) {
    if (typeof navigator !== "undefined" && navigator.onLine === false) return { status: "offline" };
    return { status: "failed", message: error instanceof Error && error.message ? error.message : "The check didn't finish. Try again." };
  }
}
