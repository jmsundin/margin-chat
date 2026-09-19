import assert from "node:assert/strict";
import { Window } from "happy-dom";

const browser = new Window({ url: "http://context-picker.test" });
for (const name of ["window", "document", "navigator", "HTMLElement", "Element", "Node", "Document", "DocumentFragment", "MutationObserver", "Event", "MouseEvent", "KeyboardEvent", "FocusEvent"]) {
  const value = name === "window" ? browser : (browser as any)[name];
  if (value !== undefined) Object.defineProperty(globalThis, name, { configurable: true, value });
}
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const { act, createElement, useState } = await import("../../client/node_modules/react/index.js");
const { createRoot } = await import("../../client/node_modules/react-dom/client.js");
const { default: ServicePickerModal } = await import("../../client/src/components/ServicePickerModal");
const { default: AIControls } = await import("../../client/src/components/AIControls");
const container = browser.document.createElement("div");
browser.document.body.append(container);
const root = createRoot(container as unknown as Element);
let settingsClicks = 0;
let latestSettings: any;
const conversation = {
  id: "context-chat", title: "Context test", parentId: null, childIds: [], branchAnchor: null,
  serviceId: "backend-services" as const, modelId: "auto", createdAt: "2026-09-19T00:00:00Z", updatedAt: "2026-09-19T00:00:00Z", messages: [],
};
function Host() {
  const [open, setOpen] = useState(true);
  const [currentConversation, setConversation] = useState(conversation);
  return createElement("div", { onClick: () => { settingsClicks++; } }, createElement(ServicePickerModal, {
    currentServiceId: currentConversation.serviceId, currentModelId: currentConversation.modelId, isOpen: open,
    onClose: () => setOpen(false), onSelectModel() {}, recentSelections: [],
    contextControls: createElement(AIControls, {
      conversation: currentConversation, conversations: { [conversation.id]: currentConversation, other: { ...conversation, id: "other", title: "Research notes", kind: "note" } },
      onChange(settings) { latestSettings = settings; setConversation((current) => ({ ...current, ai: settings })); },
    }),
  }));
}
const checks: string[] = [];
try {
  await act(async () => { root.render(createElement(Host)); });
  const dialog = browser.document.querySelector('[role="dialog"]')!;
  assert(dialog.querySelector('[aria-label="Context and preferences"]'));
  const summary = dialog.querySelector(".ai-controls > summary")!;
  const close = dialog.querySelector<HTMLButtonElement>('[aria-label="Close model picker"]')!;
  close.focus();
  await act(async () => { close.dispatchEvent(new browser.KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true })); });
  assert(browser.document.activeElement === summary, "Collapsed settings must keep hidden inputs out of the tab loop.");
  await act(async () => { summary.click(); });
  assert.equal(settingsClicks, 0, "Context settings clicks must not activate the chat behind the portal.");
  checks.push("context settings are discoverable and collapsed fields are excluded from focus");

  const scope = dialog.querySelector<HTMLSelectElement>('select[aria-label="Context available to AI"]')!;
  await act(async () => {
    scope.value = "selected";
    scope.dispatchEvent(new browser.Event("change", { bubbles: true }));
  });
  assert.equal(latestSettings.contextScope, "selected");
  const noteCheckbox = dialog.querySelector<HTMLInputElement>('.ai-context-options input[type="checkbox"]')!;
  await act(async () => { noteCheckbox.click(); });
  assert.deepEqual(latestSettings.selectedConversationIds, ["other"]);
  const lastProvider = [...dialog.querySelectorAll<HTMLInputElement>('.ai-provider-options input')].at(-1)!;
  lastProvider.focus();
  await act(async () => { lastProvider.dispatchEvent(new browser.KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true })); });
  assert(browser.document.activeElement === close, "Provider checkboxes belong to the modal tab loop.");
  checks.push("context selection changes work and checkboxes belong to the modal focus loop");

  await act(async () => {
    scope.value = "conversation";
    scope.dispatchEvent(new browser.Event("change", { bubbles: true }));
  });
  dialog.querySelector<HTMLFieldSetElement>(".ai-provider-options")!.disabled = true;
  scope.focus();
  await act(async () => { scope.dispatchEvent(new browser.KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true })); });
  assert(browser.document.activeElement === close, "Select controls belong to the tab loop; disabled fieldset inputs do not.");
  assert.equal(settingsClicks, 0);
  await act(async () => { close.click(); });
  assert.equal(browser.document.querySelector('[role="dialog"]'), null);
  checks.push("select controls are trapped, disabled controls are skipped, and portal events stay isolated");
  console.log(JSON.stringify({ checks }));
} finally {
  await act(async () => { root.unmount(); });
  await browser.happyDOM.close();
}
