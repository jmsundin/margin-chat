import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import NotificationToast from "./NotificationToast";
import { acknowledgeVersion, readAcknowledgedVersion, watchAppUpdates } from "../lib/appUpdates";
import { listenForAppRestart, requestAppRestart } from "../lib/appUpdateRestart";

export default function AppUpdateNotice({ commit }: { commit: string }) {
  const [previous] = useState(readAcknowledgedVersion);
  const [showLoadedVersion, setShowLoadedVersion] = useState(previous !== commit);
  const [waiting, setWaiting] = useState<ServiceWorker | null>(null);
  const [restarting, setRestarting] = useState(false);
  const [restartStatus, setRestartStatus] = useState<string | null>(null);
  const [restartError, setRestartError] = useState<string | null>(null);
  const [notificationHost, setNotificationHost] = useState<HTMLElement | null>(null);
  const version = commit === "unknown" ? "unavailable" : commit.slice(0, 7);

  useEffect(() => watchAppUpdates(setWaiting), []);
  useEffect(() => listenForAppRestart(setRestartStatus, setRestartError), []);

  useEffect(() => {
    const fallback = document.createElement("div");
    fallback.className = "app-version-toast-host";
    document.body.appendChild(fallback);
    setNotificationHost(fallback);

    const attachToAppNotifications = () => {
      const appNotifications = document.querySelector<HTMLElement>(".workspace-notifications");
      if (!appNotifications) return false;
      setNotificationHost(appNotifications);
      fallback.remove();
      return true;
    };
    if (attachToAppNotifications()) return () => fallback.remove();

    const observer = new MutationObserver(() => {
      if (attachToAppNotifications()) observer.disconnect();
    });
    observer.observe(document.body, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
      fallback.remove();
    };
  }, []);

  const restart = async () => {
    if (!waiting || restarting) return;
    setRestarting(true);
    setRestartError(null);
    try { await requestAppRestart(waiting); }
    catch (error) { setRestartError(error instanceof Error ? error.message : "Please try again."); }
    finally { setRestarting(false); }
  };

  if (!notificationHost) return null;
  return createPortal(
    <>
      {showLoadedVersion && <NotificationToast
        message={`${previous ? "App updated" : "App version"} · ${version}`}
        kind="success"
        onDismiss={() => {
          acknowledgeVersion(commit);
          setShowLoadedVersion(false);
        }}
      />}
      {waiting && <NotificationToast
        message={restartError ?? restartStatus ?? `Update ready · currently loaded version ${version}`}
        kind={restartError ? "error" : "info"}
        action={!restartError && !restartStatus ? {
          label: restarting ? "Preparing restart…" : "Restart now",
          onClick: restart,
        } : undefined}
      />}
    </>,
    notificationHost,
  );
}
