import { createBillingService } from "../../server/billing/index.mjs";
import { MONTHLY_PLAN_KEY } from "../../server/billing/plan.mjs";

export const user = { id: "user-1", email: "ada@example.com", displayName: "Ada Lovelace", role: "member" };
export const request = { headers: {} };

export function fixture({ inline = false } = {}) {
  let account: any = { ...user, stripeCustomerId: "cus_1", stripeSubscriptionId: null, billingStatus: "inactive", billingRevision: 0 };
  const price: any = { id: "price_monthly", active: true, currency: "usd", unit_amount: 2000, type: "recurring", billing_scheme: "per_unit", recurring: { interval: "month", interval_count: 1, usage_type: "licensed" }, product: { id: "prod_monthly", metadata: { marginChatPlan: MONTHLY_PLAN_KEY } } };
  const subscription: any = { id: "sub_1", created: 100, customer: "cus_1", status: "active", cancel_at_period_end: false, metadata: { userId: user.id, planKey: MONTHLY_PLAN_KEY }, items: { has_more: false, data: [{ id: "si_1", quantity: 1, price: { id: price.id }, current_period_end: 1_800_000_000 }] } };
  const invoice: any = { id: "in_first", status: "paid", currency: "usd", billing_reason: "subscription_create", customer: "cus_1", parent: { subscription_details: { subscription: "sub_1" } }, amount_paid: 2000, amount_due: 2000, amount_remaining: 0, subtotal: 2000, total: 2000, starting_balance: 0, ending_balance: 0, lines: { has_more: false, data: [{ id: "il_1", currency: "usd", amount: 2000, quantity: 1, pricing: { price_details: { price: price.id } }, parent: { type: "subscription_item_details", subscription_item_details: { subscription: "sub_1", subscription_item: "si_1", proration: false } } }] }, payments: { has_more: false, data: [{ id: "inpay_1", invoice: "in_first", status: "paid", currency: "usd", amount_paid: 2000, payment: { type: "payment_intent", payment_intent: "pi_1" } }] } };
  const intent: any = { id: "pi_1", customer: "cus_1", status: "succeeded", currency: "usd", amount_received: 2000, latest_charge: { id: "ch_1", paid: true, captured: true, refunded: false, disputed: false, amount_refunded: 0, receipt_url: "https://pay.stripe.com/receipts/test" } };
  const session: any = { id: "cs_test_purchase", mode: "subscription", customer: "cus_1", client_reference_id: user.id, metadata: { userId: user.id, purchaseKind: "subscription" }, status: "complete", payment_status: "paid", subscription: "sub_1", invoice: "in_first" };
  const calls = { checkouts: [] as any[], customers: [] as any[], creates: [] as any[], syncs: [] as any[], credits: [] as any[], reserves: [] as any[], settlements: [] as any[], refunds: [] as any[] };
  const credited = new Map<string, any>();
  const subscriptions = new Map<string, any>([[subscription.id, subscription]]);
  const customer: any = { id: "cus_1", email: user.email, metadata: { userId: user.id } };
  const database: any = {
    getUserBillingAccount: async (id: string) => id === user.id ? { ...account } : null,
    updateStripeCustomerId: async (args: any) => { calls.customers.push(args); account.stripeCustomerId = args.stripeCustomerId; },
    syncUserBillingById: async (args: any) => { calls.syncs.push(args); if (args.expectedStripeSubscriptionId !== account.stripeSubscriptionId || args.expectedBillingRevision !== account.billingRevision) return null; account = { ...account, ...args, billingRevision: account.billingRevision + 1 }; return { ...account }; },
    creditHostedBalance: async (args: any) => { calls.credits.push(args); const id = args.stripeInvoiceId ?? args.stripeCheckoutSessionId; if (credited.has(id)) return false; credited.set(id, args); return true; },
    getBillingDashboard: async () => ({ balanceMicros: 20_000_000, reservedMicros: 3000, transactions: [], subscription: { status: "active" } }),
    chargeHostedRequest: async (args: any) => { calls.reserves.push(args); return 10_000_000 - args.amountMicros; },
    settleHostedRequest: async (args: any) => { calls.settlements.push(args); return 10_000_000 - args.amountMicros; },
    refundHostedRequest: async (args: any) => { calls.refunds.push(args); },
  };
  const stripe: any = {
    checkout: { sessions: { create: async (args: any) => { calls.checkouts.push(args); return { url: "https://checkout.stripe.test/session" }; }, retrieve: async () => session } },
    customers: { retrieve: async () => customer, update: async (...args: any[]) => { calls.customers.push(args); }, create: async (...args: any[]) => { calls.creates.push(args); return customer; } },
    prices: { retrieve: async () => price },
    subscriptions: { retrieve: async (id: string) => { if (!subscriptions.has(id)) throw new Error(`Unknown subscription ${id}`); return subscriptions.get(id); } },
    invoices: { retrieve: async () => invoice },
    invoicePayments: { list: async () => invoice.payments },
    paymentIntents: { retrieve: async () => intent },
    webhooks: { constructEventAsync: async (body: string, signature: string) => { if (signature !== "valid") throw new Error("Invalid signature"); return JSON.parse(body); } },
  };
  const service = createBillingService({ database, env: { APP_URL: "https://margin.chat", STRIPE_WEBHOOK_SECRET: "whsec_test", ...(inline ? {} : { STRIPE_PRICE_ID: price.id }) }, stripeClient: stripe });
  const webhook = (type: string, object: any = invoice) => service.handleWebhook({ rawBody: JSON.stringify({ type, data: { object } }), signature: "valid" });
  const confirm = () => service.confirmCheckout({ sessionId: session.id, user });
  function topup(amountCents = 1234) {
    Object.assign(session, { mode: "payment", currency: "usd", amount_total: amountCents, amount_subtotal: amountCents, payment_intent: intent.id, metadata: { userId: user.id, purchaseKind: "hosted_credits", amountCents: String(amountCents), creditAmountMicros: String(amountCents * 10_000) }, line_items: { has_more: false, data: [{ quantity: 1, currency: "usd", amount_total: amountCents, amount_subtotal: amountCents, price: { currency: "usd", unit_amount: amountCents, type: "one_time", product: { metadata: { purchaseKind: "hosted_credits" } } } }] } });
    intent.amount_received = amountCents;
    intent.metadata = { ...session.metadata };
  }
  return { account: () => account, setAccount: (value: any) => { account = { ...account, ...value }; }, price, subscription, subscriptions, invoice, intent, session, customer, calls, credited, database, stripe, service, webhook, confirm, topup };
}
