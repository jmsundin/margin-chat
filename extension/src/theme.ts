export type Theme = "light" | "dark";
/** The Margin Chat app's own key, shared by every extension-origin page. */
export const THEME_STORAGE_KEY = "margin-chat-theme";
/** Mirrored into chrome.storage.local so the background can tell page shells. */
export const THEME_MIRROR_KEY = "theme";

export const isTheme = (value: unknown): value is Theme => value === "light" || value === "dark";

/**
 * The app's palette (client/src/styles.css) for the surfaces the extension draws
 * on web pages and in its own small pages. Values are CSS custom properties.
 */
export const THEME_TOKENS: Record<Theme, Record<string, string>> = {
  dark: {
    "--mc-bg": "#091015", "--mc-head": "#121b21", "--mc-raised": "#18232a",
    "--mc-line": "rgba(224,236,230,.12)", "--mc-line-strong": "rgba(224,236,230,.24)",
    "--mc-ink": "#ecf4ef", "--mc-muted": "#97a9a2", "--mc-sage": "#7acaa4", "--mc-sage-ink": "#08100d",
    "--mc-hover": "rgba(122,202,164,.16)", "--mc-hover-line": "rgba(122,202,164,.32)",
    "--mc-accent": "#ff8d6d", "--mc-danger": "#ff6f61", "--mc-shadow": "rgba(0,0,0,.45)",
  },
  light: {
    "--mc-bg": "#ece4d6", "--mc-head": "#f4ecdf", "--mc-raised": "#faf5ec",
    "--mc-line": "rgba(31,42,36,.12)", "--mc-line-strong": "rgba(31,42,36,.24)",
    "--mc-ink": "#1f2a24", "--mc-muted": "#59655e", "--mc-sage": "#2e5947", "--mc-sage-ink": "#f7f3ea",
    "--mc-hover": "rgba(46,89,71,.12)", "--mc-hover-line": "rgba(46,89,71,.3)",
    "--mc-accent": "#a94b32", "--mc-danger": "#a13725", "--mc-shadow": "rgba(46,41,31,.22)",
  },
};
const declarations = (theme: Theme) => Object.entries(THEME_TOKENS[theme]).map(([name, value]) => `${name}:${value}`).join(";");
/** Shadow-root CSS: dark unless the host carries data-theme="light". */
export const hostThemeCss = () =>
  `:host{${declarations("dark")};color-scheme:dark!important}:host([data-theme=light]){${declarations("light")};color-scheme:light!important}`;

const systemTheme = (win: Window): Theme => win.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark";

/**
 * Page shells cannot read the extension's storage. They follow the theme the
 * background reports, falling back to the system setting like the app does.
 */
export function followPageTheme(win: Window, hosts: HTMLElement[]) {
  let chosen: Theme | null = null;
  const media = win.matchMedia?.("(prefers-color-scheme: light)");
  const apply = () => { const theme = chosen ?? systemTheme(win); for (const host of hosts) host.dataset.theme = theme; };
  media?.addEventListener?.("change", apply);
  apply();
  return {
    set(theme: unknown) { chosen = isTheme(theme) ? theme : null; apply(); },
    destroy() { media?.removeEventListener?.("change", apply); },
  };
}

/** The app's theme in an extension page: its stored choice, else the system's. */
export function storedTheme(win: Window = window): Theme {
  try { const value = win.localStorage.getItem(THEME_STORAGE_KEY); if (isTheme(value)) return value; } catch { /* Storage can be blocked. */ }
  return systemTheme(win);
}

async function mirror(theme: Theme) {
  try {
    if ((await chrome.storage.local.get(THEME_MIRROR_KEY))[THEME_MIRROR_KEY] !== theme) await chrome.storage.local.set({ [THEME_MIRROR_KEY]: theme });
  } catch { /* Previews and tests run without extension storage. */ }
}

/** Choose a theme from an extension page; every open workspace follows it. */
export function chooseTheme(theme: Theme, doc: Document = document) {
  try { doc.defaultView!.localStorage.setItem(THEME_STORAGE_KEY, theme); } catch { /* Storage can be blocked. */ }
  doc.documentElement.dataset.theme = theme;
  void mirror(theme);
}

/**
 * Keep a small extension page (popup, options, answer card) on the app's theme,
 * including changes made in another extension page.
 */
export function syncExtensionPageTheme(doc: Document = document, onChange?: (theme: Theme) => void) {
  const win = doc.defaultView!;
  const apply = () => { const theme = storedTheme(win); doc.documentElement.dataset.theme = theme; onChange?.(theme); return theme; };
  void mirror(apply());
  win.addEventListener("storage", (event) => { if (event.key === THEME_STORAGE_KEY) apply(); });
  win.matchMedia?.("(prefers-color-scheme: light)").addEventListener?.("change", apply);
}

/** The full app sets data-theme itself; mirror each change for the page shells. */
export function mirrorAppTheme(doc: Document = document) {
  const report = () => { const theme = doc.documentElement.dataset.theme; if (isTheme(theme)) void mirror(theme); };
  new MutationObserver(report).observe(doc.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  report();
}
