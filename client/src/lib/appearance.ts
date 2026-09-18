export type ThemeMode = "light" | "dark";
export const THEME_STORAGE_KEY = "margin-chat-theme";

export function getNextTheme(theme: ThemeMode): ThemeMode {
  return theme === "dark" ? "light" : "dark";
}

export function loadInitialTheme(): ThemeMode {
  if (typeof window === "undefined") {
    return "dark";
  }

  try {
    const storedValue = window.localStorage.getItem(THEME_STORAGE_KEY);

    if (storedValue === "light" || storedValue === "dark") {
      return storedValue;
    }
  } catch {
    return window.matchMedia("(prefers-color-scheme: light)").matches
      ? "light"
      : "dark";
  }

  return window.matchMedia("(prefers-color-scheme: light)").matches
    ? "light"
    : "dark";
}

export function syncTheme(theme: ThemeMode) {
  if (typeof document === "undefined") {
    return;
  }

  document.documentElement.dataset.theme = theme;
}
