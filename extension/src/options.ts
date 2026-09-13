import { CONNECTION_API_PATH, normalizeServerUrl, type CaptureConnection } from "@margin-chat/capture-contracts";
import { connectionIdentity, getPending, getSettings, trustedStorage } from "./storage";
import { captureRequest, errorText, signIn, signOut } from "./network";
import { serverPermissionPattern } from "./permissions";

const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const serverInput = el<HTMLInputElement>("server-url");
const emailInput = el<HTMLInputElement>("email");
const passwordInput = el<HTMLInputElement>("password");
const status = el("status");
let busy = false;

function setBusy(value: boolean) {
  busy = value;
  for (const id of ["connect", "disconnect"])
    el<HTMLButtonElement>(id).disabled = value;
}

async function initialize() {
  await trustedStorage();
  const settings = await getSettings();
  el("connected").hidden = !settings;
  if (settings) {
    serverInput.value = settings.serverUrl;
    emailInput.value = settings.email ?? "";
    const expired = settings.expiresAt && Date.parse(settings.expiresAt) <= Date.now();
    el("account").textContent = expired
      ? `Your session for ${settings.email ?? settings.displayName} has expired. Sign in again below to continue.`
      : `Signed in as ${settings.email ?? settings.displayName} at ${settings.serverUrl}`;
  }
}

el("connection-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (busy) return;
  setBusy(true);
  status.className = "";
  try {
    const serverUrl = normalizeServerUrl(serverInput.value);
    const email = emailInput.value.trim();
    const password = passwordInput.value;
    if (!email || !password) throw new Error("Enter your Margin Chat email and password.");
    // Keep this permission request in the submit gesture; credentials go only to this origin.
    const allowed = await chrome.permissions.request({ origins: [serverPermissionPattern(serverUrl)] });
    if (!allowed) throw new Error("Allow access to your Margin Chat website to sign in.");
    status.textContent = "Signing in…";
    const session = await signIn(serverUrl, email, password);
    const previous = await getSettings();
    const connectionId = connectionIdentity(serverUrl, session.user.id);

    // Preserve a v0.1 draft only when the server proves its old connection owns the same account.
    if (previous?.serverUrl === serverUrl && !previous.userId) {
      const oldAccount = await captureRequest<CaptureConnection>(previous, CONNECTION_API_PATH).catch(() => null);
      const pending = await getPending();
      if (oldAccount?.userId === session.user.id && pending?.connectionId === previous.connectionId) {
        await chrome.storage.local.set({ pendingSave: { ...pending, connectionId } });
      }
    }

    await trustedStorage();
    await chrome.storage.local.set({
      connection: {
        serverUrl,
        token: session.token,
        connectionId,
        userId: session.user.id,
        displayName: session.user.displayName,
        email: session.user.email,
        expiresAt: session.expiresAt,
      },
    });
    if (previous?.token.startsWith("mc_extension_")) await signOut(previous).catch(() => undefined);
    if (previous && serverPermissionPattern(previous.serverUrl) !== serverPermissionPattern(serverUrl)) {
      await chrome.permissions.remove({ origins: [serverPermissionPattern(previous.serverUrl)] });
    }
    await initialize();
    status.textContent = "Signed in. Open a web page and click Save to Margin to capture it.";
  } catch (error) {
    status.className = "error";
    status.textContent = errorText(error, "Could not reach Margin Chat. Check your website address and internet connection, then try again.");
  } finally {
    passwordInput.value = "";
    setBusy(false);
  }
});

el("disconnect").addEventListener("click", async () => {
  if (busy) return;
  setBusy(true);
  status.className = "";
  try {
    const previous = await getSettings();
    // Always forget the credential locally, even when the server is unreachable.
    await chrome.storage.local.remove("connection");
    passwordInput.value = "";
    await initialize();
    let revoked = true;
    if (previous?.token.startsWith("mc_extension_")) {
      status.textContent = "Signing out…";
      revoked = await signOut(previous).then(() => true, () => false);
    }
    if (previous) await chrome.permissions.remove({ origins: [serverPermissionPattern(previous.serverUrl)] });
    status.textContent = revoked
      ? "Signed out of this browser. Pending captures stay here for when you sign in to the same account."
      : "Signed out of this browser. Margin Chat could not be reached to end the server session; it will expire automatically.";
  } catch (error) {
    status.className = "error";
    status.textContent = errorText(error);
  } finally {
    setBusy(false);
  }
});

void initialize().catch((error) => { status.textContent = errorText(error); });
