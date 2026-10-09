import { execFileSync } from "node:child_process";

const git = (cwd, args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });

export function resolveAppCommit(env, cwd, readGit = () => git(cwd, ["rev-parse", "HEAD"])) {
  for (const candidate of [env.MARGIN_RELEASE_SHA, env.VERCEL_GIT_COMMIT_SHA]) {
    if (candidate?.trim()) {
      if (!/^[a-f0-9]{40}$/i.test(candidate.trim())) throw new Error("App release version must be a full Git commit hash.");
      return candidate.trim().toLowerCase();
    }
  }
  try {
    const sha = readGit().trim();
    if (/^[a-f0-9]{40}$/i.test(sha)) return sha.toLowerCase();
  } catch { /* Source archives may have no Git metadata. */ }
  return "unknown";
}

// Commit hashes do not sort, so the commit time orders builds (the desktop app
// only offers an update when production is newer than its own build).
export function resolveAppCommitTime(env, cwd, commit, readGit = (args) => git(cwd, args)) {
  const time = (value) => {
    const parsed = Date.parse(value?.trim() ?? "");
    return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
  };
  if (env.MARGIN_RELEASE_COMMITTED_AT?.trim()) {
    const released = time(env.MARGIN_RELEASE_COMMITTED_AT);
    if (!released) throw new Error("App release commit time must be an ISO date.");
    return released;
  }
  if (commit === "unknown") return null;
  try { return time(readGit(["show", "-s", "--format=%cI", commit])); }
  catch { return null; }
}

export function appVersionFilePlugin(version) {
  return {
    name: "marginchat-app-version-file",
    apply: "build",
    generateBundle() {
      this.emitFile({ type: "asset", fileName: "version.json", source: `${JSON.stringify(version)}\n` });
    },
  };
}
