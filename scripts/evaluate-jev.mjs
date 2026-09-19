/** Dry by default. --live explicitly enables billable synthetic TypeSafe calls. */
import { loadProjectEnv } from "../server/config/env.mjs";
import { assertPinnedSuiteFingerprint, buildScenarios, EVALUATION_VERSION, PINNED_MODEL, PINNED_SUITE_FINGERPRINT } from "./jev-evaluation/fixtures.mjs";
import { describePlan, runEvaluation } from "./jev-evaluation/runner.mjs";

export function parseOptions(args) {
  const options = { live: false, repeats: 5, concurrency: 3, timeoutMs: 10_000, pricePerMillion: 0.042, help: false };
  const values = { "--repeats": ["repeats", 1, 50], "--concurrency": ["concurrency", 1, 8],
    "--timeout-ms": ["timeoutMs", 100, 60_000], "--price-per-million": ["pricePerMillion", 0, 100] };
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === "--live") options.live = true;
    else if (argument === "--dry-run") options.live = false;
    else if (argument === "--help") options.help = true;
    else if (values[argument]) {
      const [key, min, max] = values[argument];
      const raw = args[++index]; const value = Number(raw);
      if (raw === undefined || !Number.isFinite(value) || value < min || value > max
        || key !== "pricePerMillion" && !Number.isInteger(value)) throw new Error(`Invalid value for ${argument}.`);
      options[key] = value;
    } else throw new Error(`Unknown option: ${argument}`);
  }
  if (args.includes("--live") && args.includes("--dry-run")) throw new Error("Choose either --live or --dry-run.");
  return options;
}

export async function main(args = process.argv.slice(2), dependencies = {}) {
  const options = parseOptions(args);
  const write = dependencies.write ?? ((value) => console.log(value));
  if (options.help) {
    write("Usage: bun --no-env-file scripts/evaluate-jev.mjs [--dry-run | --live] [--repeats 5] [--concurrency 3] [--timeout-ms 10000] [--price-per-million 0.042]\nDefault: no network, no key required. --live sends only built-in synthetic scenarios and incurs TypeSafe charges.");
    return { status: "help" };
  }
  const scenarios = await buildScenarios();
  const plan = { ...describePlan(scenarios, options), pinnedSuiteFingerprint: PINNED_SUITE_FINGERPRINT };
  plan.matchesPinnedSuite = plan.suiteFingerprint === plan.pinnedSuiteFingerprint;
  if (!options.live) {
    const report = { evaluationVersion: EVALUATION_VERSION, model: PINNED_MODEL, status: "not_run", ...plan,
      message: "Dry run: no vendor requests, measured latency, answers, token usage, or quality results. Add --live to perform billable measurements." };
    write(JSON.stringify(report, null, 2));
    return report;
  }
  assertPinnedSuiteFingerprint(plan.suiteFingerprint);
  const env = { ...(dependencies.env ?? process.env) };
  if (!dependencies.env) loadProjectEnv(process.cwd(), env);
  const apiKey = [env.TYPESAFE_AI_JEV_API_KEY, env.TYPESAFE_API_KEY].find((value) => typeof value === "string" && value.trim())?.trim();
  if (!apiKey) throw new Error("--live requires TYPESAFE_AI_JEV_API_KEY or TYPESAFE_API_KEY. No requests were sent.");
  const report = await runEvaluation(scenarios, { ...options, apiKey, fetchImpl: dependencies.fetchImpl });
  write(JSON.stringify(report, null, 2));
  return report;
}

if (import.meta.main) {
  try {
    const report = await main();
    if (report.status === "completed_with_issues") process.exitCode = 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Evaluation failed.");
    process.exitCode = 1;
  }
}
