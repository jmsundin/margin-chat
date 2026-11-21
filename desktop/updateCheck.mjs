// "Check for updates" in Settings. The page opens CHECK_UPDATES_PATH and the
// app looks for a newer client and a newer app right away, instead of waiting
// for the next background check (every 15 minutes and every 4 hours).
export const CHECK_UPDATES_PATH = "/__margin/check-updates";

/**
 * Runs both checks and describes what this app now has ready.
 * `checkClient` resolves once a newer client is downloaded (or there is none);
 * `currentClient` is the client the app serves now, which may be newer than
 * the one the page is running. `checkShell` resolves to null, a staged update
 * ({ version, manual: false }), or one this install must download by hand
 * ({ version, manual: true }).
 */
export async function checkForUpdatesNow({ appVersion, checkClient, currentClient, checkShell, downloadUrl }) {
  const errors = [];
  const [, shell] = await Promise.all([
    checkClient ? checkClient().catch((error) => { errors.push(messageOf(error, "The web client check failed.")); }) : null,
    checkShell().catch((error) => { errors.push(messageOf(error, "The app check failed.")); return null; }),
  ]);
  const client = checkClient ? await currentClient().catch(() => null) : null;
  return {
    appVersion,
    clientCommit: typeof client?.commit === "string" ? client.commit : null,
    app: shell ? { version: shell.version, manual: shell.manual === true } : null,
    downloadUrl: shell?.manual ? downloadUrl : null,
    errors,
  };
}

function messageOf(error, fallback) {
  return error instanceof Error && error.message ? error.message : fallback;
}
