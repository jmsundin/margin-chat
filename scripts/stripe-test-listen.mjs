/** Start a sandbox-only Stripe listener without displaying API/signing secrets. */
import { spawn } from "node:child_process";
import { lstat, chmod, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { loadStripeTestEnv, STRIPE_TEST_ORIGIN } from "./stripe-test-config.mjs";

const EVENTS = ["checkout.session.completed", "checkout.session.async_payment_succeeded", "invoice.paid", "invoice.payment_succeeded", "invoice.payment_failed", "customer.subscription.created", "customer.subscription.updated", "customer.subscription.deleted", "customer.subscription.paused", "customer.subscription.resumed"].join(",");

export function parseListenerArguments(args) {
  const filename = args[0];
  if (!filename || filename.startsWith("--")) throw new Error("Usage: bun --no-env-file scripts/stripe-test-listen.mjs .env.stripe-test.local [--config path] [--project-name name]");
  const options = { filename: resolve(filename), config: join(homedir(), ".config", "stripe", "margin-chat-test.toml"), projectName: "margin-chat-test" };
  for (let index = 1; index < args.length; index += 2) {
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new Error("Listener options require explicit values.");
    if (args[index] === "--config") options.config = resolve(value);
    else if (args[index] === "--project-name" && /^[a-zA-Z0-9_-]+$/u.test(value)) options.projectName = value;
    else throw new Error("Only --config and --project-name are supported; live mode and alternate forwarding are not allowed.");
  }
  return options;
}

export function redactStripeSecrets(value) {
  return value.replace(/\b(?:whsec_|(?:sk|rk|pk)_(?:test|live)_)[A-Za-z0-9_-]+/gu, "[redacted Stripe credential]");
}

export function replaceWebhookSecret(contents, secret) {
  if (!/^whsec_[A-Za-z0-9]+$/u.test(secret)) throw new Error("Stripe CLI did not return a valid webhook signing secret.");
  const newline = contents.includes("\r\n") ? "\r\n" : "\n";
  const assignment = `STRIPE_WEBHOOK_SECRET=${secret}`;
  const pattern = /^[ \t]*STRIPE_WEBHOOK_SECRET[ \t]*=[^\r\n]*/gmu;
  if (pattern.test(contents)) return contents.replace(pattern, assignment);
  return `${contents}${contents && !contents.endsWith("\n") ? newline : ""}${assignment}${newline}`;
}

export function buildListenerEnvironment(appEnv, systemEnv = process.env) {
  // Keep executable discovery and home/config locations, never ambient API keys.
  const allowed = ["PATH", "HOME", "USER", "LOGNAME", "TMPDIR", "TEMP", "TMP", "XDG_CONFIG_HOME", "BUN_INSTALL", "BUN_INSTALL_CACHE_DIR", "SystemRoot"];
  const env = Object.fromEntries(allowed.filter((key) => systemEnv[key] !== undefined).map((key) => [key, systemEnv[key]]));
  return { ...env, STRIPE_API_KEY: appEnv.STRIPE_SECRET_KEY, NO_COLOR: "1" };
}

export async function saveWebhookSecret(filename, secret) {
  const originalStat = await lstat(filename);
  if (!originalStat.isFile() || originalStat.isSymbolicLink()) throw new Error("The local environment must be a regular file, not a symbolic link.");
  const contents = await readFile(filename, "utf8");
  const updated = replaceWebhookSecret(contents, secret);
  const temporary = join(dirname(filename), `.stripe-listener-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, updated, { mode: 0o600, flag: "wx" });
    if (await readFile(filename, "utf8") !== contents) throw new Error("The local environment changed while saving the signing secret; retry the listener.");
    await rename(temporary, filename);
    await chmod(filename, 0o600);
  } finally { await rm(temporary, { force: true }); }
}

function stopChild(child) {
  if (!child?.pid || child.exitCode !== null) return;
  try {
    if (process.platform === "win32") child.kill("SIGTERM");
    else process.kill(-child.pid, "SIGTERM");
  } catch { /* The child can finish between the check and signal. */ }
}

function captureSecret(child) {
  return new Promise((accept, reject) => {
    let captured = "";
    const timer = setTimeout(() => { stopChild(child); reject(new Error("Stripe CLI timed out while requesting the signing secret.")); }, 30_000);
    const collect = (chunk) => {
      captured += chunk.toString("utf8");
      if (captured.length > 65_536) { stopChild(child); reject(new Error("Unexpected Stripe CLI response; signing secret was not saved.")); }
    };
    child.stdout.on("data", collect); child.stderr.on("data", collect);
    child.once("error", () => { clearTimeout(timer); reject(new Error("Unable to start Bun's Stripe CLI launcher.")); });
    child.once("close", (code) => {
      clearTimeout(timer);
      const secrets = [...new Set(captured.match(/\bwhsec_[A-Za-z0-9]+/gu) ?? [])];
      if (code !== 0 || secrets.length !== 1) reject(new Error("Unable to obtain a signing secret. Check the test API key and the selected Stripe CLI sandbox configuration."));
      else accept(secrets[0]);
    });
  });
}

async function main() {
  const options = parseListenerArguments(process.argv.slice(2));
  const env = loadStripeTestEnv(options.filename);
  if (!env.STRIPE_SECRET_KEY) throw new Error("Set a Stripe test STRIPE_SECRET_KEY in the explicitly selected local environment first.");
  const childEnv = buildListenerEnvironment(env);
  // Empty cwd prevents bunx from discovering any project/home .env file.
  const directory = await mkdtemp(join(tmpdir(), "margin-stripe-listen-"));
  const args = ["@stripe/cli@1.51.0", "listen", "--project-name", options.projectName, "--config", options.config, "--skip-update", "--events", EVENTS, "--forward-to", `${STRIPE_TEST_ORIGIN}/api/billing/webhook`];
  let child;
  let interrupted = false;
  const interrupt = () => { interrupted = true; stopChild(child); };
  process.on("SIGINT", interrupt); process.on("SIGTERM", interrupt);
  const launch = (extra = []) => spawn("bunx", [...args, ...extra], { cwd: directory, env: childEnv, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
  try {
    child = launch(["--print-secret"]);
    const secret = await captureSecret(child);
    if (interrupted) return;
    await saveWebhookSecret(options.filename, secret);
    console.log("Saved the sandbox signing secret to the selected local environment (permissions 0600).");
    console.log("Start or restart the app in another terminal: bun --no-env-file run stripe:test");
    console.log(`Forwarding Stripe sandbox events to ${STRIPE_TEST_ORIGIN}/api/billing/webhook`);
    child = launch();
    for (const stream of [child.stdout, child.stderr]) {
      // Buffer complete lines so a credential split across output chunks stays redacted.
      createInterface({ input: stream }).on("line", (line) => console.log(redactStripeSecrets(line)));
    }
    await new Promise((accept, reject) => {
      child.once("error", () => reject(new Error("Unable to start the Stripe sandbox listener.")));
      child.once("close", (code) => code === 0 || interrupted ? accept() : reject(new Error("The Stripe sandbox listener stopped unexpectedly. Restart it before testing payments.")));
    });
  } finally {
    stopChild(child);
    process.removeListener("SIGINT", interrupt); process.removeListener("SIGTERM", interrupt);
    await rm(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(redactStripeSecrets(error.message)); process.exitCode = 1; });
}
