import type { AuthenticatedUser } from "../types";
import {
  getBillingDisplayLabel,
  getBillingStatusCopy,
} from "../lib/billing";

type ThemeMode = "light" | "dark";

interface BillingGateProps {
  errorMessage: string | null;
  isSubmitting: boolean;
  onLogout: () => void | Promise<void>;
  onManageBilling: () => void | Promise<void>;
  onStartSubscription: () => void | Promise<void>;
  onToggleTheme: () => void;
  theme: ThemeMode;
  user: AuthenticatedUser;
}

export default function BillingGate({
  errorMessage,
  isSubmitting,
  onLogout,
  onManageBilling,
  onStartSubscription,
  onToggleTheme,
  theme,
  user,
}: BillingGateProps) {
  const canManageBilling =
    user.billing.hasCustomer && user.billing.status !== "inactive";
  const primaryAction = canManageBilling ? onManageBilling : onStartSubscription;
  const primaryLabel = canManageBilling ? "Manage billing" : "Start paid plan";

  return (
    <div className="auth-layout">
      <section className="auth-hero">
        <p className="eyebrow">Margin Chat</p>
        <h1>Activate a paid plan before this workspace can talk to the models.</h1>
        <p className="auth-copy">
          Your account is signed in, but hosted LLM access stays locked until Stripe
          shows an active or trialing subscription.
        </p>
        <div className="auth-feature-grid">
          <article className="auth-feature-card">
            <span className="auth-feature-kicker">Protected spend</span>
            <strong>Only paid accounts can hit your API keys.</strong>
            <p>
              The server checks subscription status before any chat request reaches
              the upstream LLM provider.
            </p>
          </article>
          <article className="auth-feature-card">
            <span className="auth-feature-kicker">Stripe-backed</span>
            <strong>Status sync comes from webhooks, not client trust.</strong>
            <p>
              Checkout, renewal, cancellation, and payment recovery all flow back
              into the workspace account record.
            </p>
          </article>
          <article className="auth-feature-card">
            <span className="auth-feature-kicker">Ready for launch</span>
            <strong>Use test mode now, then swap in live keys later.</strong>
            <p>
              You can finish the access control and billing flow before exposing any
              production LLM secrets.
            </p>
          </article>
        </div>
      </section>

      <section className="auth-card billing-card" aria-label="Billing access">
        <div className="auth-card-head">
          <div>
            <p className="eyebrow">Billing</p>
            <h2>{getBillingDisplayLabel(user.billing)}</h2>
          </div>
          <button className="ghost-button" onClick={onToggleTheme} type="button">
            {theme === "dark" ? "Light theme" : "Dark theme"}
          </button>
        </div>

        <div className="billing-summary-card">
          <div className="billing-summary-copy">
            <strong>{user.displayName}</strong>
            <span>{user.email}</span>
          </div>
          <span className="billing-status-pill">
            {getBillingDisplayLabel(user.billing)}
          </span>
        </div>

        <p className="thread-dialog-copy">{getBillingStatusCopy(user.billing)}</p>

        {errorMessage ? <p className="auth-error">{errorMessage}</p> : null}

        <div className="billing-action-stack">
          <button
            className="primary-button auth-submit"
            disabled={isSubmitting}
            onClick={() => {
              void primaryAction();
            }}
            type="button"
          >
            {isSubmitting ? "Opening Stripe..." : primaryLabel}
          </button>

          {canManageBilling ? (
            <button
              className="secondary-button"
              disabled={isSubmitting}
              onClick={() => {
                void onStartSubscription();
              }}
              type="button"
            >
              Start a new checkout
            </button>
          ) : null}

          <button
            className="ghost-button"
            disabled={isSubmitting}
            onClick={() => {
              void onLogout();
            }}
            type="button"
          >
            Log out
          </button>
        </div>
      </section>
    </div>
  );
}
