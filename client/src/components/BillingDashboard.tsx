import { useEffect, useState, type FormEvent } from "react";
import NotificationToast from "./NotificationToast";
import type { AuthenticatedUser, BillingDashboardData, BillingNotice } from "../types";
import {
  formatBillingPeriodEnd, formatCreditBalance, formatUsageCost, getBillingStatusLabel,
  getReceiptUrl, parseTopUpAmountCents,
} from "../lib/billing";

interface BillingDashboardProps {
  data: BillingDashboardData | null;
  loading: boolean;
  errorMessage: string | null;
  checkoutErrorMessage: string | null;
  notice?: BillingNotice | null;
  isSubmitting: boolean;
  onRefresh: () => void | Promise<void>;
  onAddMoney: (amountCents: number) => void | Promise<void>;
  onStartSubscription: () => void | Promise<void>;
  onManageBilling: () => void | Promise<void>;
  user: AuthenticatedUser;
}

export default function BillingDashboard({
  data, loading, errorMessage, checkoutErrorMessage, notice, isSubmitting,
  onRefresh, onAddMoney, onStartSubscription, onManageBilling, user,
}: BillingDashboardProps) {
  const [amount, setAmount] = useState("20.00");
  const [amountError, setAmountError] = useState<string | null>(null);

  useEffect(() => {
    void onRefresh();
    const refresh = () => { void onRefresh(); };
    const interval = window.setInterval(() => {
      if (document.visibilityState !== "hidden") refresh();
    }, 30_000);
    window.addEventListener("focus", refresh);
    return () => {
      window.removeEventListener("focus", refresh);
      window.clearInterval(interval);
    };
  }, [onRefresh]);

  async function submitTopUp(event: FormEvent) {
    event.preventDefault();
    const cents = parseTopUpAmountCents(amount);
    if (cents === null) {
      setAmountError("Enter $5 to $500, using no more than two decimal places.");
      return;
    }
    setAmountError(null);
    try { await onAddMoney(cents); }
    catch (error) { setAmountError(error instanceof Error ? error.message : "Unable to open Checkout."); }
  }

  const subscription = data?.subscription ?? user.billing;
  const subscribed = ["active", "trialing", "past_due", "unpaid", "paused"].includes(subscription.status);
  const monthlyAmount = formatCreditBalance(data?.plan.monthlyAmountMicros ?? 20_000_000);
  const periodEnd = formatBillingPeriodEnd(subscription.currentPeriodEnd);

  return (
    <div className="billing-dashboard">
      <header className="billing-dashboard-heading">
        <div><p className="eyebrow">Your AI budget</p><h2>Balance & billing</h2></div>
        <button className="thread-dialog-button" disabled={loading} onClick={() => void onRefresh()} type="button">
          {loading ? "Refreshing…" : "Refresh balance"}
        </button>
      </header>

      <NotificationToast message={notice?.message ?? null} kind={notice?.kind} />
      {errorMessage ? <p className="profile-dialog-error" role="alert">{errorMessage}{data ? " The amounts below are from the last successful refresh." : ""}</p> : null}
      {checkoutErrorMessage ? <p className="profile-dialog-error" role="alert">{checkoutErrorMessage}</p> : null}
      {!data && loading ? <p role="status">Loading your balance and payments…</p> : null}

      <dl className="billing-balance-grid" aria-label="AI budget overview" aria-busy={loading}>
        <div className="billing-balance-card is-available">
          <dt>Available balance</dt><dd>{data ? formatUsageCost(data.balanceMicros) : "—"}</dd>
          <small>Ready for hosted AI usage</small>
        </div>
        {data?.reservedMicros !== undefined ? <div className="billing-balance-card">
          <dt>In progress</dt><dd>{formatUsageCost(data.reservedMicros)}</dd><small>Reserved for running requests</small>
        </div> : null}
        <div className="billing-balance-card">
          <dt>Used this month</dt><dd>{data ? formatUsageCost(data.usageThisMonthMicros) : "—"}</dd><small>Settled API usage this calendar month</small>
        </div>
        <div className="billing-balance-card">
          <dt>Total added</dt><dd>{data ? formatCreditBalance(data.totalPurchasedMicros) : "—"}</dd><small>Monthly credit and one-time payments</small>
        </div>
      </dl>
      <p className="billing-budget-help">Hosted AI requests draw from your prepaid balance based on API usage. Reservations are separate from the available amount and settle when a request finishes. Interrupted requests without final usage totals may be charged using the reservation estimate. Personal API keys are billed directly by their provider.</p>

      <div className="billing-funding-grid">
        <section className="billing-funding-card" aria-label="Monthly subscription">
          <p className="eyebrow">Monthly funding</p>
          <h3>{monthlyAmount}<span> / month</span></h3>
          <p>Each successful monthly payment adds {monthlyAmount} to your AI budget. Unused credits carry over.</p>
          <p className="billing-plan-status">{getBillingStatusLabel(subscription.status)}{periodEnd ? ` · ${subscription.cancelAtPeriodEnd ? "Funding ends" : "Current period ends"} ${periodEnd}` : ""}</p>
          {subscription.cancelAtPeriodEnd ? <p>Future monthly payments are canceled. Your remaining credits stay available.</p> : null}
          <button className="thread-dialog-button is-primary" disabled={isSubmitting}
            onClick={() => void (subscribed ? onManageBilling() : onStartSubscription())} type="button">
            {isSubmitting ? "Opening Stripe…" : subscribed ? "Manage subscription" : `Subscribe for ${monthlyAmount}/month`}
          </button>
        </section>
        <form className="billing-funding-card" aria-label="Add money" onSubmit={(event) => void submitTopUp(event)}>
          <p className="eyebrow">One-time payment</p><h3>Add money</h3>
          <p>Top up whenever you need more credit. The money stays in your balance until you use it.</p>
          <label className="thread-dialog-field" htmlFor="billing-topup-amount">
            <span className="thread-dialog-label">Amount in USD</span>
            <input id="billing-topup-amount" className="thread-dialog-input" inputMode="decimal" type="text"
              value={amount} onChange={(event) => { setAmount(event.target.value); setAmountError(null); }}
              aria-describedby={amountError ? "billing-topup-hint billing-topup-error" : "billing-topup-hint"} aria-invalid={Boolean(amountError)} />
          </label>
          <small id="billing-topup-hint">$5–$500. Payments are completed securely in Stripe Checkout.</small>
          {amountError ? <p className="profile-dialog-error" id="billing-topup-error" role="alert">{amountError}</p> : null}
          <button className="thread-dialog-button is-primary" disabled={isSubmitting} type="submit">{isSubmitting ? "Opening Stripe…" : "Continue to Checkout"}</button>
        </form>
      </div>

      <section className="billing-history" aria-label="Transactions and receipts">
        <div className="billing-dashboard-heading"><h3>Transactions & receipts</h3>
          {user.billing.hasCustomer ? <button className="thread-dialog-button" disabled={isSubmitting} onClick={() => void onManageBilling()} type="button">Stripe billing & invoices</button> : null}
        </div>
        <p className="billing-budget-help">Payment receipts are emailed to {user.email}. You can also open available receipts below.</p>
        {data?.transactions.length ? <div className="billing-history-scroll"><table className="billing-history-table">
          <caption className="sr-only">Recent balance activity</caption>
          <thead><tr><th scope="col">Date</th><th scope="col">Activity</th><th scope="col">Amount</th><th scope="col">Receipt</th></tr></thead>
          <tbody>{data.transactions.map((transaction) => {
            const receiptUrl = getReceiptUrl(transaction.receiptUrl);
            return <tr key={transaction.id}>
              <td><time dateTime={transaction.createdAt}>{formatBillingPeriodEnd(transaction.createdAt) ?? "Date unavailable"}</time></td>
              <td>{transaction.description || transaction.type.replaceAll("_", " ")}{transaction.metadata?.usageSource === "estimated-upper-bound" ? <small className="billing-usage-estimate">Estimated usage · final provider usage was unavailable</small> : null}</td>
              <td className={transaction.amountMicros > 0 ? "is-credit" : ""}>{transaction.amountMicros > 0 ? "+" : transaction.amountMicros < 0 ? "−" : ""}{formatUsageCost(Math.abs(transaction.amountMicros))}</td>
              <td>{receiptUrl ? <a href={receiptUrl} target="_blank" rel="noopener noreferrer">Receipt<span className="sr-only"> for {transaction.description}</span></a> : "—"}</td>
            </tr>;
          })}</tbody>
        </table></div> : <p className="billing-history-empty">{data ? "No transactions yet. Your payments and API usage will appear here." : "Refresh billing to load your transactions."}</p>}
      </section>
    </div>
  );
}
