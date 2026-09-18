# Stripe sandbox verification — September 18, 2026

The real application was tested against the Sundin Systems LLC sandbox with an isolated local PostgreSQL database. Stripe payments used test card `4242 4242 4242 4242`, expiration `12/34`, CVC `123`. No live Stripe charges were created.

## Open and restart

Open <http://127.0.0.1:4175> and choose **Profile → Billing**. The browser used for verification is signed in. Local test sign-in values are stored privately as `STRIPE_TEST_ACCOUNT_EMAIL` and `STRIPE_TEST_ACCOUNT_PASSWORD` in the gitignored `.env.stripe-test.local`. This account has the member role in the isolated database so prepaid limits apply.

Keep the app and listener running in separate terminals. To restart, stop the old processes, start Docker and the existing database container, then run:

```sh
docker start margin-chat-stripe-test-db
bun --no-env-file run stripe:test:listen
```

After the listener confirms that it saved the signing secret, run in another terminal:

```sh
bun --no-env-file run stripe:test
```

Run `bun run build` first after client edits. See [billing setup](billing.md) for configuration and database isolation details.

## Verified results

| Check | Result |
| --- | --- |
| Unfunded hosted request | Blocked; Billing opened with zero balance |
| Subscription through hosted Stripe Checkout | Paid $20 test payment; one $20 credit and receipt link |
| One-time Checkout top-up | Paid $12.34 test payment; one $12.34 credit and receipt link |
| Real hosted AI request | `gpt-5.6-luna` returned `ready`; 145 input and 5 output tokens charged $0.000035 |
| Reservation settlement | $0.000622 reserved; $0.000587 released; no pending hold |
| Monthly renewal | Stripe test clock advanced through renewal and invoice finalization; paid invoice added another $20 |
| Rollover | Previous funds retained; final balance $52.339965 from $52.34 purchased credit |
| Duplicate delivery | Actual initial, top-up, and renewal events each replayed twice through the signed webhook endpoint; six HTTP 200 responses, no balance or ledger changes |
| Customer portal | Payment method and invoice history available; cancellation scheduled for November 18, 2026 without removing prepaid credit |
| Portal return | Billing reopens automatically, refreshes the balance, and displays the scheduled funding end date |
| Repeatable local startup | Dedicated listener and app commands started successfully; an actual Stripe subscription update reached the new listener and returned HTTP 200 |
| Receipt email | Successful-payments setting enabled; manual test receipt recorded as sent to the sandbox account email, `jon@sundinsystems.com` |

The application customer uses `sundinjon@gmail.com`. Stripe's sandbox receipt restriction caused the manual receipt to go to the sandbox account email instead. Receipt history, rather than the editable recipient field alone, was used to verify the destination. Automatic customer receipt delivery must also be verified when configuring live mode.

The local usage test configuration caps responses at 128 output tokens and selects a verified priced model. Stripe credit is simulated money; real AI calls still incur provider charges. The one request above cost $0.000035. See [metering configuration](hosted-usage-metering.md) before changing models or limits.

Final verification: **641 tests passed across 78 files**, zero failures and 2,901 assertions. The production client build and whitespace checks passed. After rebuilding, close and reopen local app tabs to let the offline service worker activate the new build.

## Sandbox resources

| Resource | ID |
| --- | --- |
| Sandbox account | `acct_1SxG9fQXfmJmFk6z` |
| Product | `prod_VHcYRhXSolPOar` |
| $20 monthly price | `price_1UH3J5QXfmJmFk6zn9k0npva` |
| Customer portal configuration | `bpc_1UH3JmQXfmJmFk6z1ah4YAqi` |
| Test clock | `clock_1UH3JoQXfmJmFk6zr0uWMhgT` |
| Customer | `cus_VHcYxBtwsEChw0` |
| Subscription | `sub_1UH3LJQXfmJmFk6zWOOoCct3` |
| Initial invoice | `in_1UH3LIQXfmJmFk6zZdFTHlzQ` |
| Renewal invoice | `in_1UH3NBQXfmJmFk6zOMIv7WfO` |

The portal configuration permits payment-method updates, invoice history, and cancellation at period end. Plan changes, quantity changes, pause, and customer-profile updates are disabled. Stripe automatically marked this first sandbox portal configuration as its default; the app explicitly uses its configuration ID.

The test clock is frozen after October's renewal. The subscription remains active with cancellation scheduled in November. Use **Manage subscription** to undo cancellation or advance this clock to test the final cancellation event. These resources and all test balances are isolated from the live Stripe account and production database.
