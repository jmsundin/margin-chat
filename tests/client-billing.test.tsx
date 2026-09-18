import { afterEach, describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "../client/node_modules/react-dom/server.node.js";
import BillingDashboard from "../client/src/components/BillingDashboard";
import {
  getBillingDisplayLabel, getBillingStatusCopy, getCheckoutConfirmationNotice,
  getCheckoutReturn, getReceiptUrl, parseTopUpAmountCents,
} from "../client/src/lib/billing";
import { requestBillingDashboard, requestConfirmCheckoutSession, requestCreateTopUpSession, requestCreateCheckoutSession, requestCreateBillingPortalSession } from "../client/src/lib/api";
import { billingDashboard, billingUser } from "./helpers/billingFixture";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

describe("prepaid billing", () => {
  test("converts exact decimal amounts to cents and rejects invalid or out-of-range amounts", () => {
    for (const [value, cents] of [["5", 500], ["5.01", 501], ["20.10", 2010], ["499.99", 49999], [" 500.00 ", 50000]] as const) {
      expect(parseTopUpAmountCents(value)).toBe(cents);
    }
    for (const value of ["", "4.99", "500.01", "20.001", "1e2", "-20", "NaN", "Infinity", "$20", "20,00", "99999999999999999999"]) {
      expect(parseTopUpAmountCents(value)).toBeNull();
    }
  });

  test("recognizes both subscription and top-up return URLs without treating the URL as payment proof", () => {
    for (const result of ["subscription_success", "success", "topup_success"]) {
      expect(getCheckoutReturn(new URLSearchParams(`checkout=${result}&session_id=cs_test`))).toEqual({ kind: "success", sessionId: "cs_test" });
    }
    for (const result of ["subscription_canceled", "canceled", "topup_canceled"]) {
      expect(getCheckoutReturn(new URLSearchParams(`checkout=${result}`))).toEqual({ kind: "canceled", sessionId: null });
    }
    expect(getCheckoutReturn(new URLSearchParams("checkout=success"))).toEqual({ kind: "success", sessionId: null });
    expect(getCheckoutReturn(new URLSearchParams("checkout=unknown"))).toBeNull();
    for (const purchaseKind of ["subscription", "hosted_credits"] as const) {
      const pending = getCheckoutConfirmationNotice({ purchaseKind, confirmed: false, status: "unpaid" });
      expect(pending.kind).toBe("info");
      expect(pending.message).toContain("not confirmed yet");
      expect(pending.message).not.toContain("has been added");
      expect(getCheckoutConfirmationNotice({ purchaseKind, confirmed: true, status: "paid" }).kind).toBe("success");
    }
  });

  test("explains rollover, prepaid renewal and personal-key billing without offering free hosted calls", () => {
    expect(getBillingStatusCopy(billingUser.billing)).toContain("$20 per month adds $20");
    expect(getBillingStatusCopy(billingUser.billing)).toContain("carry over");
    expect(getBillingStatusCopy({ ...billingUser.billing, status: "canceled" })).toContain("unused balance remains available");
    const newAccount = { ...billingUser.billing, accessKind: "trial" as const, status: "inactive" as const, creditBalanceMicros: 0, trialCallsRemaining: 100 };
    expect(getBillingDisplayLabel(newAccount)).toBe("Prepaid AI usage");
    expect(getBillingStatusCopy(newAccount)).toContain("Personal API keys");
    expect(getBillingStatusCopy(newAccount)).not.toContain("free");
    expect(getBillingStatusCopy(newAccount)).not.toContain("100");
  });

  test("shows spendable balance without deducting reservations twice, precise costs, receipts and estimates", () => {
    const html = renderToStaticMarkup(<BillingDashboard data={billingDashboard} loading={false} errorMessage={null} checkoutErrorMessage={null}
      isSubmitting={false} user={billingUser} onRefresh={() => {}} onAddMoney={() => {}} onStartSubscription={() => {}} onManageBilling={() => {}} />);
    for (const text of ["$17.123456", "$2.00", "$0.876544", "−$0.000544", "+$20.00", "Unused credits carry over", "Estimated usage", "reservation estimate", "member@example.test", "Manage subscription"]) expect(html).toContain(text);
    expect(html).not.toContain("$15.123456");
    expect(html).toContain('href="https://pay.stripe.com/receipts/test"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(getReceiptUrl("javascript:alert(1)")).toBeNull();
    expect(getReceiptUrl("http://example.test/receipt")).toBeNull();
  });

  test("keeps last known amounts visibly stale when refresh fails, and cancellation retains credit", () => {
    const html = renderToStaticMarkup(<BillingDashboard data={{ ...billingDashboard, subscription: { ...billingDashboard.subscription, cancelAtPeriodEnd: true } }} loading={false}
      errorMessage="Network unavailable." checkoutErrorMessage={null} isSubmitting={false} user={billingUser}
      onRefresh={() => {}} onAddMoney={() => {}} onStartSubscription={() => {}} onManageBilling={() => {}} />);
    expect(html).toContain("Network unavailable.");
    expect(html).toContain("last successful refresh");
    expect(html).toContain("Your remaining credits stay available");
  });
});

describe("billing API contracts", () => {
  test("loads current dashboard without browser cache and preserves account refresh data", async () => {
    let request: [unknown, RequestInit | undefined] | undefined;
    globalThis.fetch = (async (url, init) => { request = [url, init]; return Response.json(billingDashboard); }) as typeof fetch;
    expect(await requestBillingDashboard()).toEqual(billingDashboard);
    expect(request?.[0]).toBe("/api/billing/dashboard");
    expect(request?.[1]).toMatchObject({ credentials: "same-origin", cache: "no-store" });
  });

  test("rejects malformed money/history responses and surfaces server errors", async () => {
    for (const payload of [{ ...billingDashboard, balanceMicros: -1 }, { ...billingDashboard, reservedMicros: 0.5 }, { ...billingDashboard, transactions: [{}] }]) {
      globalThis.fetch = (async () => Response.json(payload)) as typeof fetch;
      await expect(requestBillingDashboard()).rejects.toThrow("invalid billing information");
    }
    globalThis.fetch = (async () => Response.json({ error: "Sign in again." }, { status: 401 })) as typeof fetch;
    await expect(requestBillingDashboard()).rejects.toThrow("Sign in again.");
  });

  test("posts integer cents and blocks invalid top-ups before creating Checkout", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = (async (url, init) => { requests.push({ url: String(url), init }); return Response.json({ url: "https://checkout.stripe.com/test" }); }) as typeof fetch;
    for (const amount of [499, 50001, 2000.5, Number.NaN]) await expect(requestCreateTopUpSession(amount)).rejects.toThrow("$5 to $500");
    expect(requests).toHaveLength(0);
    expect(await requestCreateTopUpSession(2001)).toBe("https://checkout.stripe.com/test");
    expect(requests[0].url).toBe("/api/billing/topup");
    expect(requests[0].init).toMatchObject({ method: "POST", credentials: "same-origin" });
    expect(JSON.parse(String(requests[0].init?.body))).toEqual({ amountCents: 2001 });
  });

  test("rejects billing responses for an account that changed in another tab", async () => {
    globalThis.fetch = (async () => Response.json(billingDashboard)) as typeof fetch;
    await expect(requestBillingDashboard("another-user")).rejects.toThrow("signed-in account changed");
    expect(await requestBillingDashboard(billingUser.id)).toEqual(billingDashboard);
    globalThis.fetch = (async () => Response.json({ confirmed: true, status: "paid", purchaseKind: "hosted_credits", user: billingUser })) as typeof fetch;
    await expect(requestConfirmCheckoutSession("cs_returned", "another-user")).rejects.toThrow("signed-in account changed");
    expect((await requestConfirmCheckoutSession("cs_returned", billingUser.id)).confirmed).toBe(true);
  });

  test("requires server confirmation and supports unsettled and paid top-up returns", async () => {
    for (const confirmed of [false, true]) {
      const payload = { confirmed, status: confirmed ? "paid" : "unpaid", purchaseKind: "hosted_credits", user: billingUser };
      globalThis.fetch = (async (url, init) => {
        expect(url).toBe("/api/billing/checkout/confirm");
        expect(JSON.parse(String(init?.body))).toEqual({ sessionId: "cs_returned" });
        return Response.json(payload);
      }) as typeof fetch;
      expect(await requestConfirmCheckoutSession("cs_returned")).toEqual(payload);
    }
    globalThis.fetch = (async () => Response.json({ confirmed: true, status: "paid" })) as typeof fetch;
    await expect(requestConfirmCheckoutSession("cs_returned")).rejects.toThrow("invalid payment confirmation");
    globalThis.fetch = (async () => Response.json({ error: "Payment still processing." }, { status: 503 })) as typeof fetch;
    await expect(requestConfirmCheckoutSession("cs_returned")).rejects.toThrow("Payment still processing.");
  });

  test("binds every billing request to the displayed account before the server performs a financial action", async () => {
    const requests: string[] = [];
    globalThis.fetch = (async (url, init) => {
      expect(new Headers(init?.headers).get("X-Margin-Billing-User")).toBe(billingUser.id);
      requests.push(String(url));
      if (String(url).endsWith("/dashboard")) return Response.json(billingDashboard);
      if (String(url).endsWith("/confirm")) return Response.json({ confirmed: true, status: "paid", purchaseKind: "hosted_credits", user: billingUser });
      return Response.json({ url: "https://checkout.stripe.com/test" });
    }) as typeof fetch;
    await requestBillingDashboard(billingUser.id);
    await requestConfirmCheckoutSession("cs_returned", billingUser.id);
    await requestCreateCheckoutSession(billingUser.id);
    await requestCreateTopUpSession(2000, billingUser.id);
    await requestCreateBillingPortalSession(billingUser.id);
    expect(requests).toHaveLength(5);
  });
});

test("mounted billing controls refresh on focus, validate cents, and preserve the billing tab on account updates", async () => {
  const child = Bun.spawn([process.execPath, "tests/helpers/billingDashboardHarness.ts"], {
    cwd: new URL("..", import.meta.url).pathname, stdout: "pipe", stderr: "pipe",
  });
  const timeout = setTimeout(() => child.kill(), 10_000);
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  clearTimeout(timeout);
  if (exitCode !== 0) throw new Error(`Billing UI regression failed:\n${stdout}\n${stderr}`);
  expect(JSON.parse(stdout.trim().split("\n").at(-1)!).checks).toHaveLength(7);
}, 15000);

test.each(["subscription", "topup", "pending", "failure", "missing", "canceled", "login", "portal", "portal-login"])("App handles billing return: %s", async (scenario) => {
  const child = Bun.spawn([process.execPath, "tests/helpers/billingReturnHarness.ts", scenario], {
    cwd: new URL("..", import.meta.url).pathname, stdout: "pipe", stderr: "pipe",
  });
  const timeout = setTimeout(() => child.kill(), 10_000);
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  clearTimeout(timeout);
  if (exitCode !== 0) throw new Error(`Checkout ${scenario} regression failed:\n${stdout}\n${stderr}`);
  expect(JSON.parse(stdout.trim().split("\n").at(-1)!).result).toBe("pass");
}, 15000);

test("late billing responses cannot overwrite a newer balance or redirect a different account", async () => {
  const child = Bun.spawn([process.execPath, "tests/helpers/billingAccountRaceHarness.ts"], {
    cwd: new URL("..", import.meta.url).pathname, stdout: "pipe", stderr: "pipe",
  });
  const timeout = setTimeout(() => child.kill(), 10_000);
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  clearTimeout(timeout);
  if (exitCode !== 0) throw new Error(`Billing account race failed:\n${stdout}\n${stderr}`);
  expect(JSON.parse(stdout.trim().split("\n").at(-1)!).result).toBe("pass");
}, 15000);
