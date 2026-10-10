import { apiStorageNamespace } from "./lib/apiTransport";
import { hasAppUpdateGuard, useAppUpdateGuard } from "./lib/appUpdateSafety";
import type { BrowserCaptureRequest, BrowserThreadRequest } from "./lib/browserWorkspace";
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import AuthLanding from "./components/AuthLanding";
import { loadRichDocumentEditor } from "./components/LazyRichDocumentEditor";
import {
  requestAuthSession, requestBillingDashboard, requestConfirmCheckoutSession, requestCreateBillingPortalSession, requestCreateTopUpSession,
  requestCreateCheckoutSession, requestLogin, requestLogout, requestPasswordReset,
  requestPasswordResetConfirm, requestSignup, requestUpdateApiKeys, requestUpdateProfile, requestChangePassword, ApiError,
} from "./lib/api";
import { rememberOfflineUser, loadOfflineUser, forgetOfflineUser } from "./lib/offlineSession";
import { getNextTheme, loadInitialTheme, syncTheme, THEME_STORAGE_KEY, type ThemeMode } from "./lib/appearance";
import { getCheckoutConfirmationNotice, getCheckoutReturn } from "./lib/billing";
import type { ApiKeyProvider, AuthenticatedUser, BillingDashboardData } from "./types";

// Documents open in the block editor, so fetch its chunk alongside the workspace rather than after it renders.
const WorkspaceApp = lazy(() => {
  void loadRichDocumentEditor();
  return import("./WorkspaceApp");
});
type AuthStatus = "checking" | "authenticated" | "unauthenticated";
const INITIAL_THEME = loadInitialTheme();
syncTheme(INITIAL_THEME);

function getErrorText(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback;
}

export interface AppProps {
  extension?: {
    serverUrl: string;
    userId?: string;
    onConnect(): void;
    onLogout(): Promise<void>;
    openExternal(url: string): void;
  };
  browserCaptureRequest?: BrowserCaptureRequest | null;
  onBrowserCaptureHandled?: (id: string) => void;
  browserThreadRequests?: readonly BrowserThreadRequest[] | null;
  onBrowserThreadHandled?: (request: BrowserThreadRequest) => void;
}

export default function App({ extension, browserCaptureRequest, onBrowserCaptureHandled, browserThreadRequests, onBrowserThreadHandled }: AppProps = {}) {
  // Removing a used reset token must not restart session hydration and race a new login.
  const [hasPasswordResetToken] = useState(() => new URLSearchParams(window.location.search).has("reset_token"));
  const [theme, setTheme] = useState<ThemeMode>(INITIAL_THEME);
  const [authStatus, setAuthStatus] = useState<AuthStatus>("checking");
  const [authUser, setAuthUser] = useState<AuthenticatedUser | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);
  const [authSubmitting, setAuthSubmitting] = useState(false);
  const [billingError, setBillingError] = useState<string | null>(null);
  const [billingSubmitting, setBillingSubmitting] = useState(false);
  const [billingDashboard, setBillingDashboard] = useState<BillingDashboardData | null>(null);
  const [billingDashboardLoading, setBillingDashboardLoading] = useState(false);
  const [billingDashboardError, setBillingDashboardError] = useState<string | null>(null);
  const [billingOpenRequest, setBillingOpenRequest] = useState(0);
  const [checkoutReturn, setCheckoutReturn] = useState(() => getCheckoutReturn(new URLSearchParams(window.location.search)));
  const [billingPortalReturn, setBillingPortalReturn] = useState(() => new URLSearchParams(window.location.search).get("billing") === "return");
  const authUserIdRef = useRef(authUser?.id);
  authUserIdRef.current = authUser?.id;
  const billingRefreshSequence = useRef(0);
  useAppUpdateGuard("app", {
    check: () => {
      if (authStatus === "checking" || authSubmitting || billingSubmitting || (authStatus === "authenticated" && !hasAppUpdateGuard("workspace"))) return "A tab is still opening or completing an account operation. Try again when it finishes.";
      if (authStatus === "unauthenticated" && [...document.querySelectorAll<HTMLInputElement>("form input")].some((input) => input.type !== "hidden" && input.value)) return "Finish or clear the sign-in form in each tab before restarting.";
      return null;
    },
  });

  const refreshBilling = useCallback(async () => {
    const userId = authUserIdRef.current;
    if (!userId) return;
    const sequence = ++billingRefreshSequence.current;
    setBillingDashboardLoading(true);
    setBillingDashboardError(null);
    try {
      const dashboard = await requestBillingDashboard(userId);
      if (authUserIdRef.current !== userId || sequence !== billingRefreshSequence.current) return;
      setBillingDashboard(dashboard);
      if (dashboard.user?.id === userId) {
        rememberOfflineUser(dashboard.user);
        setAuthUser(dashboard.user);
      }
    } catch (error) {
      if (authUserIdRef.current === userId && sequence === billingRefreshSequence.current) {
        setBillingDashboardError(getErrorText(error, "Unable to refresh your billing information."));
      }
    } finally {
      if (authUserIdRef.current === userId && sequence === billingRefreshSequence.current) setBillingDashboardLoading(false);
    }
  }, []);

  const [billingNotice, setBillingNotice] = useState<{
    kind: "error" | "info" | "success";
    message: string;
  } | null>(null);

  useEffect(() => {
    syncTheme(theme);

    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, theme);
    } catch {
      return;
    }
  }, [theme]);

  // Follow a theme chosen in another window of the same origin, such as the
  // extension's settings page or a second app tab.
  useEffect(() => {
    const followStoredTheme = (event: StorageEvent) => {
      if (event.key === THEME_STORAGE_KEY && (event.newValue === "light" || event.newValue === "dark")) setTheme(event.newValue);
    };
    window.addEventListener("storage", followStoredTheme);
    return () => window.removeEventListener("storage", followStoredTheme);
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function hydrateAuthSession() {
      if (hasPasswordResetToken) {
        setAuthUser(null);
        setAuthStatus("unauthenticated");
        setAuthError(null);
        return;
      }

      try {
        if (!navigator.onLine) throw new Error("You are offline. Opening the files saved on this device.");
        const user = await requestAuthSession();
        if (cancelled) {
          return;
        }

        if (extension?.userId && user && user.id !== extension.userId) {
          throw new ApiError(409, "The extension account changed. Reconnect Margin Chat to open this workspace.");
        }
        if (user) rememberOfflineUser(user); else forgetOfflineUser();
        setAuthUser(user);
        setAuthStatus(user ? "authenticated" : "unauthenticated");
        setAuthError(null);
      } catch (error) {
        if (cancelled) {
          return;
        }

        const cachedUser = error instanceof ApiError && [401, 409].includes(error.statusCode) ? null : loadOfflineUser();
        const offlineUser = extension?.userId && cachedUser?.id !== extension.userId ? null : cachedUser;
        setAuthUser(offlineUser);
        setAuthStatus(offlineUser ? "authenticated" : "unauthenticated");
        setAuthError(offlineUser ? null : getErrorText(error, "Unable to verify your session."));
      }
    }

    void hydrateAuthSession();

    return () => {
      cancelled = true;
    };
  }, [hasPasswordResetToken, extension?.serverUrl, extension?.userId]);

  useEffect(() => {
    if (!checkoutReturn || authStatus !== "authenticated" || !authUser?.id) return;
    let cancelled = false;
    const userId = authUser.id;
    setBillingOpenRequest((current) => current + 1);
    async function confirmReturn() {
      try {
        if (checkoutReturn!.kind === "canceled") {
          setBillingNotice({ kind: "info", message: "Checkout was canceled. You can try again whenever you’re ready." });
        } else {
          if (!checkoutReturn!.sessionId) throw new Error("Checkout returned without a session ID. We could not verify a payment; refresh billing to check your balance.");
          const confirmation = await requestConfirmCheckoutSession(checkoutReturn!.sessionId, userId);
          if (cancelled || authUserIdRef.current !== userId) return;
          setBillingNotice(getCheckoutConfirmationNotice(confirmation));
          if (confirmation.user?.id === userId) {
            rememberOfflineUser(confirmation.user);
            setAuthUser(confirmation.user);
          }
        }
        await refreshBilling();
      } catch (error) {
        if (!cancelled && authUserIdRef.current === userId) {
          setBillingNotice({ kind: "error", message: getErrorText(error, "We could not verify your payment. Refresh billing to check its status.") });
          await refreshBilling();
        }
      } finally {
        if (!cancelled && authUserIdRef.current === userId) {
          setCheckoutReturn(null);
          const cleanUrl = new URL(window.location.href);
          cleanUrl.searchParams.delete("checkout");
          cleanUrl.searchParams.delete("session_id");
          window.history.replaceState({}, "", `${cleanUrl.pathname}${cleanUrl.search}${cleanUrl.hash}`);
        }
      }
    }
    void confirmReturn();
    return () => { cancelled = true; };
  }, [checkoutReturn, authStatus, authUser?.id, refreshBilling]);

  useEffect(() => {
    if (!billingPortalReturn || checkoutReturn || authStatus !== "authenticated" || !authUser?.id) return;
    let cancelled = false;
    const userId = authUser.id;
    setBillingOpenRequest((current) => current + 1);
    void refreshBilling().then(() => {
      if (cancelled || authUserIdRef.current !== userId) return;
      setBillingPortalReturn(false);
      const cleanUrl = new URL(window.location.href);
      cleanUrl.searchParams.delete("billing");
      window.history.replaceState({}, "", `${cleanUrl.pathname}${cleanUrl.search}${cleanUrl.hash}`);
    });
    return () => { cancelled = true; };
  }, [billingPortalReturn, checkoutReturn, authStatus, authUser?.id, refreshBilling]);

  useEffect(() => {
    setBillingDashboard(null);
    setBillingDashboardError(null);
    setBillingDashboardLoading(false);
    billingRefreshSequence.current += 1;
    if (authUser?.id) void refreshBilling();
  }, [authUser?.id, refreshBilling]);

  function handleAuthExpired(
    message = "Your session expired. Sign in again to continue.",
  ) {
    forgetOfflineUser();
    setAuthUser(null);
    setAuthStatus("unauthenticated");
    setAuthSubmitting(false);
    setAuthError(message);
    setBillingError(null);
    setBillingNotice(null);
  }

  async function handleBillingRequired(
    message = "Add money to your prepaid balance before using the hosted models.",
  ) {
    try {
      const user = await requestAuthSession();

      setAuthUser(user);
      setAuthStatus(user ? "authenticated" : "unauthenticated");
      setAuthError(null);
      setBillingError(message);
      setBillingOpenRequest((current) => current + 1);
      void refreshBilling();
    } catch {
      handleAuthExpired(message);
    }
  }

  async function handleLogin(args: { email: string; password: string }) {
    setAuthSubmitting(true);
    setAuthError(null);
    setBillingError(null);

    try {
      const user = await requestLogin(args);
      rememberOfflineUser(user);
      setAuthUser(user);
      setAuthStatus("authenticated");
    } catch (error) {
      setAuthError(getErrorText(error, "Login failed."));
    } finally {
      setAuthSubmitting(false);
    }
  }

  async function handleSignup(args: {
    displayName: string;
    email: string;
    password: string;
  }) {
    setAuthSubmitting(true);
    setAuthError(null);
    setBillingError(null);

    try {
      const user = await requestSignup(args);
      rememberOfflineUser(user);
      setAuthUser(user);
      setAuthStatus("authenticated");
    } catch (error) {
      setAuthError(getErrorText(error, "Signup failed."));
    } finally {
      setAuthSubmitting(false);
    }
  }

  async function handleRequestPasswordReset(args: { email: string }) {
    setAuthSubmitting(true);
    setAuthError(null);

    try {
      return await requestPasswordReset(args);
    } catch (error) {
      setAuthError(getErrorText(error, "Unable to request a password reset."));
      return null;
    } finally {
      setAuthSubmitting(false);
    }
  }

  async function handleResetPassword(args: { password: string; token: string }) {
    setAuthSubmitting(true);
    setAuthError(null);

    try {
      await requestPasswordResetConfirm(args);
      forgetOfflineUser();
      return true;
    } catch (error) {
      setAuthError(getErrorText(error, "Unable to reset the password."));
      return false;
    } finally {
      setAuthSubmitting(false);
    }
  }

  async function handleLogout() {
    forgetOfflineUser();
    try {
      if (extension) await extension.onLogout();
      else await requestLogout();
    } catch (error) {
      console.warn("Unable to clear the server session.", error);
    } finally {
      setAuthUser(null);
      setAuthStatus("unauthenticated");
      setAuthError(null);
      setAuthSubmitting(false);
      setBillingError(null);
      setBillingSubmitting(false);
      setBillingNotice(null);
    }
  }

  function openWebsiteSettings(tab: "account" | "billing" | "api-keys") {
    if (!extension) return;
    const url = new URL(extension.serverUrl);
    url.searchParams.set("settings", tab);
    extension.openExternal(url.toString());
  }

  function requireWebsiteSettings(tab: "account" | "api-keys") {
    if (!extension) return;
    openWebsiteSettings(tab);
    throw new Error("Manage account details and API keys on the Margin Chat website.");
  }

  async function handleUpdateProfile(args: {
    displayName: string;
    email: string;
  }) {
    requireWebsiteSettings("account");
    const user = await requestUpdateProfile(args);
    rememberOfflineUser(user);
    setAuthUser(user);
    setAuthStatus("authenticated");
    return user;
  }

  async function handleChangePassword(args: { currentPassword: string; password: string }) {
    requireWebsiteSettings("account");
    try {
      await requestChangePassword(args);
    } catch (error) {
      if (error instanceof ApiError && error.statusCode === 401) handleAuthExpired(error.message);
      throw error;
    }
  }

  async function handleUpdateApiKeys(args: {
    keys: Partial<Record<ApiKeyProvider, string | null>>;
  }) {
    requireWebsiteSettings("api-keys");
    const apiKeys = await requestUpdateApiKeys(args);
    setAuthUser((current) => (current ? { ...current, apiKeys } : current));
    return apiKeys;
  }

  async function redirectToStripe(
    callback: (expectedUserId: string) => Promise<string>,
    fallbackMessage: string,
  ) {
    const userId = authUserIdRef.current;
    if (!userId) return;
    setBillingSubmitting(true);
    setBillingError(null);

    try {
      const url = await callback(userId);
      if (authUserIdRef.current === userId) window.location.assign(url);
    } catch (error) {
      if (authUserIdRef.current === userId) setBillingError(getErrorText(error, fallbackMessage));
    } finally {
      if (authUserIdRef.current === userId) setBillingSubmitting(false);
    }
  }

  async function handleStartSubscription() {
    if (extension) { openWebsiteSettings("billing"); return; }
    await redirectToStripe(
      requestCreateCheckoutSession,
      "Unable to start the Stripe checkout flow.",
    );
  }

  async function handleAddMoney(amountCents: number) {
    if (extension) { openWebsiteSettings("billing"); return; }
    await redirectToStripe((userId) => requestCreateTopUpSession(amountCents, userId), "Unable to open Checkout to add money.");
  }

  async function handleManageBilling() {
    if (extension) { openWebsiteSettings("billing"); return; }
    await redirectToStripe(
      requestCreateBillingPortalSession,
      "Unable to open the Stripe billing portal.",
    );
  }

  if (authStatus === "checking") {
    return (
      <div className="app-shell">
        <div className="app-chrome auth-chrome">
          <div className="auth-loading-card">
            <p className="eyebrow">Margin Chat</p>
            <h1>Checking your session...</h1>
            <p className="auth-copy">
              We&apos;re loading your workspace and verifying whether there&apos;s
              an active sign-in cookie.
            </p>
          </div>
        </div>
      </div>
    );
  }

  if (authStatus !== "authenticated" || !authUser || (extension?.userId && authUser.id !== extension.userId)) {
    if (extension) return (
      <div className="app-shell"><div className="app-chrome auth-chrome"><div className="auth-loading-card">
        <p className="eyebrow">Margin Chat</p>
        <h1>Connect your workspace</h1>
        <p className="auth-copy">Sign in through the extension settings to open your documents, notes, and AI conversations above this page.</p>
        {authError && <p role="alert">{authError}</p>}
        <button className="thread-dialog-button is-primary" onClick={extension.onConnect} type="button">Connect Margin Chat</button>
      </div></div></div>
    );
    return (
      <div className="app-shell">
        <div className="app-chrome auth-chrome">
          <AuthLanding
            errorMessage={authError}
            isSubmitting={authSubmitting}
            onLogin={handleLogin}
            onRequestPasswordReset={handleRequestPasswordReset}
            onResetPassword={handleResetPassword}
            onSignup={handleSignup}
            onToggleTheme={() => setTheme((current) => getNextTheme(current))}
            theme={theme}
          />
        </div>
      </div>
    );
  }

  return (
    <Suspense fallback={<div className="app-shell"><div className="auth-loading-card" role="status">Opening your workspace…</div></div>}>
    <WorkspaceApp
      browserCaptureRequest={browserCaptureRequest}
      onBrowserCaptureHandled={onBrowserCaptureHandled}
      browserThreadRequests={browserThreadRequests}
      onBrowserThreadHandled={onBrowserThreadHandled}
      onOpenWebsiteSettings={extension ? openWebsiteSettings : undefined}
      storageNamespace={apiStorageNamespace(authUser.id)}
      billingNotice={billingNotice}
      billingDashboard={billingDashboard}
      billingDashboardLoading={billingDashboardLoading}
      billingDashboardError={billingDashboardError}
      billingOpenRequest={billingOpenRequest}
      onRefreshBilling={refreshBilling}
      onAddMoney={handleAddMoney}
      billingErrorMessage={billingError}
      billingSubmitting={billingSubmitting}
      key={apiStorageNamespace(authUser.id)}
      onAuthExpired={handleAuthExpired}
      onDismissBillingNotice={() => setBillingNotice(null)}
      onBillingRequired={handleBillingRequired}
      onLogout={() => {
        void handleLogout();
      }}
      onManageBilling={handleManageBilling}
      onStartSubscription={handleStartSubscription}
      onSetTheme={setTheme}
      onUpdateProfile={handleUpdateProfile}
      onChangePassword={handleChangePassword}
      onUpdateApiKeys={handleUpdateApiKeys}
      theme={theme}
      user={authUser}
    />
    </Suspense>
  );
}
