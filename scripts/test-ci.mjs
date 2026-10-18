// Runs the whole test suite the way CI does, in several processes instead of one.
// Each in-process PGlite database holds onto a large WebAssembly heap for the life of
// the process, so with every database-backed file in a single `bun test` the runner
// can run out of memory and fail unrelated suites. Database files run a few at a time,
// each group in its own process; everything else runs together as before.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const GROUP_SIZE = 6;
const files = spawnSync("git", ["ls-files"], { encoding: "utf8" }).stdout.split("\n")
  .filter((path) => /(\.|_)(test|spec)\.(ts|tsx|js|jsx|mjs|cjs|mts|cts)$/.test(path));
const usesDatabase = (path) => /pglite|captureDatabase/i.test(readFileSync(path, "utf8"));
const database = files.filter(usesDatabase);
const groups = [files.filter((path) => !usesDatabase(path))];
for (let index = 0; index < database.length; index += GROUP_SIZE) groups.push(database.slice(index, index + GROUP_SIZE));

// Bun itself, or PGlite's WebAssembly Postgres, occasionally crashes mid-run ("Bun has crashed", a
// segmentation fault, "PANIC: ERRORDATA_STACK_SIZE exceeded", or a WebAssembly "access to a null reference") in a database group that passes on its
// own. Such a group runs once more; a test that fails without a crash fails the run as usual.
const CRASH = /Bun has crashed|Segmentation fault|severity: "PANIC"|PANIC:|RuntimeError: access to a null reference/;
function runGroup(group, database) {
  const args = ["--no-env-file", "test", ...group.map((path) => `./${path}`)];
  // The large group streams as it runs; a database group's output is kept to look for a crash.
  if (!database) return { passed: spawnSync(process.execPath, args, { stdio: "inherit" }).status === 0, crashed: false };
  const run = spawnSync(process.execPath, args, { stdio: ["inherit", "pipe", "pipe"], encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  process.stdout.write(run.stdout ?? "");
  process.stderr.write(run.stderr ?? "");
  return { passed: run.status === 0, crashed: run.signal !== null || CRASH.test(`${run.stdout}\n${run.stderr}`) };
}

const failed = [];
for (const [index, group] of groups.entries()) {
  console.log(`\n# Test group ${index + 1} of ${groups.length} (${group.length} files${index ? ", database" : ""})`);
  let run = runGroup(group, index > 0);
  if (!run.passed && run.crashed) {
    console.log(`\n# Test group ${index + 1} crashed; running it once more`);
    run = runGroup(group, true);
  }
  if (!run.passed) failed.push(index + 1);
}
if (failed.length) {
  console.error(`\nTest groups failed: ${failed.join(", ")}`);
  process.exit(1);
}
console.log(`\nAll ${files.length} test files passed in ${groups.length} groups.`);
