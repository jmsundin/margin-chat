import {
  CONNECTION_API_PATH,
  normalizeServerUrl,
  type CaptureConnection,
} from "@margin-chat/capture-contracts";
import { getSettings, trustedStorage } from "./storage";
import { captureRequest, errorText } from "./network";
import { serverPermissionPattern } from "./permissions";
const el = <T extends HTMLElement>(id: string) =>
  document.getElementById(id) as T;
const serverInput = el<HTMLInputElement>("server-url");
const tokenInput = el<HTMLInputElement>("token");
const status = el("status");
async function initialize() {
  await trustedStorage();
  const settings = await getSettings();
  el("connected").hidden = !settings;
  if (settings) {
    serverInput.value = settings.serverUrl;
    el("account").textContent =
      `Connected as ${settings.displayName} at ${settings.serverUrl}`;
  }
}
el("connection-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = el<HTMLButtonElement>("connect");
  status.className = "";
  try {
    const serverUrl = normalizeServerUrl(serverInput.value);
    const token = tokenInput.value.trim();
    if (!/^mc_capture_[A-Za-z0-9_-]{43}$/u.test(token))
      throw new Error(
        "Paste a capture key created in your Margin Chat Cloud Inbox.",
      );
    // Permission is requested synchronously from this user gesture, for this server only.
    const allowed = await chrome.permissions.request({
      origins: [serverPermissionPattern(serverUrl)],
    });
    if (!allowed)
      throw new Error("Allow access to your Margin Chat website to connect.");
    button.disabled = true;
    status.textContent = "Checking connection…";
    const connection = await captureRequest<CaptureConnection>(
      { serverUrl, token },
      CONNECTION_API_PATH,
    );
    if (!connection.displayName || !connection.expiresAt)
      throw new Error("This server does not support the web clipper yet.");
    const previous = await getSettings();
    const connectionId =
      previous?.serverUrl === serverUrl && previous.token === token
        ? previous.connectionId
        : crypto.randomUUID();
    await chrome.storage.local.set({
      connection: {
        serverUrl,
        token,
        connectionId,
        displayName: connection.displayName,
      },
    });
    if (
      previous &&
      serverPermissionPattern(previous.serverUrl) !==
        serverPermissionPattern(serverUrl)
    )
      await chrome.permissions.remove({
        origins: [serverPermissionPattern(previous.serverUrl)],
      });
    tokenInput.value = "";
    status.textContent =
      "Connected. Open a web page and click Save to Margin to capture it.";
    await initialize();
  } catch (error) {
    status.className = "error";
    status.textContent = errorText(error);
  } finally {
    button.disabled = false;
  }
});
el("disconnect").addEventListener("click", async () => {
  try {
    const previous = await getSettings();
    await chrome.storage.local.remove("connection");
    if (previous)
      await chrome.permissions.remove({
        origins: [serverPermissionPattern(previous.serverUrl)],
      });
    status.textContent =
      "Disconnected. You can also revoke the key in Margin Chat.";
    await initialize();
  } catch (error) {
    status.textContent = errorText(error);
  }
});
void initialize().catch((error) => {
  status.textContent = errorText(error);
});
