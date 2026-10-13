import { createHash, randomBytes } from "node:crypto";
import { HttpError } from "../lib/errors.mjs";
import { canUseMcp } from "./index.mjs";

/**
 * OAuth 2.1 for MCP connectors, as the MCP authorization spec asks: protected
 * resource metadata (RFC 9728), authorization server metadata (RFC 8414), dynamic
 * client registration (RFC 7591) and the authorization code flow with PKCE (S256
 * only) for public clients. The consent page is the app's /oauth/authorize route.
 */

export const OAUTH_SCOPES = Object.freeze({ read: "vault:read", write: "vault:write" });
const CODE_TTL_MS = 10 * 60_000;
const ACCESS_TTL_MS = 60 * 60_000;
// A connector that keeps using its refresh token stays connected; one left idle this long must sign in again.
const REFRESH_TTL_MS = 90 * 86400_000;
const MAX_REDIRECT_URIS = 10;
const CLIENT_NAME_LIMIT = 100;

const hash = (value) => createHash("sha256").update(value).digest("hex");
const secret = (prefix) => `${prefix}${randomBytes(32).toString("base64url")}`;

/** An OAuth error response body, with the HTTP status it goes out with. */
export class OAuthError extends HttpError {
  constructor(error, description, statusCode = 400) {
    super(statusCode, description);
    this.oauth = { error, error_description: description };
  }
}

/** The site's public origin: the configured app URL, else the request's own host. */
export function publicOrigin(request, env = process.env) {
  const configured = env.APP_URL ?? env.PUBLIC_APP_URL ?? env.NEXT_PUBLIC_APP_URL;
  if (configured?.trim()) return configured.trim().replace(/\/+$/u, "");
  const first = (value) => (Array.isArray(value) ? value[0] : value)?.split(",")[0].trim();
  const host = first(request.headers["x-forwarded-host"]) ?? first(request.headers.host);
  if (!host) throw new HttpError(500, "Unable to resolve the site's address.");
  return `${first(request.headers["x-forwarded-proto"]) || "http"}://${host}`;
}

export function protectedResourceMetadata(origin) {
  return {
    resource: `${origin}/api/mcp`,
    authorization_servers: [origin],
    scopes_supported: Object.values(OAUTH_SCOPES),
    bearer_methods_supported: ["header"],
    resource_name: "Margin Chat",
    resource_documentation: `${origin}/download`,
  };
}

export function authorizationServerMetadata(origin) {
  return {
    issuer: origin,
    authorization_endpoint: `${origin}/oauth/authorize`,
    token_endpoint: `${origin}/api/oauth/token`,
    registration_endpoint: `${origin}/api/oauth/register`,
    revocation_endpoint: `${origin}/api/oauth/revoke`,
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    revocation_endpoint_auth_methods_supported: ["none"],
    scopes_supported: Object.values(OAUTH_SCOPES),
  };
}

/** Where a client may send a member back to: HTTPS anywhere, plain HTTP only to this computer (for desktop agents). */
export function isAllowedRedirectUri(value) {
  let url;
  try { url = new URL(value); } catch { return false; }
  if (url.hash || url.username || url.password) return false;
  if (url.protocol === "https:") return true;
  return url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
}

/** Space-separated scopes to the token's access; read unless vault:write is asked for. */
function requestedScope(scope) {
  const scopes = String(scope ?? "").split(/\s+/u).filter(Boolean);
  return scopes.includes(OAUTH_SCOPES.write) ? "write" : "read";
}

const scopeString = (scope) => (scope === "write" ? `${OAUTH_SCOPES.read} ${OAUTH_SCOPES.write}` : OAUTH_SCOPES.read);

export function createOAuthService({ database }) {
  /**
   * Checks an authorization request. Problems with the client or its redirect URI
   * can't be sent back to the client, so they are thrown for the consent page to show.
   */
  async function checkRequest(params, origin) {
    const client = typeof params.client_id === "string" ? await database.getOAuthClient(params.client_id) : null;
    if (!client) throw new OAuthError("invalid_client", "This app isn't registered with Margin Chat. Try connecting from the app again.");
    if (!client.redirectUris.includes(params.redirect_uri)) {
      throw new OAuthError("invalid_request", "This app asked to return somewhere it didn't register.");
    }
    const resource = params.resource;
    if (resource && resource !== `${origin}/api/mcp` && resource !== origin && resource !== `${origin}/`) {
      throw new OAuthError("invalid_target", "This app asked for access to something other than Margin Chat.");
    }
    if (params.response_type !== "code") throw new OAuthError("unsupported_response_type", "Only the authorization code flow is supported.");
    if (params.code_challenge_method !== "S256" || !/^[A-Za-z0-9_-]{43,128}$/u.test(String(params.code_challenge ?? ""))) {
      throw new OAuthError("invalid_request", "This app must use PKCE with S256.");
    }
    return { client, scope: requestedScope(params.scope) };
  }

  function redirect(uri, values) {
    const url = new URL(uri);
    for (const [key, value] of Object.entries(values)) if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, value);
    return url.toString();
  }

  async function issue({ userId, clientId, name, scope }) {
    const access = secret("mc_mcp_");
    const refresh = secret("mc_mcpr_");
    await database.createOAuthConnection({
      userId, clientId, name, scope, tokenHash: hash(access), refreshTokenHash: hash(refresh),
      accessExpiresAt: new Date(Date.now() + ACCESS_TTL_MS), expiresAt: new Date(Date.now() + REFRESH_TTL_MS),
    });
    return { access_token: access, token_type: "Bearer", expires_in: ACCESS_TTL_MS / 1000, refresh_token: refresh, scope: scopeString(scope) };
  }

  return {
    async register(body) {
      if (!body || typeof body !== "object" || Array.isArray(body)) throw new OAuthError("invalid_client_metadata", "Send client metadata as a JSON object.");
      const redirectUris = body.redirect_uris;
      if (!Array.isArray(redirectUris) || !redirectUris.length || redirectUris.length > MAX_REDIRECT_URIS
        || !redirectUris.every((uri) => typeof uri === "string" && uri.length <= 2000 && isAllowedRedirectUri(uri))) {
        throw new OAuthError("invalid_redirect_uri", "Register 1 to 10 redirect URIs, each HTTPS or http://localhost.");
      }
      const method = body.token_endpoint_auth_method ?? "none";
      if (method !== "none") throw new OAuthError("invalid_client_metadata", "Margin Chat clients are public: use token_endpoint_auth_method none with PKCE.");
      const clientName = typeof body.client_name === "string" && body.client_name.trim()
        ? body.client_name.trim().replace(/\s+/gu, " ").slice(0, CLIENT_NAME_LIMIT) : "MCP client";
      const clientId = secret("mcpc_");
      await database.createOAuthClient({ clientId, clientName, redirectUris });
      return {
        client_id: clientId, client_id_issued_at: Math.floor(Date.now() / 1000), client_name: clientName, redirect_uris: redirectUris,
        grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none",
      };
    },

    /** What the consent page shows about a request. */
    async describe(params, origin) {
      const { client, scope } = await checkRequest(params, origin);
      return { clientName: client.clientName, redirectHost: new URL(params.redirect_uri).host, scope };
    },

    /** The member's answer on the consent page; returns where to send the browser. */
    async decide(user, params, origin, { allow, write }) {
      const { client, scope } = await checkRequest(params, origin);
      const state = typeof params.state === "string" ? params.state : undefined;
      if (!allow) return { redirectTo: redirect(params.redirect_uri, { error: "access_denied", state, iss: origin }) };
      if (!canUseMcp(user)) throw new HttpError(403, "Connecting agents to your vault comes with the Plus and Cloud plans.");
      const code = secret("mc_code_");
      await database.createOAuthCode({
        codeHash: hash(code), clientId: client.clientId, userId: user.id, redirectUri: params.redirect_uri,
        codeChallenge: params.code_challenge, scope: scope === "write" && write ? "write" : "read",
        expiresAt: new Date(Date.now() + CODE_TTL_MS),
      });
      return { redirectTo: redirect(params.redirect_uri, { code, state, iss: origin }) };
    },

    async token(form) {
      const clientId = form.get("client_id");
      const client = clientId ? await database.getOAuthClient(clientId) : null;
      if (!client) throw new OAuthError("invalid_client", "Unknown client_id.", 401);
      const grant = form.get("grant_type");
      if (grant === "authorization_code") {
        const found = await database.consumeOAuthCode(hash(String(form.get("code") ?? "")));
        const verifier = String(form.get("code_verifier") ?? "");
        if (!found || found.clientId !== client.clientId || found.redirectUri !== form.get("redirect_uri")
          || !/^[A-Za-z0-9._~-]{43,128}$/u.test(verifier)
          || createHash("sha256").update(verifier).digest("base64url") !== found.codeChallenge) {
          throw new OAuthError("invalid_grant", "The code is invalid, expired or already used.");
        }
        try {
          return await issue({ userId: found.userId, clientId: client.clientId, name: client.clientName, scope: found.scope });
        } catch (error) {
          if (error?.statusCode === 409) throw new OAuthError("invalid_grant", error.message);
          throw error;
        }
      }
      if (grant === "refresh_token") {
        const access = secret("mc_mcp_");
        const refresh = secret("mc_mcpr_");
        const renewed = await database.refreshOAuthConnection({
          clientId: client.clientId, refreshTokenHash: hash(String(form.get("refresh_token") ?? "")),
          tokenHash: hash(access), nextRefreshTokenHash: hash(refresh),
          accessExpiresAt: new Date(Date.now() + ACCESS_TTL_MS), expiresAt: new Date(Date.now() + REFRESH_TTL_MS),
        });
        if (!renewed) throw new OAuthError("invalid_grant", "The refresh token is invalid, expired or was revoked.");
        return { access_token: access, token_type: "Bearer", expires_in: ACCESS_TTL_MS / 1000, refresh_token: refresh, scope: scopeString(renewed.scope) };
      }
      throw new OAuthError("unsupported_grant_type", "Use authorization_code or refresh_token.");
    },

    async revoke(form) {
      const token = form.get("token");
      if (token) await database.revokeMcpCredential(hash(String(token)));
    },
  };
}
