import { useState, type FormEvent } from "react";

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
}: AuthLandingProps) {
  const initialResetToken = new URLSearchParams(window.location.search).get("reset_token") ?? "";
  const [mode, setMode] = useState<AuthMode>(initialResetToken ? "reset" : "signup");
  const [localError, setLocalError] = useState<string | null>(null);
  const [showParentError, setShowParentError] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);
  const [loginEmail, setLoginEmail] = useState("");
  const [loginPassword, setLoginPassword] = useState("");
  const [signupDisplayName, setSignupDisplayName] = useState("");
  const [signupEmail, setSignupEmail] = useState("");
  const [signupPassword, setSignupPassword] = useState("");
  const [signupConfirmPassword, setSignupConfirmPassword] = useState("");
  const [resetEmail, setResetEmail] = useState("");
  const [resetToken, setResetToken] = useState(initialResetToken);
  const [newPassword, setNewPassword] = useState("");
  const [confirmNewPassword, setConfirmNewPassword] = useState("");

  function switchMode(nextMode: AuthMode) {
    setLocalError(null);
    setNotice(null);
    setShowParentError(false);
    setMode(nextMode);
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

    setNotice("If an account exists for that email, password reset instructions have been sent.");
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

    if (signupPassword !== signupConfirmPassword) {
      setLocalError("Passwords do not match.");
      return;
    }

    setLocalError(null);
    setShowParentError(true);
    void onSignup({
      displayName: signupDisplayName,
      email: signupEmail,
      password: signupPassword,
    });
  }

  const activeError = localError ?? (showParentError ? errorMessage : null);

  return (
    <div className="auth-layout">
      <section className="auth-hero">
        <p className="eyebrow">Margin Chat</p>
        <h1>Bring every branch of the conversation into one workspace.</h1>
        <p className="auth-copy">
          Sign in to keep chats private to your account, pick up where you left
          off, and branch ideas without leaking threads across users.
        </p>
        <div className="auth-feature-grid">
          <article className="auth-feature-card">
            <span className="auth-feature-kicker">Protected</span>
            <strong>Each workspace is isolated per account.</strong>
            <p>
              Conversations, pinned threads, and future sessions stay scoped to
              the person who owns them.
            </p>
          </article>
          <article className="auth-feature-card">
            <span className="auth-feature-kicker">Persistent</span>
            <strong>Server-backed history with local cache fallback.</strong>
            <p>
              Your layout and thread graph come back after refresh without
              relying on a shared browser state.
            </p>
          </article>
          <article className="auth-feature-card">
            <span className="auth-feature-kicker">Branchable</span>
            <strong>Highlight, fork, and compare lines of thought.</strong>
            <p>
              Keep the main thread moving while side explorations remain tied to
              the original message context.
            </p>
          </article>
        </div>
      </section>

      <section className="auth-card" aria-label="Authentication">
        <div className="auth-card-head">
          <div>
            <p className="eyebrow">Welcome</p>
            <h2>
              {mode === "signup"
                ? "Create your workspace"
                : mode === "forgot"
                  ? "Reset your password"
                  : mode === "reset"
                    ? "Choose a new password"
                    : "Welcome back"}
            </h2>
          </div>
          <button className="ghost-button" onClick={onToggleTheme} type="button">
            {theme === "dark" ? "Light theme" : "Dark theme"}
          </button>
        </div>

        {mode === "signup" || mode === "login" ? (
        <div className="auth-mode-switch" role="tablist" aria-label="Auth mode">
          <button
            aria-selected={mode === "signup"}
            className={mode === "signup" ? "secondary-button is-active" : "secondary-button"}
            onClick={() => switchMode("signup")}
            type="button"
          >
            Sign up
          </button>
          <button
            aria-selected={mode === "login"}
            className={mode === "login" ? "secondary-button is-active" : "secondary-button"}
            onClick={() => switchMode("login")}
            type="button"
          >
            Log in
          </button>
        </div>
        ) : null}

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
              <input
                autoComplete="new-password"
                disabled={isSubmitting}
                onChange={(event) => setSignupPassword(event.target.value)}
                placeholder="At least 8 characters"
                type="password"
                value={signupPassword}
              />
            </label>
            <label className="auth-field">
              <span>Confirm password</span>
              <input
                autoComplete="new-password"
                disabled={isSubmitting}
                onChange={(event) =>
                  setSignupConfirmPassword(event.target.value)
                }
                placeholder="Repeat your password"
                type="password"
                value={signupConfirmPassword}
              />
            </label>

            {activeError ? <p className="auth-error">{activeError}</p> : null}

            <button className="primary-button auth-submit" disabled={isSubmitting} type="submit">
              {isSubmitting ? "Creating account..." : "Create account"}
            </button>
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

            {activeError ? <p className="auth-error">{activeError}</p> : null}
            {notice ? <p className="auth-notice">{notice}</p> : null}

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
            {activeError ? <p className="auth-error">{activeError}</p> : null}
            {notice ? <p className="auth-notice">{notice}</p> : null}
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
            {activeError ? <p className="auth-error">{activeError}</p> : null}
            {notice ? <p className="auth-notice">{notice}</p> : null}
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
