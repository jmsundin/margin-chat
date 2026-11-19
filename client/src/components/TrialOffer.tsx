import type { AuthenticatedUser, PlanTrial } from "../types";
import { formatBillingPeriodEnd, formatCreditBalance } from "../lib/billing";

interface TrialOfferProps {
  errorMessage: string | null;
  isSubmitting: boolean;
  onSkip: () => void;
  onStart: () => void | Promise<void>;
  trial: PlanTrial;
  user: AuthenticatedUser;
}

export function trialLengthLabel(days: number) {
  return days === 7 ? "free week" : `${days} free days`;
}

/**
 * Shown once, right after signup: says plainly that Stripe asks for a card next, why, when the
 * first charge would be and how to cancel. Skipping goes straight to the free app.
 */
export default function TrialOffer({ errorMessage, isSubmitting, onSkip, onStart, trial, user }: TrialOfferProps) {
  const trialEnd = formatBillingPeriodEnd(new Date(Date.now() + trial.days * 24 * 60 * 60 * 1000).toISOString());
  const length = trialLengthLabel(trial.days);
  const credit = trial.creditMicros > 0 ? formatCreditBalance(trial.creditMicros) : null;
  return (
    <div className="app-shell">
      <div className="app-chrome auth-chrome">
        <section className="auth-card trial-offer" aria-labelledby="trial-offer-title">
          <p className="eyebrow">One more step</p>
          <h2 id="trial-offer-title">Your account is ready. Your {length} of Plus {trial.days === 7 ? "is" : "are"} next.</h2>
          <ol className="trial-offer-steps" aria-label="Signup progress">
            <li className="is-done">Your account</li>
            <li aria-current="step">Your {length}</li>
          </ol>
          <p className="auth-copy">
            Plus is Margin Chat with nothing to set up: your vault synced across your devices,
            {credit ? ` ${credit} of AI to try during the trial,` : " AI included with your plan,"} and the Chrome extension.
          </p>
          <h3>Next, Stripe asks for a card</h3>
          <p className="auth-copy">
            Cards help us keep spam accounts out. You won&apos;t be charged during your {length}.
            If you keep Plus, it&apos;s $20 a month from {trialEnd ?? "the end of the trial"}, and each payment adds $20 to your AI budget.
          </p>
          <div className="trial-offer-promise">
            <strong>Cancel in one click</strong>
            <p>
              Settings → Billing → Cancel free trial, any time before {trialEnd ?? "the trial ends"}.
              No survey, no retention offers, and your card is never charged.
            </p>
          </div>
          {errorMessage ? <p className="auth-error" role="alert">{errorMessage}</p> : null}
          <div className="billing-action-stack">
            <button className="primary-button auth-submit" disabled={isSubmitting} onClick={() => { void onStart(); }} type="button">
              {isSubmitting ? "Opening Stripe..." : `Start my ${length}`}
            </button>
            <button className="ghost-button" disabled={isSubmitting} onClick={onSkip} type="button">
              Skip and use Margin Chat free
            </button>
          </div>
          <p className="trial-offer-footnote">
            Signed in as {user.email}. The free app keeps your vault on this device and uses your own AI keys; you can start the trial later from Billing.
          </p>
        </section>
      </div>
    </div>
  );
}
