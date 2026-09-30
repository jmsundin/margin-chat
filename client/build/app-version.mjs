import { execFileSync } from "node:child_process";

export function resolveAppCommit(env, cwd, readGit = () => execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })) {
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
