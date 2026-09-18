import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadStripeTestEnv, validateStripeTestEnv } from "../scripts/stripe-test-config.mjs";

const env = () => ({ DATABASE_URL: "postgresql://margin_chat_stripe_test:fixture-password@127.0.0.1:55432/margin_chat_stripe_test", HOST: "127.0.0.1", PORT: "4175", APP_URL: "http://127.0.0.1:4175", SECURE_AUTH_COOKIES: "false", API_KEY_ENCRYPTION_KEY: Buffer.alloc(32).toString("base64") });
const directories: string[] = [];
afterEach(() => directories.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })));

test("accepts isolated DB configuration before Stripe keys exist", () => {
  expect(validateStripeTestEnv(env()).DB_SCHEMA_MODE).toBe("migrate");
  expect(validateStripeTestEnv({ ...env(), STRIPE_SECRET_KEY: "rk_test_fixture" }).NODE_ENV).toBe("development");
});
test.each([
  { STRIPE_SECRET_KEY: "sk_live_fixture" }, { STRIPE_PUBLISHABLE_KEY: "pk_live_fixture" },
  { DATABASE_URL: "postgresql://margin_chat_stripe_test:pass@remote.test:55432/margin_chat_stripe_test" },
  { DATABASE_URL: "postgresql://margin_chat_stripe_test:pass@127.0.0.1:55432/real_database" },
  { DATABASE_URL: `${env().DATABASE_URL}?host=remote.test` },
  { PORT: "8787" }, { SECURE_AUTH_COOKIES: "true" }, { NODE_ENV: "production" },
])("rejects live or nonisolated settings", (override) => {
  expect(() => validateStripeTestEnv({ ...env(), ...override })).toThrow();
});
test("loads only the explicitly selected file, ignoring ambient credentials", () => {
  const directory = mkdtempSync(join(tmpdir(), "stripe-config-")); directories.push(directory);
  const filename = join(directory, "isolated.env");
  writeFileSync(filename, Object.entries(env()).map(([key, value]) => `${key}=${value}`).join("\n"));
  const previous = process.env.STRIPE_SECRET_KEY;
  try {
    process.env.STRIPE_SECRET_KEY = "sk_live_ambient_fixture";
    expect(loadStripeTestEnv(filename).STRIPE_SECRET_KEY).toBeUndefined();
  } finally {
    if (previous === undefined) delete process.env.STRIPE_SECRET_KEY;
    else process.env.STRIPE_SECRET_KEY = previous;
  }
  expect(() => loadStripeTestEnv()).toThrow("Usage:");
});
