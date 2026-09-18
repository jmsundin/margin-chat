import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadEnvFile } from "../server/config/env.mjs";

export const STRIPE_TEST_ORIGIN = "http://127.0.0.1:4175";

export function validateStripeTestEnv(env) {
  if (env.STRIPE_SECRET_KEY && !/^(?:sk|rk)_test_/u.test(env.STRIPE_SECRET_KEY)) {
    throw new Error("The isolated Stripe test server accepts only Stripe test secret keys.");
  }
  for (const name of ["STRIPE_PUBLISHABLE_KEY", "VITE_STRIPE_PUBLISHABLE_KEY"]) {
    if (env[name] && !env[name].startsWith("pk_test_")) throw new Error("The isolated Stripe test server accepts only Stripe test publishable keys.");
  }
  let database;
  try { database = new URL(env.DATABASE_URL); }
  catch { throw new Error("The test environment requires an explicit local DATABASE_URL."); }
  if (!["postgres:", "postgresql:"].includes(database.protocol)
    || !["127.0.0.1", "[::1]"].includes(database.hostname)
    || database.port !== "55432" || database.pathname !== "/margin_chat_stripe_test"
    || database.username !== "margin_chat_stripe_test" || !database.password
    || database.search || database.hash) {
    throw new Error("Use only the dedicated margin_chat_stripe_test database on loopback port 55432, with explicit credentials and no URL parameters.");
  }
  if (env.APP_URL !== STRIPE_TEST_ORIGIN || env.HOST !== "127.0.0.1" || env.PORT !== "4175"
    || env.SECURE_AUTH_COOKIES !== "false" || env.NODE_ENV === "production" || env.VERCEL
    || (env.DB_SCHEMA_MODE && env.DB_SCHEMA_MODE !== "migrate")) {
    throw new Error("The test server requires APP_URL=http://127.0.0.1:4175, HOST=127.0.0.1, PORT=4175, SECURE_AUTH_COOKIES=false, and local migration mode.");
  }
  if (!env.API_KEY_ENCRYPTION_KEY || Buffer.from(env.API_KEY_ENCRYPTION_KEY, "base64").length !== 32) {
    throw new Error("The test environment requires a generated 32-byte base64 API_KEY_ENCRYPTION_KEY.");
  }
  return { ...env, NODE_ENV: "development", DB_SCHEMA_MODE: "migrate" };
}

export function loadStripeTestEnv(filename) {
  if (!filename) throw new Error("Usage: node scripts/stripe-test.mjs .env.stripe-test.local");
  const path = resolve(filename);
  if (!existsSync(path)) throw new Error("The explicitly selected Stripe test environment file does not exist.");
  const env = Object.create(null);
  // Never inherit process.env or load .env/client/.env: they can contain live credentials.
  loadEnvFile(path, env);
  return validateStripeTestEnv(env);
}
