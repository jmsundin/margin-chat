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

const failed = [];
for (const [index, group] of groups.entries()) {
  console.log(`\n# Test group ${index + 1} of ${groups.length} (${group.length} files${index ? ", database" : ""})`);
  const run = spawnSync(process.execPath, ["--no-env-file", "test", ...group.map((path) => `./${path}`)], { stdio: "inherit" });
  if (run.status !== 0) failed.push(index + 1);
}
if (failed.length) {
  console.error(`\nTest groups failed: ${failed.join(", ")}`);
  process.exit(1);
}
console.log(`\nAll ${files.length} test files passed in ${groups.length} groups.`);
