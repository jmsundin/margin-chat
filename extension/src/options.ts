import { CONNECTION_API_PATH, parseCaptureConnection } from "@margin-chat/capture-contracts";
import { connectionIdentity, getPending, getSettings, trustedStorage } from "./storage";
import { captureRequest, errorText, signInWorkspace, signOut } from "./network";
import { serverPermissionPattern } from "./permissions";
import { MARGIN_CHAT_SERVER_URL } from "./server";
import { chooseTheme, isTheme, syncExtensionPageTheme } from "./theme";

const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const emailInput = el<HTMLInputElement>("email");
const passwordInput = el<HTMLInputElement>("password");
const status = el("status");
let busy = false;

const themeButtons = [...document.querySelectorAll<HTMLButtonElement>("[data-theme-choice]")];
syncExtensionPageTheme(document, (theme) => themeButtons.forEach((button) => button.setAttribute("aria-pressed", String(button.dataset.themeChoice === theme))));
for (const button of themeButtons) button.addEventListener("click", () => {
  const theme = button.dataset.themeChoice;
  if (!isTheme(theme)) return;
  chooseTheme(theme);
  themeButtons.forEach((item) => item.setAttribute("aria-pressed", String(item === button)));
});

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
    emailInput.value = settings.email ?? "";
    const name = settings.email ?? settings.displayName;
    const expired = settings.expiresAt && Date.parse(settings.expiresAt) <= Date.now();
    el("account").textContent = expired
      ? `Your session for ${name} has expired. Sign in again below to continue.`
      : settings.serverUrl !== MARGIN_CHAT_SERVER_URL
        ? `Signed in as ${name} at ${settings.serverUrl}. Sign in again below to switch to ${MARGIN_CHAT_SERVER_URL}.`
        : !/^mc_workspace_/u.test(settings.token)
          ? `Signed in as ${name} with capture-only access. Sign in again below to enable Workspace + AI.`
          : `Signed in as ${name}`;
  }
}

el("connection-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (busy) return;
  setBusy(true);
  status.className = "";
  try {
    const serverUrl = MARGIN_CHAT_SERVER_URL;
    const email = emailInput.value.trim();
    const password = passwordInput.value;
    if (!email || !password) throw new Error("Enter your Margin Chat email and password.");
    // Keep this permission request in the submit gesture; credentials go only to this origin.
    const allowed = await chrome.permissions.request({ origins: [serverPermissionPattern(serverUrl)] });
    if (!allowed) throw new Error("Allow access to Margin Chat to sign in.");
    status.textContent = "Signing in…";
    const session = await signInWorkspace(serverUrl, email, password);
    const previous = await getSettings();
    const connectionId = connectionIdentity(serverUrl, session.user.id);

    // Preserve a v0.1 draft only when the server proves its old connection owns the same account.
    if (previous?.serverUrl === serverUrl && !previous.userId) {
      const oldAccount = await captureRequest(previous, CONNECTION_API_PATH, parseCaptureConnection).catch(() => null);
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
    if (previous && /^mc_(extension|workspace)_/u.test(previous.token)) await signOut(previous).catch(() => undefined);
    if (previous && serverPermissionPattern(previous.serverUrl) !== serverPermissionPattern(serverUrl)) {
      await chrome.permissions.remove({ origins: [serverPermissionPattern(previous.serverUrl)] });
    }
    await initialize();
    status.textContent = "Signed in. Open a web page and click Margin Chat to use your documents, notes, and AI above the page.";
  } catch (error) {
    status.className = "error";
    status.textContent = errorText(error, "Could not reach Margin Chat. Check your internet connection, then try again.");
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
    if (previous && /^mc_(extension|workspace)_/u.test(previous.token)) {
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
