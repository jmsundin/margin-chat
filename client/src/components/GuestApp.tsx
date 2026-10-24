import { lazy, Suspense, useEffect, useState, type Dispatch, type SetStateAction } from "react";
import { setApiTransport } from "../lib/apiTransport";
import { createGuestTransport, createGuestUser, SIGN_UP_NUDGE } from "../lib/guestMode";
import { onDeviceSession, onDeviceStatus, onDownloadProgress, type OnDeviceStatus } from "../lib/onDeviceAI";
import { AUTH_PATHS } from "../lib/siteRoutes";
import type { ThemeMode } from "../lib/appearance";
import "./GuestApp.css";

const WorkspaceApp = lazy(() => import("../WorkspaceApp"));
const HIDDEN_KEY = "margin-chat:guest-bar-hidden";
const goToSignUp = () => window.location.assign(AUTH_PATHS.signup);
const needsAccount = () => Promise.reject(new Error(SIGN_UP_NUDGE));

function readHidden() {
  try { return window.sessionStorage.getItem(HIDDEN_KEY) === "1"; } catch { return false; }
}

/** What the trial bar says about AI, short enough for a phone and longer on a computer. */
function aiNote(status: OnDeviceStatus | "checking", progress: number | null): { short: string; long: string } {
  if (status === "checking") return { short: "Checking AI…", long: "Checking whether Chrome’s built-in AI can run here…" };
  if (status === "available") return { short: "AI runs on this computer", long: "AI runs in Chrome on this computer. Nothing you write leaves this browser." };
  if (status === "downloading") {
    const percent = progress === null ? "" : ` ${Math.round(progress * 100)}%`;
    return { short: `Downloading AI…${percent}`, long: `Chrome is downloading its built-in AI model…${percent} You can keep writing.` };
  }
  if (status === "downloadable") return { short: "AI needs a one-time download", long: "AI runs in Chrome on this computer after a one-time download of its built-in model (a few GB)." };
  if (status === "unavailable") return { short: "AI isn’t available here", long: "Writing, notes and the Map work here. This computer can’t run Chrome’s built-in AI." };
  return { short: "AI on computers only", long: "Writing, notes and the Map work here. AI in the trial needs Chrome on a computer." };
}

function GuestBar() {
  const [hidden, setHidden] = useState(readHidden);
  const [status, setStatus] = useState<OnDeviceStatus | "checking">("checking");
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    void onDeviceStatus().then((value) => { if (active) setStatus(value); });
    const stop = onDownloadProgress((fraction) => {
      setProgress(fraction);
      setStatus(fraction >= 1 ? "available" : "downloading");
    });
    return () => { active = false; stop(); };
  }, []);
  // Hiding the bar gives its height back to the workspace.
  useEffect(() => {
    document.documentElement.classList.toggle("has-guest-bar", !hidden);
    return () => document.documentElement.classList.remove("has-guest-bar");
  }, [hidden]);

  function setUpAI() {
    setError(null);
    setStatus("downloading");
    // Called straight from the click: Chrome only starts the download with one.
    onDeviceSession().then(() => setStatus("available"), (reason) => {
      setError(reason instanceof Error ? reason.message : "Chrome couldn’t download its AI model.");
      void onDeviceStatus().then(setStatus);
    });
  }

  if (hidden) return null;
  const note = aiNote(status, progress);
  return (
    <div className="guest-bar" role="region" aria-label="Free trial">
      <strong className="guest-bar-label">Free trial</strong>
      <span className="guest-bar-note" title={error ?? note.long}>
        <span className="guest-bar-long">{error ?? note.long}</span>
        <span className="guest-bar-short">{note.short}</span>
      </span>
      {status === "downloadable" && <button type="button" className="guest-bar-button" onClick={setUpAI}>Set up AI</button>}
      <a className="guest-bar-link guest-bar-login" href={AUTH_PATHS.login}>Log in</a>
      <a className="guest-bar-button is-primary" href={AUTH_PATHS.signup}>Sign up free</a>
      <button type="button" className="guest-bar-close" aria-label="Hide the trial bar" onClick={() => {
        setHidden(true);
        try { window.sessionStorage.setItem(HIDDEN_KEY, "1"); } catch { /* Hidden until the page reloads. */ }
      }}>×</button>
    </div>
  );
}

/**
 * The workspace for visitors without an account, at /try. Nothing is sent to the server:
 * the guest transport answers every API call in the browser, documents stay in this
 * browser's storage, and Ask AI runs on Chrome's built-in model.
 */
export default function GuestApp({ theme, onSetTheme }: { theme: ThemeMode; onSetTheme: Dispatch<SetStateAction<ThemeMode>> }) {
  // Installed before the workspace renders, so its first request is answered here too.
  const [user] = useState(() => {
    setApiTransport(createGuestTransport());
    return createGuestUser();
  });
  return (
    <>
      <GuestBar />
      <Suspense fallback={<div className="app-shell" aria-busy="true" />}>
        <WorkspaceApp
          storageNamespace={user.id}
          user={user}
          theme={theme}
          onSetTheme={onSetTheme}
          billingNotice={null}
          billingDashboard={null}
          billingDashboardLoading={false}
          billingDashboardError={null}
          billingOpenRequest={0}
          billingErrorMessage={null}
          billingSubmitting={false}
          onRefreshBilling={() => undefined}
          onDismissBillingNotice={() => undefined}
          onAuthExpired={goToSignUp}
          onBillingRequired={goToSignUp}
          onAddMoney={goToSignUp}
          onManageBilling={goToSignUp}
          onStartSubscription={goToSignUp}
          onUpgradeToPlus={goToSignUp}
          onLogout={goToSignUp}
          onUpdateProfile={needsAccount}
          onChangePassword={needsAccount}
          onDeleteAccount={needsAccount}
          onUpdateApiKeys={needsAccount}
        />
      </Suspense>
    </>
  );
}
