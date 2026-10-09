// Desktop builds bundle their own client, so the web app's service worker
// updates never reach them. Instead the app compares its bundled version.json
// with production's and tells the person when production is newer.
export const UPDATE_CHECK_INTERVAL = 60 * 60 * 1000;

function parseVersion(value) {
  if (!value || typeof value.commit !== "string" || !/^[a-f0-9]{40}$/.test(value.commit)) return null;
  const time = Date.parse(value.committedAt ?? "");
  return Number.isNaN(time) ? null : { commit: value.commit, time };
}

// Only a strictly newer release counts, so a build from main that is ahead of
// production (or a version file without a commit time) never prompts.
export function newerRelease(local, remote) {
  const own = parseVersion(local);
  const latest = parseVersion(remote);
  if (!own || !latest || own.commit === latest.commit || latest.time <= own.time) return null;
  return latest;
}

export function watchForUpdates({ readLocal, fetchRemote, notify, interval = UPDATE_CHECK_INTERVAL, setTimer = setInterval, clearTimer = clearInterval }) {
  const offered = new Set();
  let running = null;
  const run = async () => {
    try {
      const latest = newerRelease(await readLocal(), await fetchRemote());
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
