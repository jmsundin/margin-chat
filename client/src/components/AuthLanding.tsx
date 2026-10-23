import { useState, type FormEvent } from "react";
import "./AuthLanding.css";

type AuthMode = "forgot" | "login" | "reset" | "signup";
type ThemeMode = "light" | "dark";

interface AuthLandingProps {
  errorMessage: string | null;
  isSubmitting: boolean;
  onLogin: (args: { email: string; password: string }) => void | Promise<void>;
  onRequestPasswordReset: (args: {
    email: string;
  }) => Promise<{ resetToken?: string } | null>;
  onResetPassword: (args: {
    password: string;
    token: string;
  }) => Promise<boolean>;
  onSignup: (args: {
    displayName: string;
    email: string;
    password: string;
  }) => void | Promise<void>;
  onToggleTheme: () => void;
  theme: ThemeMode;
  initialMode?: "login" | "signup";
}

export default function AuthLanding({
  errorMessage,
  isSubmitting,
  onLogin,
  onRequestPasswordReset,
  onResetPassword,
  onSignup,
  onToggleTheme,
  theme,
  initialMode = "signup",
}: AuthLandingProps) {
  const initialResetToken = new URLSearchParams(window.location.search).get("reset_token") ?? "";
  const [mode, setMode] = useState<AuthMode>(initialResetToken ? "reset" : initialMode);
  const [localError, setLocalError] = useState<string | null>(null);
  const [showParentError, setShowParentError] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);
  const [loginEmail, setLoginEmail] = useState("");
  const [loginPassword, setLoginPassword] = useState("");
  const [signupDisplayName, setSignupDisplayName] = useState("");
  const [signupEmail, setSignupEmail] = useState("");
  const [signupPassword, setSignupPassword] = useState("");
  const [showSignupPassword, setShowSignupPassword] = useState(false);
  const [resetEmail, setResetEmail] = useState("");
  const [resetToken, setResetToken] = useState(initialResetToken);
  const [newPassword, setNewPassword] = useState("");
  const [confirmNewPassword, setConfirmNewPassword] = useState("");

  function switchMode(nextMode: AuthMode) {
    setLocalError(null);
    setNotice(null);
    setShowParentError(false);
    setMode(nextMode);
    // Keep the address in step so a reload or shared link opens the same form.
    const path = nextMode === "signup" ? "/signup" : nextMode === "login" ? "/login" : null;
    if (path && (window.location.pathname === "/login" || window.location.pathname === "/signup")) {
      window.history.replaceState({}, "", path);
    }
  }

  async function handleResetRequestSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLocalError(null);
    setNotice(null);
    setShowParentError(true);

    const result = await onRequestPasswordReset({ email: resetEmail });

    if (!result) {
      return;
    }

    if (result.resetToken) {
      setResetToken(result.resetToken);
      setMode("reset");
      setNotice("Development reset link created. Choose a new password.");
      return;
    }

    setNotice("If an account exists for that email, you’ll receive password reset instructions. Check your spam folder too.");
  }

  async function handleResetSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (newPassword !== confirmNewPassword) {
      setLocalError("Passwords do not match.");
      return;
    }

    setLocalError(null);
    setShowParentError(true);
    const wasReset = await onResetPassword({ password: newPassword, token: resetToken });

    if (!wasReset) {
      return;
    }

    window.history.replaceState({}, "", window.location.pathname);
    setNewPassword("");
    setConfirmNewPassword("");
    setResetToken("");
    setLoginEmail(resetEmail);
    setLoginPassword("");
    setMode("login");
    setNotice("Password updated. You can now log in.");
  }

  function handleLoginSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLocalError(null);
    setShowParentError(true);
    void onLogin({
      email: loginEmail,
      password: loginPassword,
    });
  }

  function handleSignupSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    setLocalError(null);
    setShowParentError(true);
    void onSignup({
      displayName: signupDisplayName,
      email: signupEmail,
      password: signupPassword,
    });
  }

  const activeError = localError ?? (showParentError ? errorMessage : null);

  const isSignup = mode === "signup";
  const themeLabel = theme === "dark" ? "Switch to light theme" : "Switch to dark theme";
  const themeButton = (
    <button aria-label={themeLabel} className="auth-theme-button" onClick={onToggleTheme} title={themeLabel} type="button">
      {theme === "dark" ? <SunIcon /> : <MoonIcon />}
    </button>
  );

  return (
    <div className={isSignup ? "auth-layout auth-welcome-layout" : "auth-layout auth-signin-layout"}>
      {isSignup ? (
        <section className="auth-hero">
          <p className="eyebrow">Margin Chat</p>
          <h1>Read, write and think beside your documents.</h1>
          <p className="auth-copy">
            Select a passage to leave a margin note beside it or open a side
            document for the idea it gave you. Ask AI about any of it, then see
            how everything connects on the Map.
          </p>
          <figure className="auth-conversation-example">
            <figcaption>A document with room to think</figcaption>
            <div className="auth-example-panels">
              <div className="auth-example-main">
                <div className="auth-example-title"><span className="auth-example-dot" />The printing press</div>
                <p>Within fifty years of Gutenberg’s press, Europe had printed some twenty million books.</p>
                <p>The change was less about speed than about <mark>copies being identical</mark>, which made it possible to cite a page and a line.</p>
                <span className="auth-example-branch-label">✎ Margin note: Same words everywhere, so a claim could be checked.</span>
              </div>
              <div className="auth-example-branch">
                <div className="auth-example-title"><span aria-hidden="true">↗</span>Citation</div>
                <blockquote>“copies being identical”</blockquote>
                <p>Page numbers only work when every copy matches. Before print, two manuscripts of one book rarely did.</p>
                <p className="auth-example-speaker">✦ Ask AI</p>
                <p>When did page numbers become common in printed books?</p>
              </div>
            </div>
            <p className="auth-example-caption">A note comments on the passage. A side document follows the new idea.</p>
          </figure>
          <ul className="auth-welcome-benefits" aria-label="What you get">
            <li><span aria-hidden="true">✎</span> Notes beside the text</li>
            <li><span aria-hidden="true">↗</span> Side documents for new ideas</li>
            <li><span aria-hidden="true">◎</span> A Map of how it connects</li>
          </ul>
        </section>
      ) : (
        <header className="auth-signin-top">
          <a className="auth-brand" href="/">
            <img alt="" height="28" src="/icon.svg" width="28" />
            <span>Margin Chat</span>
          </a>
          {themeButton}
        </header>
      )}

      <section className="auth-card" aria-label="Authentication">
        <div className="auth-card-head">
          <h2>
            {isSignup
              ? "Create your workspace"
              : mode === "forgot"
                ? "Reset your password"
                : mode === "reset"
                  ? "Choose a new password"
                  : "Welcome back"}
          </h2>
          {isSignup ? themeButton : null}
        </div>

        {mode === "signup" ? (
          <form className="auth-form" onSubmit={handleSignupSubmit}>
            <label className="auth-field">
              <span>Name</span>
              <input
                autoComplete="name"
                disabled={isSubmitting}
                onChange={(event) => setSignupDisplayName(event.target.value)}
                placeholder="Ada Lovelace"
                type="text"
                value={signupDisplayName}
              />
            </label>
            <label className="auth-field">
              <span>Email</span>
              <input
                autoComplete="email"
                disabled={isSubmitting}
                onChange={(event) => setSignupEmail(event.target.value)}
                placeholder="you@example.com"
                type="email"
                value={signupEmail}
              />
            </label>
            <label className="auth-field">
              <span>Password</span>
              <span className="auth-password-row">
                <input
                  autoComplete="new-password"
                  disabled={isSubmitting}
                  minLength={8}
                  onChange={(event) => setSignupPassword(event.target.value)}
                  placeholder="At least 8 characters"
                  type={showSignupPassword ? "text" : "password"}
                  value={signupPassword}
                />
                <button className="auth-password-toggle" type="button" aria-pressed={showSignupPassword}
                  onClick={() => setShowSignupPassword((shown) => !shown)}>
                  {showSignupPassword ? "Hide" : "Show"}
                </button>
              </span>
            </label>

            {activeError ? <p className="auth-error" role="alert">{activeError}</p> : null}

            <button className="primary-button auth-submit" disabled={isSubmitting} type="submit">
              {isSubmitting ? "Creating account..." : "Create account"}
            </button>
            <p className="auth-signup-note">You start with a “Start here” document and a short tour. Writing, notes and the Map are free; AI uses your own API key or credit you add.</p>
            <p className="auth-switch">
              Already have an account?{" "}
              <button className="auth-switch-button" onClick={() => switchMode("login")} type="button">Log in</button>
            </p>
          </form>
        ) : mode === "login" ? (
          <form className="auth-form" onSubmit={handleLoginSubmit}>
            <label className="auth-field">
              <span>Email</span>
              <input
                autoComplete="email"
                disabled={isSubmitting}
                onChange={(event) => setLoginEmail(event.target.value)}
                placeholder="you@example.com"
                type="email"
                value={loginEmail}
              />
            </label>
            <label className="auth-field">
              <span>Password</span>
              <input
                autoComplete="current-password"
                disabled={isSubmitting}
                onChange={(event) => setLoginPassword(event.target.value)}
                placeholder="Your password"
                type="password"
                value={loginPassword}
              />
            </label>

            {activeError ? <p className="auth-error" role="alert">{activeError}</p> : null}
            {notice ? <p className="auth-notice" role="status">{notice}</p> : null}

            <button className="primary-button auth-submit" disabled={isSubmitting} type="submit">
              {isSubmitting ? "Signing in..." : "Log in"}
            </button>
            <button
              className="auth-link-button"
              disabled={isSubmitting}
              onClick={() => {
                setResetEmail(loginEmail);
                switchMode("forgot");
              }}
              type="button"
            >
              Forgot password?
            </button>
            <p className="auth-switch">
              New to Margin Chat?{" "}
              <button className="auth-switch-button" onClick={() => switchMode("signup")} type="button">Create an account</button>
            </p>
          </form>
        ) : mode === "forgot" ? (
          <form className="auth-form" onSubmit={handleResetRequestSubmit}>
            <p className="auth-form-copy">
              Enter your account email. Reset links expire after one hour and can only be used once.
            </p>
            <label className="auth-field">
              <span>Email</span>
              <input
                autoComplete="email"
                disabled={isSubmitting}
                onChange={(event) => setResetEmail(event.target.value)}
                placeholder="you@example.com"
                type="email"
                value={resetEmail}
              />
            </label>
            {activeError ? <p className="auth-error" role="alert">{activeError}</p> : null}
            {notice ? <p className="auth-notice" role="status">{notice}</p> : null}
            <button className="primary-button auth-submit" disabled={isSubmitting} type="submit">
              {isSubmitting ? "Creating reset link..." : "Continue"}
            </button>
            <button className="auth-link-button" onClick={() => switchMode("login")} type="button">
              Back to login
            </button>
          </form>
        ) : (
          <form className="auth-form" onSubmit={handleResetSubmit}>
            <label className="auth-field">
              <span>New password</span>
              <input
                autoComplete="new-password"
                disabled={isSubmitting}
                onChange={(event) => setNewPassword(event.target.value)}
                placeholder="At least 8 characters"
                type="password"
                value={newPassword}
              />
            </label>
            <label className="auth-field">
              <span>Confirm new password</span>
              <input
                autoComplete="new-password"
                disabled={isSubmitting}
                onChange={(event) => setConfirmNewPassword(event.target.value)}
                placeholder="Repeat your password"
                type="password"
                value={confirmNewPassword}
              />
            </label>
            {activeError ? <p className="auth-error" role="alert">{activeError}</p> : null}
            {notice ? <p className="auth-notice" role="status">{notice}</p> : null}
            <button className="primary-button auth-submit" disabled={isSubmitting} type="submit">
              {isSubmitting ? "Updating password..." : "Update password"}
            </button>
            <button className="auth-link-button" onClick={() => switchMode("login")} type="button">
              Back to login
            </button>
          </form>
        )}
      </section>
    </div>
  );
}

function SunIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
    </svg>
  );
}
