function getAppUrl(env) {
  const configuredUrl =
    env.APP_URL ?? env.PUBLIC_APP_URL ?? env.NEXT_PUBLIC_APP_URL ?? null;

  if (configuredUrl) {
    return configuredUrl.replace(/\/$/, "");
  }

  const vercelHost = env.VERCEL_PROJECT_PRODUCTION_URL ?? env.VERCEL_URL ?? null;
  return vercelHost ? `https://${vercelHost}` : null;
}

export async function sendPasswordResetEmail({ email, env, token, tokenHash }) {
  const apiKey = env.RESEND_API_KEY ?? null;
  const from = env.PASSWORD_RESET_FROM_EMAIL ?? env.EMAIL_FROM ?? null;
  const appUrl = getAppUrl(env);

  if (!apiKey || !from || !appUrl) {
    return {
      delivered: false,
      reason: "Password reset email delivery is not configured.",
    };
  }

  const resetUrl = `${appUrl}/?reset_token=${encodeURIComponent(token)}`;
  const response = await fetch("https://api.resend.com/emails", {
    body: JSON.stringify({
      from,
      html: `<p>Use the link below to choose a new Margin Chat password.</p><p><a href="${resetUrl}">Reset your password</a></p><p>This link expires in one hour and can only be used once.</p>`,
      subject: "Reset your Margin Chat password",
      text: `Reset your Margin Chat password: ${resetUrl}\n\nThis link expires in one hour and can only be used once.`,
      to: [email],
    }),
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "Idempotency-Key": `password-reset-${tokenHash}`,
      "User-Agent": "margin-chat/1.0",
    },
    method: "POST",
  });

  if (!response.ok) {
    const responseText = await response.text().catch(() => "");
    throw new Error(
      `Password reset email failed (${response.status})${responseText ? `: ${responseText}` : "."}`,
    );
  }

  return { delivered: true };
}
