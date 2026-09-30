import { useEffect, useState } from "react";
import { acknowledgeVersion, readAcknowledgedVersion, watchAppUpdates } from "../lib/appUpdates";
import { listenForAppRestart, requestAppRestart } from "../lib/appUpdateRestart";

export default function AppUpdateNotice({ commit }: { commit: string }) {
  const [previous] = useState(readAcknowledgedVersion);
  const [open, setOpen] = useState(previous !== commit);
  const [waiting, setWaiting] = useState<ServiceWorker | null>(null);
  const [dismissedWorker, setDismissedWorker] = useState<ServiceWorker | null>(null);
  const [restarting, setRestarting] = useState(false);
  const [restartStatus, setRestartStatus] = useState<string | null>(null);
  const [restartError, setRestartError] = useState<string | null>(null);
  const hasUpdate = waiting !== null && waiting !== dismissedWorker;
  const version = commit === "unknown" ? "unavailable" : commit.slice(0, 7);

  useEffect(() => watchAppUpdates(setWaiting), []);
  useEffect(() => listenForAppRestart(setRestartStatus, setRestartError), []);

  const restart = async () => {
    if (!waiting || restarting) return;
    setRestarting(true);
    setRestartError(null);
    try { await requestAppRestart(waiting); }
    catch (error) { setRestartError(error instanceof Error ? error.message : "Please try again."); }
    finally { setRestarting(false); }
  };

  const dismiss = () => {
    acknowledgeVersion(commit);
    setOpen(false);
    setDismissedWorker(waiting);
  };

  return (
    <aside className="app-update-notice" data-app-update-notice aria-label="App version">
      {open || hasUpdate || restartStatus ? (
        <div className="app-update-card">
          <div role="status" aria-live="polite">
            <strong>{waiting ? "Update ready" : previous && previous !== commit ? "App updated" : "App version loaded"}</strong>
            <p>Loaded version <code title={commit}>{version}</code>.</p>
            {waiting && <p>Restart all open tabs to use the update. Your saved work will reopen.</p>}
            {restartStatus && <p>{restartStatus}</p>}
            {restartError && <p role="alert">{restartError}</p>}
            {waiting && <button className="app-update-restart" type="button" disabled={restarting || !!restartStatus} onClick={() => { void restart(); }}>
              {restarting ? "Preparing restart…" : "Restart now"}
            </button>}
          </div>
          <button type="button" onClick={dismiss} aria-label="Dismiss update notification">×</button>
        </div>
      ) : (
        <button className="app-version-button" type="button" title={`Loaded commit: ${commit}`} onClick={() => setOpen(true)}>
          {waiting ? "Update ready · " : ""}Version {version}
        </button>
      )}
    </aside>
  );
}
