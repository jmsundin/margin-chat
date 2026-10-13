// Update checks for the desktop app. The client updates itself
// (clientBundles.mjs); these helpers decide when a newer release exists.
export const UPDATE_CHECK_INTERVAL = 60 * 60 * 1000;

function parseVersion(value) {
  if (!value || typeof value.commit !== "string" || !/^[a-f0-9]{40}$/.test(value.commit)) return null;
  const time = Date.parse(value.committedAt ?? "");
  if (Number.isNaN(time)) return null;
  // Published desktop builds also carry a version number like 0.2.0.
  return { commit: value.commit, time, version: typeof value.version === "string" ? value.version : null };
}

// Only a strictly newer release counts, so a build from main that is ahead of
// production (or a version file without a commit time) never prompts.
export function newerRelease(local, remote) {
  const own = parseVersion(local);
  const latest = parseVersion(remote);
  if (!own || !latest || own.commit === latest.commit || latest.time <= own.time) return null;
  return latest;
}

const semver = (value) => (typeof value === "string" && /^\d+\.\d+\.\d+$/u.test(value) ? value.split(".").map(Number) : null);

/** A published installer whose version number is higher than this app's. */
export function newerShell(local, remote) {
  const own = semver(local?.version);
  const latest = semver(remote?.version);
  if (!own || !latest) return null;
  for (let index = 0; index < 3; index += 1) {
    if (latest[index] !== own[index]) return latest[index] > own[index] ? { ...remote, commit: remote.commit ?? remote.version } : null;
  }
  return null;
}

export function watchForUpdates({ readLocal, fetchRemote, notify, compare = newerRelease, interval = UPDATE_CHECK_INTERVAL, setTimer = setInterval, clearTimer = clearInterval }) {
  const offered = new Set();
  let running = null;
  const run = async () => {
    try {
      const latest = compare(await readLocal(), await fetchRemote());
      // "Later" means later: each release is offered once per launch.
      if (latest && !offered.has(latest.commit)) {
        offered.add(latest.commit);
        await notify(latest);
      }
    } catch { /* Offline or an older production without version.json; try next time. */ }
  };
  const check = () => (running ??= run().finally(() => { running = null; }));
  void check();
  const timer = setTimer(check, interval);
  return { check, stop: () => clearTimer(timer) };
}
