import { useState } from "react";
import "./AuthLanding.css";
import type { AuthenticatedUser, BillingNotice, BillingPlan } from "../types";

// The website is for paying accounts: a new account picks Cloud or Cloud + AI, free for the trial, before
// its workspace opens. The desktop app is free without an account (docs/desktop-local-mode.md).

export interface PlanPickerProps {
  user: AuthenticatedUser;
  /** Back from Stripe, while the trial is confirmed. */
  confirming: boolean;
  submitting: boolean;
  errorMessage: string | null;
  notice: BillingNotice | null;
  onStart(plan: BillingPlan): Promise<void> | void;
  onLogout(): void;
  /** Asks the server again, such as after Stripe confirms a plan a moment later. */
  onCheckAgain(): void;
}

const PLANS: { plan: BillingPlan; name: string; price: string; points: string[] }[] = [
  {
    plan: "cloud", name: "Cloud", price: "$10",
    points: ["Your vault in the cloud, synced to every device", "Open it from any browser", "AI with your own API keys"],
  },
  {
    plan: "plus", name: "Cloud + AI", price: "$20",
    points: ["Everything in Cloud", "$20 of AI each month, no keys needed", "Unused AI credit carries over"],
  },
];

export default function PlanPicker({ user, confirming, submitting, errorMessage, notice, onStart, onLogout, onCheckAgain }: PlanPickerProps) {
  const [chosen, setChosen] = useState<BillingPlan | null>(null);
  const trialDays = user.billing.freeTrialDays ?? 0;
  const busy = submitting || confirming;
  if (confirming) {
    return (
      <div className="auth-loading-card plan-picker" aria-busy="true">
        <p className="eyebrow">Margin Chat</p>
        <h1>Starting your plan…</h1>
        <p className="auth-copy">Stripe is confirming it. Your workspace opens in a moment.</p>
      </div>
    );
  }
  return (
    <section className="auth-loading-card plan-picker" aria-labelledby="plan-picker-title">
      <p className="eyebrow">Margin Chat</p>
      <h1 id="plan-picker-title">{trialDays > 0 ? `Try it free for ${trialDays} days` : "Pick a plan"}</h1>
      <p className="auth-copy">
        {trialDays > 0
          ? "Pick a plan to open your workspace on the web. Stripe asks for your card now and charges it only when the trial ends. Cancel before then and you pay nothing."
          : "Pick a plan to open your workspace on the web. You can cancel at any time."}
      </p>
      {notice ? <p className={notice.kind === "error" ? "auth-error" : "auth-notice"} role={notice.kind === "error" ? "alert" : "status"}>{notice.message}{" "}
        {notice.kind !== "success" ? <button className="auth-switch-button" disabled={busy} onClick={onCheckAgain} type="button">Check again</button> : null}</p> : null}
      {errorMessage ? <p className="auth-error" role="alert">{errorMessage}</p> : null}
      <div className="plan-picker-plans">
        {PLANS.filter(({ plan }) => plan !== "cloud" || user.billing.cloudPlanAvailable !== false).map(({ plan, name, price, points }) => (
          <div className="plan-picker-plan" key={plan}>
            <h2>{name}</h2>
            <p className="plan-picker-price"><strong>{price}</strong> / month{trialDays > 0 ? " after the trial" : ""}</p>
            <ul>{points.map((point) => <li key={point}>{point}</li>)}</ul>
            <button className="primary-button" disabled={busy} type="button"
              onClick={() => { setChosen(plan); void onStart(plan); }}>
              {submitting && chosen === plan ? "Opening Stripe…" : trialDays > 0 ? "Start free trial" : `Choose ${name}`}
            </button>
          </div>
        ))}
      </div>
      <p className="plan-picker-free">
        Rather not pay? The <a href="/download">desktop app</a> is free with no account: open a folder of Markdown files and use your own AI keys.
      </p>
      <p className="plan-picker-account">
        Signed in as {user.email}.{" "}
        <button className="auth-switch-button" disabled={busy} onClick={onLogout} type="button">Log out</button>
      </p>
    </section>
  );
}
