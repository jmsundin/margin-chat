import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import AuthLanding from "./components/AuthLanding";
import {
  requestAuthSession, requestBillingDashboard, requestConfirmCheckoutSession, requestCreateBillingPortalSession, requestCreateTopUpSession,
  requestCreateCheckoutSession, requestLogin, requestLogout, requestPasswordReset,
  requestPasswordResetConfirm, requestSignup, requestUpdateApiKeys, requestUpdateProfile,
} from "./lib/api";
import { rememberOfflineUser, loadOfflineUser, forgetOfflineUser } from "./lib/offlineSession";
import { getNextTheme, loadInitialTheme, syncTheme, THEME_STORAGE_KEY, type ThemeMode } from "./lib/appearance";
import { getCheckoutConfirmationNotice, getCheckoutReturn } from "./lib/billing";
import type { ApiKeyProvider, AuthenticatedUser, BillingDashboardData } from "./types";

const WorkspaceApp = lazy(() => import("./WorkspaceApp"));
type AuthStatus = "checking" | "authenticated" | "unauthenticated";
const INITIAL_THEME = loadInitialTheme();
syncTheme(INITIAL_THEME);

function getErrorText(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback;
}

export default function App() {
  const hasPasswordResetToken = new URLSearchParams(window.location.search).has(
    "reset_token",
  );
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

        if (user) rememberOfflineUser(user); else forgetOfflineUser();
        setAuthUser(user);
        setAuthStatus(user ? "authenticated" : "unauthenticated");
        setAuthError(null);
      } catch (error) {
        if (cancelled) {
          return;
        }

        const offlineUser = loadOfflineUser();
        setAuthUser(offlineUser);
        setAuthStatus(offlineUser ? "authenticated" : "unauthenticated");
        setAuthError(offlineUser ? null : getErrorText(error, "Unable to verify your session."));
      }
    }

    void hydrateAuthSession();

    return () => {
      cancelled = true;
    };
  }, [hasPasswordResetToken]);

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
      await requestLogout();
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

  async function handleUpdateProfile(args: {
    displayName: string;
    email: string;
  }) {
    const user = await requestUpdateProfile(args);
    rememberOfflineUser(user);
    setAuthUser(user);
    setAuthStatus("authenticated");
    return user;
  }

  async function handleUpdateApiKeys(args: {
    keys: Partial<Record<ApiKeyProvider, string | null>>;
  }) {
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
    await redirectToStripe(
      requestCreateCheckoutSession,
      "Unable to start the Stripe checkout flow.",
    );
  }

  async function handleAddMoney(amountCents: number) {
    await redirectToStripe((userId) => requestCreateTopUpSession(amountCents, userId), "Unable to open Checkout to add money.");
  }

  async function handleManageBilling() {
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

  if (authStatus !== "authenticated" || !authUser) {
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
      billingNotice={billingNotice}
      billingDashboard={billingDashboard}
      billingDashboardLoading={billingDashboardLoading}
      billingDashboardError={billingDashboardError}
      billingOpenRequest={billingOpenRequest}
      onRefreshBilling={refreshBilling}
      onAddMoney={handleAddMoney}
      billingErrorMessage={billingError}
      billingSubmitting={billingSubmitting}
      key={authUser.id}
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
      onUpdateApiKeys={handleUpdateApiKeys}
      theme={theme}
      user={authUser}
    />
    </Suspense>
  );
}
