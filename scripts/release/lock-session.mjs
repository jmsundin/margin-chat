export const LOCK_HEARTBEAT_MS = 30_000;

/**
 * The release lock is a Postgres session advisory lock, so the session must
 * survive the whole release. The Blob backup alone can leave it idle for half
 * an hour, long enough for Neon's scale-to-zero (5 minutes on the Free plan) or
 * an idle network path to end the session and silently drop the lock. A
 * periodic query keeps the session active; a lost connection still surfaces
 * through the client's error event, which assertLock reports.
 */
export function keepLockSessionActive(client, { intervalMs = LOCK_HEARTBEAT_MS, schedule = setInterval, cancel = clearInterval } = {}) {
  let pending = false;
  const timer = schedule(() => {
    // A long migration statement already keeps the session busy; don't queue behind it.
    if (pending) return;
    pending = true;
    client.query("select 1").catch(() => {}).finally(() => { pending = false; });
  }, intervalMs);
  timer?.unref?.();
  return () => cancel(timer);
}
