/**
 * Links in a document open in a new tab (the desktop app hands them to the default browser).
 * A tap opens a link on a touch screen, and in Reading mode a plain click does too. While editing
 * with a mouse, a plain click still places the caret, so Cmd or Ctrl and click opens it.
 */

/** Only web and mail addresses open; a bare `www.` address is read as https. */
export function openableHref(href: string | null | undefined): string | null {
  const trimmed = href?.trim();
  if (!trimmed) return null;
  if (/^(https?:|mailto:)/i.test(trimmed)) return trimmed;
  if (/^www\.[^\s.]+\.\S/i.test(trimmed)) return `https://${trimmed}`;
  return null;
}

export interface LinkClick {
  button: number;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  /** How the last press began: "mouse", "touch" or "pen". */
  pointerType: string;
  /** The document can't be edited here, as in Reading mode. */
  readOnly: boolean;
  /** Text is selected, so the click ended a drag, not a tap. */
  selecting: boolean;
}

export function shouldOpenLink(click: LinkClick): boolean {
  if (click.button !== 0 || click.selecting) return false;
  if (click.metaKey || click.ctrlKey) return true;
  if (click.shiftKey || click.altKey) return false;
  return click.readOnly || click.pointerType === "touch" || click.pointerType === "pen";
}

export function openLinkInNewTab(href: string) {
  window.open(href, "_blank", "noopener,noreferrer");
}

const isApple = typeof navigator !== "undefined" && /Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent);

/** The hover hint on a link while editing with a mouse. */
export const OPEN_LINK_HINT = `${isApple ? "⌘" : "Ctrl"}-click to open`;
