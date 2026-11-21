import { useState } from "react";
import { checkForAppUpdate, readDesktopAppVersion, useReadyUpdate, type UpdateCheckResult } from "../lib/appUpdateCheck";
import { isDesktopApp } from "../lib/platform";

/** Settings → Updates: which version this is, and a button to get the newest one now. */
export function UpdateSettings({ commit = import.meta.env.VITE_APP_COMMIT }: { commit?: string }) {
  const ready = useReadyUpdate();
  const [checking, setChecking] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [result, setResult] = useState<UpdateCheckResult | null>(null);
  const [appVersion, setAppVersion] = useState(readDesktopAppVersion);
  const desktop = isDesktopApp();
  const build = commit && commit !== "unknown" ? commit.slice(0, 7) : "development";

  async function check() {
    setChecking(true);
    try {
      setResult(await checkForAppUpdate(commit));
      setAppVersion(readDesktopAppVersion());
    } finally { setChecking(false); }
  }

  async function restart() {
    if (!ready) return;
    setRestarting(true);
    try { await ready.restart(); }
    finally { setRestarting(false); }
  }

  const status = ready ? "A new version is ready. Updating saves your work and restarts the app."
    : !result ? null
    : result.status === "latest" ? "You're on the latest version."
    : result.status === "manual" ? `Margin Chat ${result.version} is out. This copy can't update itself, so download it once.`
    : result.status === "offline" ? "You're offline. Connect to the internet and check again."
    : result.status === "automatic" ? "This copy of the app updates itself in the background. Install the newest app once to check from here."
    : result.status === "unavailable" ? "This build doesn't get updates."
    : result.status === "failed" ? result.message
    : null;

  return (
    <div className="app-settings-body">
      <div className="app-settings-section update-settings">
        <div className="app-settings-copy">
          <span className="app-settings-label">{desktop && appVersion ? `Margin Chat ${appVersion}` : "Margin Chat"}</span>
          <p className="app-settings-description">
            Version {build}. New versions download by themselves and install when you're away.
          </p>
          {status ? <p className={`app-settings-description update-settings-status${ready ? " is-ready" : result?.status === "failed" ? " is-error" : ""}`}
            role="status">{status}</p> : null}
        </div>
        {ready ? (
          <button className="thread-dialog-button is-primary" disabled={restarting} onClick={() => void restart()} type="button">
            {restarting ? "Updating…" : "Update now"}
          </button>
        ) : result?.status === "manual" && result.downloadUrl ? (
          <a className="thread-dialog-button is-primary" href={result.downloadUrl} rel="noreferrer" target="_blank">Download</a>
        ) : (
          <button className="thread-dialog-button" disabled={checking} onClick={() => void check()} type="button">
            {checking ? "Checking…" : "Check for updates"}
          </button>
        )}
      </div>
    </div>
  );
}
