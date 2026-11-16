import { createStatusError } from "../lib/errors.mjs";

/**
 * Sign-up's defenses against scripted accounts. Each is cheap and invisible to a person:
 * Cloudflare Turnstile (on only when TURNSTILE_SECRET_KEY is set), a hidden field that
 * only bots fill in, throwaway email domains, and one account per real inbox however the
 * address is spelled (Gmail dots, "+tags").
 */

const TURNSTILE_VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

export function turnstileConfigured(env) {
  return typeof env?.TURNSTILE_SECRET_KEY === "string" && env.TURNSTILE_SECRET_KEY.trim().length > 0;
}

/**
 * Checks the browser's Turnstile token with Cloudflare. Without a secret it lets the request
 * through, so nothing changes until the keys are added. If Cloudflare can't be reached the
 * attempt goes through and is logged: an outage there shouldn't stop people signing up, and
 * the shared rate limits still apply.
 */
export async function verifyTurnstile({ token, remoteIp, env, fetchImpl = fetch, timeoutMs = 8_000 }) {
  if (!turnstileConfigured(env)) return { checked: false };
  if (typeof token !== "string" || !token || token.length > 2048) {
    throw createStatusError(400, "Please complete the quick check that you're a person, then try again.");
  }
  let result;
  try {
    const body = new URLSearchParams({ secret: env.TURNSTILE_SECRET_KEY.trim(), response: token });
    if (remoteIp && remoteIp !== "unknown") body.set("remoteip", remoteIp);
    const response = await fetchImpl(TURNSTILE_VERIFY_URL, { method: "POST", body, signal: AbortSignal.timeout(timeoutMs) });
    result = await response.json();
  } catch (error) {
    console.error("Turnstile could not be reached; letting this attempt through.", error?.message ?? error);
    return { checked: false, unreachable: true };
  }
  if (result?.success !== true) {
    const codes = Array.isArray(result?.["error-codes"]) ? result["error-codes"].filter((code) => typeof code === "string").slice(0, 5) : [];
    // A wrong or missing secret is our setup, not the visitor: say so in the logs.
    if (codes.some((code) => code.includes("secret"))) console.error("Turnstile rejected the secret key:", codes.join(", "));
    throw createStatusError(400, "The check that you're a person didn't pass. Please try again.");
  }
  return { checked: true };
}

/** The hidden "website" field on the sign-up form: people never see it, so anything in it came from a bot. */
export function assertNoHoneypot(payload) {
  if (payload && typeof payload === "object" && typeof payload.website === "string" && payload.website.trim()) {
    throw createStatusError(400, "Sign-up didn't go through. Please try again.");
  }
}

// Well-known throwaway inbox services. Not exhaustive: it stops the lazy scripts, and
// Turnstile and the rate limits handle the rest.
const DISPOSABLE_DOMAINS = new Set([
  "10minutemail.com", "10minutemail.net", "20minutemail.com", "33mail.com", "anonaddy.me", "burnermail.io",
  "byom.de", "discard.email", "dispostable.com", "dropmail.me", "emailondeck.com", "fakeinbox.com",
  "fakemail.net", "getairmail.com", "getnada.com", "guerrillamail.biz", "guerrillamail.com", "guerrillamail.de",
  "guerrillamail.info", "guerrillamail.net", "guerrillamail.org", "guerrillamailblock.com", "harakirimail.com",
  "inboxbear.com", "inboxkitten.com", "maildrop.cc", "mailcatch.com", "maildrop.xyz", "mailinator.com",
  "mailinator.net", "mailinator2.com", "mailnesia.com", "mailpoof.com", "mailsac.com", "mailtemp.net",
  "mintemail.com", "moakt.com", "mohmal.com", "mytemp.email", "nada.email", "sharklasers.com", "spam4.me",
  "spamgourmet.com", "temp-mail.io", "temp-mail.org", "tempail.com", "tempmail.com", "tempmail.dev",
  "tempmail.net", "tempmailo.com", "tempr.email", "throwawaymail.com", "trashmail.com", "trashmail.de",
  "trashmail.net", "yopmail.com", "yopmail.fr", "yopmail.net",
]);

export function isDisposableEmail(email) {
  const domain = String(email ?? "").toLowerCase().split("@")[1] ?? "";
  if (!domain) return false;
  // Subdomains count too (for example anything.mailinator.com).
  const parts = domain.split(".");
  for (let index = 0; index < parts.length - 1; index += 1) {
    if (DISPOSABLE_DOMAINS.has(parts.slice(index).join("."))) return true;
  }
  return false;
}

export function assertNotDisposable(email) {
  if (isDisposableEmail(email)) {
    throw createStatusError(400, "Please use a permanent email address, so you can always get back into your account.");
  }
}

const GMAIL_DOMAINS = new Set(["gmail.com", "googlemail.com"]);

/**
 * The inbox an address really reaches: lowercase, without a "+tag", and for Gmail without
 * dots. Sign-up uses it so one inbox can't open endless accounts; the address itself is
 * still stored exactly as typed.
 */
export function canonicalEmail(email) {
  const [local = "", domain = ""] = String(email ?? "").trim().toLowerCase().split("@");
  const base = local.split("+")[0];
  if (GMAIL_DOMAINS.has(domain)) return `${base.replaceAll(".", "")}@gmail.com`;
  return `${base}@${domain}`;
}

/** The same rule as canonicalEmail, written in SQL over an email column, for finding an existing account. */
export const CANONICAL_EMAIL_SQL = (column) => `(case when split_part(lower(${column}), '@', 2) in ('gmail.com', 'googlemail.com')
  then replace(split_part(split_part(lower(${column}), '@', 1), '+', 1), '.', '') || '@gmail.com'
  else split_part(split_part(lower(${column}), '@', 1), '+', 1) || '@' || split_part(lower(${column}), '@', 2) end)`;
