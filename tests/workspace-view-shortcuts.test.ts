import { expect, test } from "bun:test";
import { shortcutLabel, viewForShortcut, workspaceViews } from "../client/src/lib/workspaceViewShortcuts";

const press = (key: string, mods: Partial<Record<"metaKey" | "ctrlKey" | "altKey" | "shiftKey", boolean>> = {}) =>
  viewForShortcut({ key, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, isComposing: false, ...mods });

test("Cmd or Ctrl shortcuts pick each workspace view", () => {
  expect(press("g", { metaKey: true })).toBe("graph");
  expect(press("G", { ctrlKey: true })).toBe("graph");
  expect(press("D", { metaKey: true, shiftKey: true })).toBe("chat");
  expect(press("L", { ctrlKey: true, shiftKey: true })).toBe("tiles");
});

test("other combinations are left alone", () => {
  expect(press("g")).toBeNull();
  expect(press("d", { metaKey: true }), "Cmd+D still inserts the date").toBeNull();
  expect(press("g", { metaKey: true, shiftKey: true }), "Cmd+Shift+G stays Find previous").toBeNull();
  expect(press("g", { metaKey: true, altKey: true })).toBeNull();
  expect(viewForShortcut({ key: "g", metaKey: true, ctrlKey: false, altKey: false, shiftKey: false, isComposing: true })).toBeNull();
});

test("labels follow the platform", () => {
  expect(workspaceViews.map((view) => shortcutLabel(view, true))).toEqual(["⌘⇧D", "⌘⇧L", "⌘G"]);
  expect(workspaceViews.map((view) => shortcutLabel(view, false))).toEqual(["Ctrl+Shift+D", "Ctrl+Shift+L", "Ctrl+G"]);
});
