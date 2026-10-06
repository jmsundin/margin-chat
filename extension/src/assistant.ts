import { createAssistantCard } from "./assistant-card";
import { getSettings, trustedStorage } from "./storage";
import { createWorkspaceFetch } from "./workspace-transport";

const params = new URLSearchParams(location.search);
const card = createAssistantCard(document, {
  params,
  sendMessage: (message) => chrome.runtime.sendMessage(message),
  getSettings: async () => { await trustedStorage(); return getSettings(); },
  createFetch: (connection) => createWorkspaceFetch({ connection, getSettings, fetch: window.fetch.bind(window) }),
  openSettings: () => { void chrome.runtime.openOptionsPage(); },
});
void card.start();
