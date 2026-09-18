# Prepaid billing and Stripe setup

Margin Chat's $20 USD monthly subscription deposits $20 of prepaid hosted-model balance after the initial invoice is paid and after each paid renewal. Unused balance rolls over, including after cancellation. A subscription's active status alone does not grant funds or allow unfunded hosted requests. Members can also add $5–$500 in whole cents without a subscription. Personal provider keys and administrator access retain their existing behavior.

The billing dashboard reports spendable balance, separate funds reserved by in-progress requests, usage this UTC month, purchased funds, subscription status, and a transaction list with receipt links. Amounts are integer millionths of a US dollar: $20 is `20000000`. Spendable balance already excludes reservations; clients must not subtract them again.

Hosted model use requires explicit pricing through `HOSTED_MODEL_PRICES_JSON`. Unpriced models are rejected before sending a paid request. Configure exact provider/model names, current rates, and Gemini thinking bounds using the [hosted usage metering guide](hosted-usage-metering.md).

## Configure Stripe

1. Set server-only `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, and `APP_URL` for the target environment. Use test keys locally and live keys only for production. Never expose these through a `VITE_` variable.
2. Optionally set `STRIPE_PRICE_ID` to an active Price for exactly **2000 USD cents, recurring every one month, licensed, per-unit**. Quantity transformations, tiered/metered prices, other currencies and other intervals are rejected. If this variable is absent, the application supplies the same monthly price inline and marks the product as the Margin Chat prepaid plan. Stripe supports recurring inline prices through Checkout's `line_items.price_data`. [Stripe Checkout API](https://docs.stripe.com/api/checkout/sessions/create)
3. Configure a webhook destination at `https://YOUR_APP/api/billing/webhook`. Subscribe to `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `invoice.paid`, `invoice.payment_succeeded`, `invoice.payment_failed`, and `customer.subscription.created`, `.updated`, `.deleted`, `.paused`, `.resumed`. Copy that endpoint's signing secret into `STRIPE_WEBHOOK_SECRET`. The handler verifies the exact raw body before processing it. Stripe can retry events and deliver them out of order; grants use durable invoice/session keys, and subscription events retrieve current Stripe state. [Stripe webhooks](https://docs.stripe.com/webhooks), [subscription events](https://docs.stripe.com/billing/subscriptions/webhooks)
4. Enable **Successful payments** under Stripe Dashboard → Settings → Business → Customer emails. This sends subscription payment receipts to the customer email. Checkout creation updates the Stripe customer's email from the signed-in account; top-ups additionally set the PaymentIntent's `receipt_email`. Stripe test-mode receipts are not sent automatically; use the Dashboard to send a test receipt manually. Sandboxes restrict email recipients to users with sandbox access, so confirm the actual recipient in the payment's **Receipt history**. [Stripe receipts](https://docs.stripe.com/receipts)
5. Configure the Stripe Customer Portal for subscription cancellation and payment-method updates. Optionally set `STRIPE_PORTAL_CONFIGURATION_ID=bpc_...` to select a dedicated portal configuration without changing the account's default settings. An omitted or blank value uses Stripe's default portal configuration. Keep plan changes, quantity changes, trials, and discounts disabled for this fixed prepaid plan: discounted, prorated or ambiguous invoices do not grant funds.

No live Stripe resources, webhook destinations, email preferences, or customer messages are configured by the code change. These account settings must be applied before accepting real payments.

## Payment verification and reconciliation

Both the checkout return confirmation and webhooks use the same grant functions. A subscription credit is keyed only by invoice ID, so confirmation followed by repeated invoice/checkout notifications still adds $20 once. Each one-time top-up is keyed by Checkout Session ID. Database transactions enforce ownership and amount consistency on retries.

The monthly grant requires a paid USD subscription-create or subscription-cycle invoice with one unprorated quantity-one plan line for $20, no discounts or credit-note/balance adjustments, and payments allocated to the full invoice amount. Its customer must match the owning account and subscription. InvoicePayment allocations are verified against succeeded, captured, unrefunded, undisputed PaymentIntents; the implementation also accepts the older `invoice.payment_intent` representation. Stripe's allocation amount matters because one PaymentIntent can cover more than one invoice. [InvoicePayment object](https://docs.stripe.com/api/invoice-payment/object)

A fully paid invoice with the $20 base line plus tax grants $20, not the tax amount. The application does not enable automatic tax or promotions. Top-ups require the exact server-created amount and product marker, with no tax, shipping, or discount adjustments. Unpaid, zero-value, unrelated, manually marked-paid/out-of-band, charge-only legacy, or payment-record invoices do not receive credit. No grant occurs solely from `subscription.active` or `checkout.session.completed`.

New customer creation uses a stable per-user Stripe idempotency key. If an invoice arrives before the database customer link exists, linking requires an existing user account plus matching Stripe customer metadata and email. Older subscription notifications cannot replace a newer subscription, and concurrent replacements retry after a database compare-and-swap miss.

The dashboard stores Stripe receipt links with purchases. Stripe receipt links expire after 30 days; Stripe can send a refreshed link after verifying the customer's original email. [Stripe receipt links](https://docs.stripe.com/receipts)

Refunds and disputes occurring **after** a credit grant do not automatically reverse already granted application balance. Handle these with a deliberate balance adjustment/reconciliation process before introducing self-service refunds. The payment verifier prevents a new grant from already refunded or disputed payments.

## Local checks

Use `bun test tests/billing-subscription.test.ts tests/billing-ledger.test.ts tests/billing-routes.test.ts` to exercise invoice eligibility, paid first/renewal invoices, top-ups, signature validation, duplicate/reordered notifications, ownership, and ledger settlement. These tests use local Stripe fixtures and real signature cryptography without contacting Stripe.

For an end-to-end sandbox check, use Stripe test keys, forward test webhook events to the local `/api/billing/webhook` endpoint, and use Stripe Checkout test payments. Confirm a $20 initial purchase, advance a test subscription to renewal, complete a top-up, and replay each notification. Check that each purchase appears once with the right balance and receipt link. Also exercise an unpaid payment and a canceled subscription with remaining balance. Test email delivery using Stripe's manual test receipt action.

## Isolated local Stripe sandbox

`scripts/stripe-test.mjs` serves the current `dist/` client and the real application API at `http://127.0.0.1:4175`. Start it with `bun --no-env-file run stripe:test` after `bun run build`. The package command invokes the Node HTTP runtime, matching the normal server; Bun remains the package/build/test tool.

This runner reads only the explicitly named environment file and rejects live Stripe keys, remote database hosts, other database names/ports, and database URL parameters. It never loads `.env`, `client/.env`, or ambient application credentials. The dedicated file is gitignored and should remain readable only by its owner (`0600`). Required settings are:

```dotenv
HOST=127.0.0.1
PORT=4175
APP_URL=http://127.0.0.1:4175
NODE_ENV=development
DB_SCHEMA_MODE=migrate
SECURE_AUTH_COOKIES=false
DATABASE_URL=postgresql://margin_chat_stripe_test:GENERATED_PASSWORD@127.0.0.1:55432/margin_chat_stripe_test
API_KEY_ENCRYPTION_KEY=GENERATED_32_BYTE_BASE64_KEY
STRIPE_SECRET_KEY=sk_test_YOUR_SANDBOX_KEY
STRIPE_WEBHOOK_SECRET=whsec_YOUR_LOCAL_LISTENER_SECRET
```

The isolated Docker container is `margin-chat-stripe-test-db`, using `pgvector/pgvector:pg16`, loopback port `55432`, and the persistent volume `margin-chat-stripe-test-data`. Start an existing container with `docker start margin-chat-stripe-test-db`; stop it with `docker stop margin-chat-stripe-test-db`. Keep the volume to preserve test accounts and payment history. This container is separate from the project's normal `margin-chat-postgres` database. The runner applies checked-in migrations only to its guarded dedicated test database.

For repeatable restarts, stop the previous local app and webhook listener, start the existing database, and then use two terminals in this order:

```sh
# Terminal 1: configure the signing secret, then keep forwarding test events.
bun --no-env-file run stripe:test:listen

# Terminal 2: after the listener says the secret was saved, start the app.
bun --no-env-file run stripe:test
```

The listener helper uses Bun to launch Stripe CLI 1.51.0. It reads the explicit `.env.stripe-test.local`, validates its test key and isolated database settings, obtains the signing secret with `listen --print-secret`, and updates only `STRIPE_WEBHOOK_SECRET` in that file with permissions `0600`. Both CLI invocations use the same validated test key through `STRIPE_API_KEY`, avoiding credentials in process arguments or mismatches with an ambient login. The child CLI runs from an empty temporary directory with a restricted environment so Bun cannot discover another project's environment file. API keys and signing secrets are redacted from forwarded output.

The default CLI configuration is `~/.config/stripe/margin-chat-test.toml` and project name is `margin-chat-test`. Use `bun --no-env-file run stripe:test:listen --config /path/to/sandbox.toml --project-name sandbox-name` to select a different scoped CLI configuration. To select another environment file, run `bun --no-env-file scripts/stripe-test-listen.mjs /path/to/isolated.env` and start `node scripts/stripe-test.mjs /path/to/isolated.env`. The helper only forwards test events to the fixed local billing webhook, accepts no live-mode flag, and does not restart an existing app or listener. When switching from a manually authenticated listener or changing the test key, start the app after the helper saves the new secret; the previous signing secret may differ.

Sign up through the local app to create a test account; neither runner seeds users or passwords. The optional price ID can stay unset to use inline $20 monthly pricing.

Without model credentials, `/api/health` reports a degraded service while its database readiness remains true; signup, billing, and the dashboard still work. Provider usage tests additionally require a provider key and verified hosted-model prices in this same isolated file. Stripe sandbox balance is simulated money; any real model-provider request still incurs that provider's normal charge.
