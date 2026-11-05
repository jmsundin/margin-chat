// Picks the version number for a Desktop release, so nobody types one by hand.
// It reads the desktop-v* tags of every earlier release (drafts included),
// bumps the highest one, and refuses a number that isn't higher than every
// earlier one: installed apps only update to a higher version
// (desktop/shellUpdater.mjs), so reusing or lowering a number would strand them.
//
//   node scripts/desktop-next-version.mjs <patch|minor|major> [override] < tags.txt
//   node scripts/desktop-next-version.mjs --highest < tags.txt
//
// Prints the version (for example 0.2.1). With no earlier release the first
// version is the one in desktop/package.json. --highest prints the highest
// earlier version, or nothing.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/u;

function parse(version) {
  const match = SEMVER.exec(String(version ?? "").trim());
  return match ? match.slice(1).map(Number) : null;
}

function compare(a, b) {
  for (let index = 0; index < 3; index += 1) if (a[index] !== b[index]) return a[index] - b[index];
  return 0;
}

/** The highest version among tags like desktop-v0.2.0; other tags are ignored. */
export function highestDesktopVersion(tags) {
  let highest = null;
  for (const tag of tags) {
    const parsed = parse(/^desktop-v(.+)$/u.exec(String(tag).trim())?.[1]);
    if (parsed && (!highest || compare(parsed, highest) > 0)) highest = parsed;
  }
  return highest ? highest.join(".") : null;
}

export function nextDesktopVersion({ tags, bump = "patch", override = "", firstVersion = "0.1.0" }) {
  const previous = highestDesktopVersion(tags);
  if (override) {
    const wanted = parse(override);
    if (!wanted) throw new Error(`Use a version like 0.2.0, not "${override}".`);
    if (previous && compare(wanted, parse(previous)) <= 0) {
      throw new Error(`Version ${override} must be higher than the last desktop release, ${previous}.`);
    }
    return { version: wanted.join("."), previous };
  }
  if (!previous) {
    const first = parse(firstVersion);
    if (!first) throw new Error(`desktop/package.json has no usable version ("${firstVersion}").`);
    return { version: first.join("."), previous: null };
  }
  const [major, minor, patch] = parse(previous);
  if (bump === "major") return { version: `${major + 1}.0.0`, previous };
  if (bump === "minor") return { version: `${major}.${minor + 1}.0`, previous };
  if (bump === "patch") return { version: `${major}.${minor}.${patch + 1}`, previous };
  throw new Error(`Bump must be patch, minor or major, not "${bump}".`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const [bump, override = ""] = process.argv.slice(2);
  const tags = readFileSync(0, "utf8").split(/\s+/u).filter(Boolean);
  if (bump === "--highest") {
    console.log(highestDesktopVersion(tags) ?? "");
    process.exit(0);
  }
  const firstVersion = JSON.parse(readFileSync(new URL("../desktop/package.json", import.meta.url), "utf8")).version;
  try {
    const { version, previous } = nextDesktopVersion({ tags, bump, override, firstVersion });
    console.error(previous ? `Last desktop release: ${previous}` : "No earlier desktop release.");
    console.log(version);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
