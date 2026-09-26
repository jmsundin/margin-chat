function firstValue(...values) {
  return values.find((value) => typeof value === "string" && value.trim())?.trim() ?? null;
}

export function getPasswordResetEmailConfiguration(env) {
  const apiKey = firstValue(env.RESEND_API_KEY);
  const from = firstValue(env.PASSWORD_RESET_FROM_EMAIL, env.EMAIL_FROM);
  const configuredUrl = firstValue(env.APP_URL, env.PUBLIC_APP_URL, env.NEXT_PUBLIC_APP_URL);
  const vercelHost = firstValue(env.VERCEL_PROJECT_PRODUCTION_URL, env.VERCEL_URL);
  const url = configuredUrl ?? (vercelHost ? `https://${vercelHost}` : null);
  const missing = [];
  if (!apiKey) missing.push("RESEND_API_KEY");
  if (!from) missing.push("PASSWORD_RESET_FROM_EMAIL (or EMAIL_FROM)");
  if (!url) missing.push("APP_URL (or a Vercel deployment URL)");
  if (missing.length) {
    return { configured: false, reason: `Password reset email delivery is not configured: ${missing.join(", ")}.` };
  }

  let appUrl;
  try {
    const parsed = new URL(url);
    const isHosted = env.NODE_ENV === "production" || Boolean(env.VERCEL || env.VERCEL_ENV || env.VERCEL_URL);
    if (!["https:", "http:"].includes(parsed.protocol) ||
        (isHosted && parsed.protocol !== "https:") ||
        parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== "/") {
      throw new Error("Invalid app origin");
    }
    appUrl = parsed.origin;
  } catch {
    return { configured: false, reason: "Password reset APP_URL must be a valid app origin, using HTTPS in production or hosted deployments." };
  }

  if (/[\r\n]/.test(from) || !/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(from.match(/<([^<>]+)>$/)?.[1] ?? from)) {
    return { configured: false, reason: "Password reset sender must be an email address, optionally formatted as Name <email@example.com>." };
  }

  return { configured: true, apiKey, from, appUrl };
}

function escapeHtml(value) {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);
}

export async function sendPasswordResetEmail({ email, env, token, tokenHash, ttlMs = 60 * 60 * 1000, timeoutMs = 10_000 }) {
  const config = getPasswordResetEmailConfiguration(env);
  if (!config.configured) return { delivered: false, reason: config.reason };

  const resetUrl = new URL("/", config.appUrl);
  resetUrl.searchParams.set("reset_token", token);
  const minutes = Math.max(1, Math.ceil(ttlMs / 60_000));
  const expiryText = `This link expires in ${minutes} ${minutes === 1 ? "minute" : "minutes"} and can only be used once.`;
  let response;
  try {
    response = await fetch("https://api.resend.com/emails", {
      body: JSON.stringify({
        from: config.from,
        html: `<p>Use the link below to choose a new Margin Chat password.</p><p><a href="${escapeHtml(resetUrl.toString())}">Reset your password</a></p><p>${expiryText}</p>`,
        subject: "Reset your Margin Chat password",
        text: `Reset your Margin Chat password: ${resetUrl}\n\n${expiryText}`,
        to: [email],
      }),
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
        "Idempotency-Key": `password-reset-${tokenHash}`,
        "User-Agent": "margin-chat/1.0",
      },
      method: "POST",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    // Do not forward transport errors that might include the request's secrets.
    throw new Error("Password reset email request failed or timed out.");
  }

  const result = await response.json().catch(() => null);
  if (!response.ok) {
    // Provider messages can echo recipient details or submitted reset links.
    const name = typeof result?.name === "string" && /^[a-z_]{1,64}$/.test(result.name) ? `, ${result.name}` : "";
    throw new Error(`Password reset email provider rejected the request (HTTP ${response.status}${name}). Check Resend credentials, verified sender domain, and provider email logs.`);
  }
  if (typeof result?.id !== "string" || !result.id) {
    throw new Error("Password reset email provider did not confirm accepting the email.");
  }

  // Acceptance is not confirmation of delivery to the recipient's inbox.
  return { delivered: true, messageId: result.id };
}
