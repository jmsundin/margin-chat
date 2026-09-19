import assert from "node:assert/strict";
import { Window } from "happy-dom";

const browser = new Window({ url: "http://picker-welcome.test" });
for (const name of ["window", "document", "navigator", "HTMLElement", "Element", "Node", "Document", "DocumentFragment", "MutationObserver", "Event", "MouseEvent", "KeyboardEvent", "FocusEvent"]) {
  const value = name === "window" ? browser : (browser as any)[name];
  if (value !== undefined) Object.defineProperty(globalThis, name, { configurable: true, value });
}
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const { act, createElement, useState } = await import("../../client/node_modules/react/index.js");
const { createRoot } = await import("../../client/node_modules/react-dom/client.js");
const { default: ServicePickerModal } = await import("../../client/src/components/ServicePickerModal");
const { default: AuthLanding } = await import("../../client/src/components/AuthLanding");
const container = browser.document.createElement("div");
browser.document.body.append(container);
const root = createRoot(container as unknown as Element);
const checks: string[] = [];
const selections: unknown[] = [];
const button = (label: string) => {
  const found = [...browser.document.querySelectorAll("button")].find((element) => element.textContent?.trim() === label || element.getAttribute("aria-label") === label);
  assert(found, `Missing button: ${label}`);
  return found;
};
const input = (label: string) => {
  const found = [...container.querySelectorAll("label")].find((element) => element.querySelector("span")?.textContent === label)?.querySelector("input");
  assert(found, `Missing input: ${label}`);
  return found;
};
const type = (element: any, value: string) => {
  Object.getOwnPropertyDescriptor(browser.HTMLInputElement.prototype, "value")!.set!.call(element, value);
  element.dispatchEvent(new browser.Event("input", { bubbles: true }));
};
const submit = () => container.querySelector("form")!.dispatchEvent(new browser.Event("submit", { bubbles: true, cancelable: true }));
function PickerHost() {
  const [open, setOpen] = useState(false);
  return createElement("div", null,
    createElement("button", { onClick: () => setOpen(true) }, "Open models"),
    createElement(ServicePickerModal, {
      currentServiceId: "openai-api", currentModelId: "gpt-5.6", isOpen: open,
      onClose: () => setOpen(false), onSelectModel: (...selection: unknown[]) => selections.push(selection),
      recentSelections: [{ serviceId: "openai-api", modelId: "gpt-5.6" }, { serviceId: "openai-api", modelId: "gpt-5.6" }],
    }),
  );
}
try {
  await act(async () => { root.render(createElement(PickerHost)); });
  const trigger = button("Open models");
  trigger.focus();
  await act(async () => { trigger.click(); });
  const dialog = browser.document.querySelector('[role="dialog"]')!;
  const search = dialog.querySelector('input[type="search"]')!;
  assert.equal(browser.document.activeElement, search);
  assert.equal(dialog.querySelectorAll('[aria-label="Recent models"] .picker-model-row').length, 1);
  assert(dialog.textContent?.includes("AutoDefault"));
  assert.equal(dialog.querySelector('.picker-providers'), null);
  const first = dialog.querySelector("button")!;
  const last = [...dialog.querySelectorAll("button")].at(-1)!;
  last.focus();
  await act(async () => { last.dispatchEvent(new browser.KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true })); });
  assert.equal(browser.document.activeElement, first);
  await act(async () => { first.dispatchEvent(new browser.KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true })); });
  assert.equal(browser.document.activeElement, last);
  await act(async () => { trigger.focus(); });
  assert.equal(browser.document.activeElement, search);
  await act(async () => { search.dispatchEvent(new browser.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); });
  assert.equal(browser.document.querySelector('[role="dialog"]'), null);
  assert.equal(browser.document.activeElement, trigger);
  assert.equal(browser.document.body.style.overflow, "");
  checks.push("picker focuses search, traps both Tab directions, and restores trigger on Escape");

  await act(async () => { trigger.click(); });
  await act(async () => { type(browser.document.querySelector('input[type="search"]'), "gpt-5.6"); });
  const results = browser.document.querySelector('[aria-label="Search results"]')!;
  assert(results);
  assert.equal(results.querySelectorAll('.picker-model-row').length, 6);
  await act(async () => { results.querySelector<HTMLButtonElement>('.picker-model-row')!.click(); });
  assert.deepEqual(selections, [["openai-api", "gpt-5.6"]]);
  assert.equal(browser.document.activeElement, trigger);
  await act(async () => { trigger.click(); });
  await act(async () => { button("Browse by provider").click(); });
  const provider = browser.document.querySelector('.picker-provider-toggle')!;
  await act(async () => { provider.click(); });
  assert.equal(provider.getAttribute("aria-expanded"), "true");
  await act(async () => { button("Close model picker").click(); });
  checks.push("picker searches specific models, selects exact provider, expands providers, and closes explicitly");

  await act(async () => { root.render(createElement(ServicePickerModal, {
    currentServiceId: "huggingface-api", currentModelId: "openai/gpt-oss-120b", isOpen: true,
    onClose() {}, onSelectModel() {}, recentSelections: [],
  })); });
  const legacyDialog = browser.document.querySelector('[role="dialog"]')!;
  assert(legacyDialog.querySelector('.picker-header')?.textContent?.includes("Current: gpt-oss-120b"));
  await act(async () => { type(legacyDialog.querySelector('input[type="search"]'), "hugging face"); });
  const hfRows = [...legacyDialog.querySelectorAll('.picker-model-row')];
  assert.equal(hfRows.length, 7);
  assert(hfRows.some((row) => row.textContent?.includes("DeepSeek V4.1 Flash") && row.textContent.includes("MIT")));
  assert(hfRows.some((row) => row.textContent?.includes("Qwen3.8 27B") && row.textContent.includes("APACHE 2.0")));
  assert(hfRows.some((row) => row.textContent?.includes("GLM 5.3") && row.textContent.includes("Custom license")));
  assert(!hfRows.some((row) => row.textContent?.includes("gpt-oss-120b")));
  checks.push("picker preserves legacy current labels and shows licenses on the refreshed Hugging Face choices");

  const signup: unknown[] = [], login: unknown[] = [], resets: unknown[] = [], resetRequests: unknown[] = [];
  const props = {
    errorMessage: null, isSubmitting: false, theme: "dark" as const, onToggleTheme() {},
    onSignup(values: unknown) { signup.push(values); }, onLogin(values: unknown) { login.push(values); },
    async onRequestPasswordReset(values: unknown) { resetRequests.push(values); return { resetToken: "test-token" }; },
    async onResetPassword(values: unknown) { resets.push(values); return true; },
  };
  await act(async () => { root.render(createElement(AuthLanding, props)); });
  assert(container.querySelector('figure mark'));
  await act(async () => {
    type(input("Name"), "Reader"); type(input("Email"), "reader@example.test"); type(input("Password"), "test-password"); type(input("Confirm password"), "different");
  });
  await act(async () => { submit(); });
  assert.equal(signup.length, 0);
  assert.equal(container.querySelector('[role="alert"]')?.textContent, "Passwords do not match.");
  await act(async () => { type(input("Confirm password"), "test-password"); });
  await act(async () => { submit(); });
  assert.deepEqual(signup, [{ displayName: "Reader", email: "reader@example.test", password: "test-password" }]);
  await act(async () => { button("Log in").click(); });
  await act(async () => { type(input("Email"), "reader@example.test"); type(input("Password"), "test-password"); });
  await act(async () => { submit(); });
  assert.deepEqual(login, [{ email: "reader@example.test", password: "test-password" }]);
  checks.push("welcome preserves signup validation and login payloads");

  await act(async () => { button("Forgot password?").click(); });
  assert.equal(input("Email").value, "reader@example.test");
  await act(async () => { submit(); });
  assert.deepEqual(resetRequests, [{ email: "reader@example.test" }]);
  await act(async () => { type(input("New password"), "new-password"); type(input("Confirm new password"), "new-password"); });
  await act(async () => { submit(); });
  assert.deepEqual(resets, [{ password: "new-password", token: "test-token" }]);
  assert(container.textContent?.includes("Password updated. You can now log in."));
  assert.equal(input("Email").value, "reader@example.test");
  checks.push("welcome preserves password reset and return to login");
  console.log(JSON.stringify({ checks }));
} finally {
  await act(async () => { root.unmount(); });
  await browser.happyDOM.close();
}
