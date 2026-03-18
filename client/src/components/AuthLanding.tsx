import { useState, type FormEvent } from "react";

type AuthMode = "login" | "signup";
type ThemeMode = "light" | "dark";

interface AuthLandingProps {
  errorMessage: string | null;
  isSubmitting: boolean;
  onLogin: (args: { email: string; password: string }) => void | Promise<void>;
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
  onSignup,
  onToggleTheme,
  theme,
}: AuthLandingProps) {
  const [mode, setMode] = useState<AuthMode>("signup");
  const [localError, setLocalError] = useState<string | null>(null);
  const [loginEmail, setLoginEmail] = useState("");
  const [loginPassword, setLoginPassword] = useState("");
  const [signupDisplayName, setSignupDisplayName] = useState("");
  const [signupEmail, setSignupEmail] = useState("");
  const [signupPassword, setSignupPassword] = useState("");
  const [signupConfirmPassword, setSignupConfirmPassword] = useState("");

  function switchMode(nextMode: AuthMode) {
    setLocalError(null);
    setMode(nextMode);
  }

  function handleLoginSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLocalError(null);
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
    void onSignup({
      displayName: signupDisplayName,
      email: signupEmail,
      password: signupPassword,
    });
  }

  const activeError = localError ?? errorMessage;

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
            <h2>{mode === "signup" ? "Create your workspace" : "Welcome back"}</h2>
          </div>
          <button className="ghost-button" onClick={onToggleTheme} type="button">
            {theme === "dark" ? "Light theme" : "Dark theme"}
          </button>
        </div>

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
        ) : (
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

            <button className="primary-button auth-submit" disabled={isSubmitting} type="submit">
              {isSubmitting ? "Signing in..." : "Log in"}
            </button>
          </form>
        )}
      </section>
    </div>
  );
}
