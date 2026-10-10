import type { MainViewMode } from "../types";

/** Workspace views in toggle order, each with its Cmd/Ctrl shortcut. */
export const workspaceViews: ReadonlyArray<{ mode: MainViewMode; label: string; key: string; shift: boolean }> = [
  // Plain Cmd+D inserts the date in documents, so Document takes the Shift variant.
  { mode: "chat", label: "Document View", key: "d", shift: true },
  { mode: "tiles", label: "Tile View", key: "l", shift: true },
  // G for graph; replaces the browser's Find next inside the app.
  { mode: "graph", label: "Map View", key: "g", shift: false },
];

export const isApplePlatform = () => typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

/** "⌘⇧D" on Apple platforms, "Ctrl+Shift+D" elsewhere. */
export function shortcutLabel(view: (typeof workspaceViews)[number], apple = isApplePlatform()): string {
  const key = view.key.toUpperCase();
  if (apple) return `⌘${view.shift ? "⇧" : ""}${key}`;
  return `Ctrl+${view.shift ? "Shift+" : ""}${key}`;
}

/** The value for aria-keyshortcuts, covering both platforms. */
export function ariaShortcut(view: (typeof workspaceViews)[number]): string {
  const key = view.key.toUpperCase();
  const shift = view.shift ? "Shift+" : "";
  return `Meta+${shift}${key} Control+${shift}${key}`;
}

/** The view a keydown asks for, or null when it isn't a view shortcut. */
export function viewForShortcut(event: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey" | "isComposing">): MainViewMode | null {
  if (!(event.metaKey || event.ctrlKey) || event.altKey || event.isComposing) return null;
  const key = event.key.toLowerCase();
  return workspaceViews.find((view) => view.key === key && view.shift === event.shiftKey)?.mode ?? null;
}
