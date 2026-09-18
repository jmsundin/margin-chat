import { afterEach, expect, test } from "bun:test";
import { createCaptureTestDatabase } from "./helpers/captureDatabase.mjs";
import { fixture, user } from "./helpers/stripeFixture";
import * as repository from "../server/db/billingRepository.mjs";
import { createBillingService } from "../server/billing/index.mjs";
import { createHostedUsageMeter, runMeteredProviderOperation } from "../server/billing/usage.mjs";

const databases: any[] = [];
afterEach(async () => { await Promise.all(databases.splice(0).map((pg) => pg.close())); });

test("verified subscription and renewal payments, measured usage and top-ups share one real ledger", async () => {
  const { client, pg } = await createCaptureTestDatabase(); databases.push(pg);
  await client.query("insert into marginchat_users (id,email,password_hash,display_name,stripe_customer_id) values ($1,$2,'hash',$3,'cus_1')", [user.id, user.email, user.displayName]);
  const database = Object.fromEntries(Object.entries(repository).map(([name, operation]) => [name, (args: any) => operation(client, args)]));
  const f = fixture();
  const billingService = createBillingService({ database, env: { STRIPE_PRICE_ID: f.price.id, STRIPE_WEBHOOK_SECRET: "whsec_fixture" }, stripeClient: f.stripe });
  const webhook = (type: string, object: any) => billingService.handleWebhook({ rawBody: JSON.stringify({ type, data: { object } }), signature: "valid" });
  const confirm = () => billingService.confirmCheckout({ sessionId: f.session.id, user });

  expect((await confirm()).confirmed).toBe(true);
  await webhook("checkout.session.completed", f.session);
  await webhook("invoice.paid", f.invoice);
  expect(await billingService.getBillingDashboard(user.id)).toMatchObject({ balanceMicros: 20_000_000, totalPurchasedMicros: 20_000_000, subscription: { status: "active" } });

  const meter = createHostedUsageMeter({ billingService, userId: user.id, requestId: "measured-request", env: {
    HOSTED_MODEL_PRICES_JSON: JSON.stringify({ "openai:fixture-model": { inputMicrosPerMillionTokens: 2_000_000, outputMicrosPerMillionTokens: 8_000_000 } }),
  } });
  await runMeteredProviderOperation(meter, { provider: "openai", model: "fixture-model", body: { model: "fixture-model", input: "A test message" }, maxOutputTokens: 256 }, async (tracker: any) => {
    tracker.markDispatched();
    const during = await billingService.getBillingDashboard(user.id);
    expect(during.reservedMicros).toBeGreaterThan(0);
    expect(during.balanceMicros + during.reservedMicros).toBe(20_000_000);
    tracker.recordUsage({ usage: { input_tokens: 100, output_tokens: 50 } });
  });
  expect(await billingService.getBillingDashboard(user.id)).toMatchObject({ balanceMicros: 19_999_400, reservedMicros: 0, usageThisMonthMicros: 600 });

  f.invoice.id = "in_renewal"; f.invoice.billing_reason = "subscription_cycle";
  f.invoice.payments.data[0].invoice = f.invoice.id;
  f.invoice.payments.data[0].id = "inpay_renewal";
  f.intent.id = "pi_renewal"; f.invoice.payments.data[0].payment.payment_intent = f.intent.id;
  await webhook("invoice.paid", f.invoice);
  await webhook("invoice.payment_succeeded", f.invoice);
  expect((await billingService.getBillingDashboard(user.id)).balanceMicros).toBe(39_999_400);

  f.topup(1234); f.session.id = "cs_topup";
  expect((await confirm()).confirmed).toBe(true);
  await webhook("checkout.session.completed", f.session);
  const dashboard = await billingService.getBillingDashboard(user.id);
  expect(dashboard).toMatchObject({ balanceMicros: 52_339_400, reservedMicros: 0, usageThisMonthMicros: 600, totalPurchasedMicros: 52_340_000, plan: { monthlyAmountMicros: 20_000_000, rollover: true } });
  expect(dashboard.transactions).toHaveLength(4);
  expect(dashboard.transactions.filter((entry: any) => entry.amountMicros > 0).every((entry: any) => entry.receiptUrl?.startsWith("https://pay.stripe.com/"))).toBe(true);
}, 30_000);
