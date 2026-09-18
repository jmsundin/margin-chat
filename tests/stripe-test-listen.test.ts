import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { buildListenerEnvironment, parseListenerArguments, redactStripeSecrets, replaceWebhookSecret, saveWebhookSecret } from "../scripts/stripe-test-listen.mjs";
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

test("listener permits only explicit local env and scoped config/project options", () => {
  expect(parseListenerArguments(["local.env", "--config", "sandbox.toml", "--project-name", "sandbox-test"])).toMatchObject({ projectName: "sandbox-test" });
  expect(() => parseListenerArguments([])).toThrow("Usage:");
  expect(() => parseListenerArguments(["local.env", "--live", "true"])).toThrow("Only");
  expect(() => parseListenerArguments(["local.env", "--forward-to", "https://remote.test"])).toThrow("Only");
});
test("child credentials come only from the validated test file", () => {
  const env = buildListenerEnvironment({ STRIPE_SECRET_KEY: "sk_test_explicit" }, { PATH: "/bin", HOME: "/temporary-home", STRIPE_API_KEY: "sk_live_ambient", OPENAI_API_KEY: "not-forwarded", DATABASE_URL: "not-forwarded" });
  expect(env).toEqual({ PATH: "/bin", HOME: "/temporary-home", STRIPE_API_KEY: "sk_test_explicit", NO_COLOR: "1" });
});
test("output redacts API and signing credentials", () => {
  expect(redactStripeSecrets("Ready! whsec_example and sk_test_example rk_live_example pk_test_example")).toBe("Ready! [redacted Stripe credential] and [redacted Stripe credential] [redacted Stripe credential] [redacted Stripe credential]");
});
test("secret replacement preserves unrelated values/comments/newlines and handles duplicates", () => {
  expect(replaceWebhookSecret("# Keep this\r\nOTHER=unchanged\r\nSTRIPE_WEBHOOK_SECRET=whsec_old\r\n", "whsec_new")).toBe("# Keep this\r\nOTHER=unchanged\r\nSTRIPE_WEBHOOK_SECRET=whsec_new\r\n");
  expect(replaceWebhookSecret("OTHER=unchanged", "whsec_new")).toBe("OTHER=unchanged\nSTRIPE_WEBHOOK_SECRET=whsec_new\n");
  expect(replaceWebhookSecret("STRIPE_WEBHOOK_SECRET=first\nSTRIPE_WEBHOOK_SECRET=second\n", "whsec_new")).toBe("STRIPE_WEBHOOK_SECRET=whsec_new\nSTRIPE_WEBHOOK_SECRET=whsec_new\n");
  expect(() => replaceWebhookSecret("unchanged", "sk_test_wrong")).toThrow();
});
test("atomic update changes only signing secret, restricts permissions and rejects symlinks", async () => {
  const directory = await mkdtemp(join(tmpdir(), "stripe-listener-test-")); directories.push(directory);
  const filename = join(directory, "local.env");
  await writeFile(filename, "OTHER=fixture\nSTRIPE_WEBHOOK_SECRET=whsec_old\n", { mode: 0o644 });
  await saveWebhookSecret(filename, "whsec_new");
  expect(await readFile(filename, "utf8")).toBe("OTHER=fixture\nSTRIPE_WEBHOOK_SECRET=whsec_new\n");
  expect((await stat(filename)).mode & 0o777).toBe(0o600);
  const link = join(directory, "linked.env"); await symlink(filename, link);
  await expect(saveWebhookSecret(link, "whsec_different")).rejects.toThrow("regular file");
});

test("full launcher captures then redacts a split CLI secret without contacting Stripe", async () => {
  const directory = await mkdtemp(join(tmpdir(), "stripe-listener-process-")); directories.push(directory);
  const executable = join(directory, "bunx");
  await writeFile(executable, `#!/bin/sh
case "$STRIPE_API_KEY" in sk_test_fixture) ;; *) exit 3 ;; esac
for argument in "$@"; do
  if [ "$argument" = "--print-secret" ]; then
    printf 'whsec_fixture\\n'
    exit 0
  fi
done
printf 'Ready! wh'
printf 'sec_fixture\\n'
`, { mode: 0o700 });
  const filename = join(directory, "local.env");
  await writeFile(filename, [
    "DATABASE_URL=postgresql://margin_chat_stripe_test:fixture@127.0.0.1:55432/margin_chat_stripe_test",
    "HOST=127.0.0.1", "PORT=4175", "APP_URL=http://127.0.0.1:4175", "SECURE_AUTH_COOKIES=false",
    `API_KEY_ENCRYPTION_KEY=${Buffer.alloc(32).toString("base64")}`, "STRIPE_SECRET_KEY=sk_test_fixture", "UNRELATED=preserved", "",
  ].join("\n"));
  const child = spawn("node", [resolve("scripts/stripe-test-listen.mjs"), filename], { env: { ...process.env, PATH: `${directory}:${process.env.PATH}` }, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; }); child.stderr.on("data", (chunk) => { output += chunk; });
  const code = await new Promise((accept, reject) => { child.on("error", reject); child.on("close", accept); });
  expect(code).toBe(0);
  expect(output).toContain("Ready! [redacted Stripe credential]");
  expect(output).not.toContain("whsec_fixture"); expect(output).not.toContain("sk_test_fixture");
  const saved = await readFile(filename, "utf8");
  expect(saved).toContain("STRIPE_WEBHOOK_SECRET=whsec_fixture\n"); expect(saved).toContain("UNRELATED=preserved\n");
});
