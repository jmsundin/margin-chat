import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import NotificationToast from "./NotificationToast";
import { acknowledgeVersion, clearRestartForUpdate, markRestartForUpdate, onQuietMoment, readAcknowledgedVersion, readRestartForUpdate, trackFreshStart, watchAppUpdates } from "../lib/appUpdates";
import { listenForAppRestart, listenForDesktopUpdate, reloadForDesktopUpdate, requestAppRestart, type DesktopUpdateKind } from "../lib/appUpdateRestart";

export default function AppUpdateNotice({ commit }: { commit: string }) {
  const [previous] = useState(readAcknowledgedVersion);
  // A new user never sees a version toast; "App updated" confirms only a restart someone asked for.
  const [showLoadedVersion, setShowLoadedVersion] = useState(() => readRestartForUpdate() && previous !== null && previous !== commit);
  const [waiting, setWaiting] = useState<ServiceWorker | null>(null);
  // The desktop app has downloaded an update: a newer client (a reload) or a
  // new version of the app itself (installs on restart), which wins.
  const [desktopReady, setDesktopReady] = useState<DesktopUpdateKind | null>(null);
  const [restarting, setRestarting] = useState(false);
  const [restartStatus, setRestartStatus] = useState<string | null>(null);
  const [restartError, setRestartError] = useState<string | null>(null);
  const [notificationHost, setNotificationHost] = useState<HTMLElement | null>(null);
  const [startedAt] = useState(Date.now);
  const freshStart = useRef<{ isFresh(): boolean } | null>(null);
  const busy = useRef(false);
  const version = commit === "unknown" ? "unavailable" : commit.slice(0, 7);

  useEffect(() => watchAppUpdates(setWaiting), []);
  useEffect(() => listenForAppRestart(setRestartStatus, setRestartError), []);
  useEffect(() => listenForDesktopUpdate((kind) => setDesktopReady((current) => (current === "app" ? current : kind))), []);
  useEffect(() => {
    const tracker = trackFreshStart(Date.now, startedAt);
    freshStart.current = tracker;
    return tracker.stop;
  }, [startedAt]);
  // The loaded-version toast shows once per version, so a reload before it fades does not bring it back.
  useEffect(() => {
    if (previous !== commit) acknowledgeVersion(commit);
    clearRestartForUpdate();
  }, [previous, commit]);

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

  const restart = async (auto = false) => {
    if ((!waiting && !desktopReady) || busy.current) return;
    busy.current = true;
    if (!auto) {
      markRestartForUpdate();
      setRestarting(true);
      setRestartError(null);
    }
    try {
      if (waiting) await requestAppRestart(waiting, { auto });
      else if (desktopReady) await reloadForDesktopUpdate(setRestartStatus, { auto, kind: desktopReady });
    }
    catch (error) {
      // A declined automatic update stays quiet; the toast and the next quiet moment remain.
      if (!auto) setRestartError(error instanceof Error ? error.message : "Please try again.");
    }
    finally {
      busy.current = false;
      if (!auto) setRestarting(false);
    }
  };
  const latestRestart = useRef(restart);
  latestRestart.current = restart;
  const updateReady = Boolean(waiting) || desktopReady !== null;
  useEffect(() => updateReady ? onQuietMoment(() => freshStart.current?.isFresh() ?? false, () => void latestRestart.current(true)) : undefined, [updateReady]);

  if (!notificationHost) return null;
  return createPortal(
    <>
      {showLoadedVersion && <NotificationToast
        message={`App updated · ${version}`}
        kind="success"
        onDismiss={() => setShowLoadedVersion(false)}
      />}
      {updateReady && <NotificationToast
        message={restartError ?? restartStatus ?? `Update ready · currently loaded version ${version}`}
        kind={restartError ? "error" : "info"}
        action={!restartError && !restartStatus ? {
          label: restarting ? "Preparing restart…" : "Restart now",
          onClick: () => void restart(),
        } : undefined}
      />}
    </>,
    notificationHost,
  );
}
