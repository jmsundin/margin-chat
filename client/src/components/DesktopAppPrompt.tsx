import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  claimAutoOpen, desktopAppLink, launchDesktopApp, readDesktopPreference, saveDesktopPreference, shouldOfferDesktopApp,
  type LaunchWatch,
} from "../lib/desktopHandoff";
import {
  detectVisitorPlatform, downloadHref, fetchDesktopRelease, isDesktopApp, primaryDownload, readDownloadLinks, withDesktopRelease,
} from "../lib/platform";
import "./DesktopAppPrompt.css";

type PromptState = "hidden" | "offer" | "opening" | "opened" | "not-opened";

/**
 * On a computer the desktop app is the default: the web workspace offers it,
 * and opens it by itself for someone who chose it. The workspace stays fully
 * usable underneath, and "Use the browser" puts the offer away for good.
 */
export default function DesktopAppPrompt() {
  const [state, setState] = useState<PromptState>("hidden");
  const [installer, setInstaller] = useState<string | null>(null);
  const launch = useRef<LaunchWatch | null>(null);

  // Forgets a launch still being watched, so its result can't change the prompt later.
  const stopWatching = () => {
    const watch = launch.current;
    launch.current = null;
    watch?.cancel();
  };

  const open = (auto: boolean) => {
    stopWatching();
    setState("opening");
    const watch = launchDesktopApp(desktopAppLink(window.location.pathname));
    launch.current = watch;
    void watch.done.then((opened) => {
      if (launch.current !== watch) return;
      launch.current = null;
      if (opened) saveDesktopPreference("app");
      // A quiet automatic try that went nowhere shouldn't nag; the offer comes back instead.
      setState(opened ? "opened" : auto ? "offer" : "not-opened");
    });
  };

  useEffect(() => {
    const preference = readDesktopPreference();
    if (preference === "web") return;
    const platform = detectVisitorPlatform();
    const base = { platform, inDesktopApp: isDesktopApp(), inExtension: false, search: window.location.search };
    // Nothing to check for on a phone, in the app, or after a one-time link.
    if (!shouldOfferDesktopApp({ ...base, hasInstaller: true })) return;
    let active = true;
    void fetchDesktopRelease().then((release) => {
      if (!active) return;
      const download = primaryDownload(platform, withDesktopRelease(readDownloadLinks(), release));
      if (!shouldOfferDesktopApp({ ...base, hasInstaller: download.kind === "desktop" && Boolean(download.href) })) return;
      setInstaller(download.href ?? null);
      if (preference === "app" && claimAutoOpen()) open(true);
      else setState("offer");
    });
    return () => {
      active = false;
      stopWatching();
    };
  }, []);

  if (state === "hidden") return null;

  const useBrowser = () => {
    stopWatching();
    saveDesktopPreference("web");
    setState("hidden");
  };
  const download = installer
    ? <a className="desktop-app-prompt-button" href={downloadHref(installer, "app-prompt")} onClick={() => saveDesktopPreference(null)}>Download the app</a>
    : null;

  let message: string;
  let actions: ReactNode;
  if (state === "opening") {
    message = "Opening Margin Chat in the desktop app…";
    actions = <button className="desktop-app-prompt-button" onClick={() => { stopWatching(); setState("hidden"); }} type="button">Stay in the browser</button>;
  } else if (state === "opened") {
    message = "Margin Chat opened in the desktop app. You can close this tab.";
    actions = <>
      <button className="desktop-app-prompt-button" onClick={() => setState("hidden")} type="button">Keep this tab</button>
      <button className="desktop-app-prompt-button is-quiet" onClick={useBrowser} type="button">Always use the browser here</button>
    </>;
  } else if (state === "not-opened") {
    message = "The desktop app didn’t open. If it isn’t on this computer yet, download it once and it keeps itself up to date.";
    actions = <>
      {download}
      <button className="desktop-app-prompt-button" onClick={() => open(false)} type="button">Try again</button>
      <button className="desktop-app-prompt-button is-quiet" onClick={useBrowser} type="button">Use the browser</button>
    </>;
  } else {
    message = "Margin Chat works best in the desktop app on this computer: your vault is a folder here and it works offline.";
    actions = <>
      <button className="desktop-app-prompt-button is-primary" onClick={() => open(false)} type="button">Open the app</button>
      {download}
      <button className="desktop-app-prompt-button is-quiet" onClick={useBrowser} type="button">Use the browser</button>
    </>;
  }

  return (
    <div className="desktop-app-prompt" role="status" aria-live="polite">
      <p>{message}</p>
      <div className="desktop-app-prompt-actions">{actions}</div>
    </div>
  );
}
