# Password reset email

Password reset uses Resend. Configure these server-only environment variables in the deployment environment:

| Variable | Required value |
| --- | --- |
| `RESEND_API_KEY` | A Resend API key with permission to send from the selected domain. |
| `PASSWORD_RESET_FROM_EMAIL` | A sender on a verified Resend domain, optionally `Margin Chat <passwords@your-domain.com>`. `EMAIL_FROM` is an alias. |
| `APP_URL` | The app origin, such as `https://www.marginchat.com`, without a path, query, or fragment. HTTPS is required in production and hosted deployments. Vercel's production/deployment URL is a fallback. |
| `PASSWORD_RESET_MINUTES` | Optional reset-link lifetime in minutes; defaults to 60. |

Verify the sender domain's DNS records in [Resend](https://resend.com/docs/dashboard/domains/introduction). A placeholder sender in `.env.example` does not configure delivery. Keep the API key server-only; do not use a `VITE_` prefix. After changing Vercel variables, [redeploy to apply them](https://vercel.com/docs/environment-variables/managing-environment-variables), following this project's [production release workflow](production-releases.md).

The service checks configuration before looking up the account. Missing or malformed hosted configuration returns the same “Password reset is temporarily unavailable” response for every address. Configured requests return a generic response to avoid disclosing whether an account exists. Delivery rejection or a network failure is logged on the server without the reset link, recipient address, or raw provider response. Requests to the provider time out after ten seconds.

For a missing email, first check that the deployed environment has the key, verified sender, and correct app origin. Then inspect server logs for configuration or provider errors and Resend's email dashboard for the requested message. Provider acceptance is not proof that the recipient's inbox received the email; check its delivery status and spam folder. The [Resend send API](https://resend.com/docs/api-reference/emails/send-email) returns an email ID when it accepts a request.

Configured local development sends real email too. Unconfigured local development returns a development token instead; the login screen opens the reset form. Production and Vercel preview deployments never expose reset tokens in API responses.

A successful password reset invalidates previous browser sessions, extension sessions, capture tokens, and outstanding reset links. Users sign in again with the new password. Profile settings also allow signed-in users to change their password by providing their current password; this rotates the current browser session and invalidates the other credentials.

## Password request security

Password authentication sends the current and new passwords in a JSON request body over HTTPS. TLS encrypts the entire request in transit. Browser DevTools can display the body before encryption; this does not mean it travels unencrypted over an HTTPS connection. Use loopback HTTP only for local development, with HTTPS on any remote proxy connection. Passwords must not be included in URLs, logs, analytics, or error messages. The server stores a salted scrypt hash, never the original password.

This follows [OWASP's guidance to transmit passwords only over TLS](https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html#transmit-passwords-only-over-tls-or-other-strong-transport). Sending a simple client-generated hash as the accepted credential would make that hash reusable and would still require TLS. To avoid sending passwords altogether, [passkeys/WebAuthn](https://developer.mozilla.org/en-US/docs/Web/API/Web_Authentication_API) use public-key challenge-response authentication; that requires a separate authentication flow, rather than changing the encoding of a password field.
