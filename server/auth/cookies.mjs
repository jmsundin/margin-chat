import { parseCookieHeader, serializeCookie } from "../http/cookies.mjs";

const AUTH_COOKIE_NAME = "margin_chat_session";

export function readAuthSessionId(request) {
  const cookies = parseCookieHeader(request.headers.cookie);
  const sessionId = cookies[AUTH_COOKIE_NAME];

  return typeof sessionId === "string" && sessionId.trim() ? sessionId : null;
}

export function createAuthSessionCookie(sessionId, runtimeConfig) {
  return serializeCookie(AUTH_COOKIE_NAME, sessionId, {
    httpOnly: true,
    maxAge: runtimeConfig.authSessionTtlSeconds,
    path: "/",
    sameSite: "Lax",
    secure: runtimeConfig.secureAuthCookies,
  });
}

export function createClearedAuthSessionCookie(runtimeConfig) {
  return serializeCookie(AUTH_COOKIE_NAME, "", {
    expires: new Date(0),
    httpOnly: true,
    maxAge: 0,
    path: "/",
    sameSite: "Lax",
    secure: runtimeConfig.secureAuthCookies,
  });
}
