export const APP_VERSION_STORAGE_KEY = "marginchat-acknowledged-app-version";
export const UPDATE_CHECK_INTERVAL = 5 * 60 * 1000;

export function readAcknowledgedVersion(): string | null {
  try { return window.localStorage.getItem(APP_VERSION_STORAGE_KEY); }
  catch { return null; }
}

export function acknowledgeVersion(commit: string) {
  try { window.localStorage.setItem(APP_VERSION_STORAGE_KEY, commit); }
  catch { /* Notifications still work when storage is unavailable. */ }
}

// Download in the background; activation requires a coordinated restart or closed tabs.
export function watchAppUpdates(onWaiting: (worker: ServiceWorker) => void): () => void {
  if (!("serviceWorker" in navigator)) return () => {};
  let stopped = false;
  let disposeRegistration = () => {};

  const start = () => {
    void navigator.serviceWorker.register("/sw.js", { updateViaCache: "none" })
      .then((registration) => {
        if (stopped) return;
        const listeners = new Map<ServiceWorker, () => void>();
        const reportWaiting = () => {
          if (registration.waiting) onWaiting(registration.waiting);
        };
        const observeInstalling = () => {
          reportWaiting();
          const worker = registration.installing;
          if (!worker || listeners.has(worker)) return;
          const changed = () => {
            if (worker.state === "installed" && registration.active) onWaiting(worker);
          };
          listeners.set(worker, changed);
          worker.addEventListener("statechange", changed);
          changed();
        };
        let checking = false;
        const check = async () => {
          if (document.visibilityState !== "visible" || !navigator.onLine || checking) return;
          checking = true;
          try { await registration.update(); }
          catch { /* Offline and failed checks can retry on the next interval. */ }
          finally { checking = false; }
        };
        registration.addEventListener("updatefound", observeInstalling);
        observeInstalling();
        document.addEventListener("visibilitychange", check);
        window.addEventListener("online", check);
        const interval = window.setInterval(check, UPDATE_CHECK_INTERVAL);
        disposeRegistration = () => {
          window.clearInterval(interval);
          document.removeEventListener("visibilitychange", check);
          window.removeEventListener("online", check);
          registration.removeEventListener("updatefound", observeInstalling);
          for (const [worker, listener] of listeners) worker.removeEventListener("statechange", listener);
        };
      })
      .catch((error) => console.warn("Offline application caching is unavailable.", error));
  };
  if (document.readyState === "complete") start();
  else window.addEventListener("load", start, { once: true });
  return () => {
    stopped = true;
    window.removeEventListener("load", start);
    disposeRegistration();
  };
}
