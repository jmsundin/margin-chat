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
  const primaryLabel = canManageBilling ? "Manage billing" : "Subscribe for $20/month";

  return (
    <div className="auth-layout">
      <section className="auth-hero">
        <p className="eyebrow">Margin Chat</p>
        <h1>Fund your AI budget, then pay as you use it.</h1>
        <p className="auth-copy">
          Your $20 monthly payment adds $20 in prepaid credit for hosted AI.
          Unused credits carry over, and you can add money whenever you need it.
        </p>
        <div className="auth-feature-grid">
          <article className="auth-feature-card">
            <span className="auth-feature-kicker">Prepaid usage</span>
            <strong>Know what you have available.</strong>
            <p>
              Your billing dashboard tracks your available balance, running
              requests, and settled API usage.
            </p>
          </article>
          <article className="auth-feature-card">
            <span className="auth-feature-kicker">Credits carry over</span>
            <strong>Your unused budget stays yours to use.</strong>
            <p>
              Monthly credits and one-time top-ups remain available, including
              after you cancel monthly funding.
            </p>
          </article>
          <article className="auth-feature-card">
            <span className="auth-feature-kicker">Simple billing</span>
            <strong>Secure Checkout and emailed receipts.</strong>
            <p>
              Pay through Stripe, manage your subscription, and find receipts
              from your billing dashboard.
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
