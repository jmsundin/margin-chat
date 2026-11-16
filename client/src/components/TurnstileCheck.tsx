import { useEffect, useRef } from "react";

/**
 * Cloudflare Turnstile, the "are you a person" check on sign-up and password reset. It is
 * on only when VITE_TURNSTILE_SITE_KEY is set at build time, and only on the website: the
 * desktop app's own page isn't a site Cloudflare can vouch for, so it signs up on the web.
 * Most people never see a puzzle; the widget passes in the background and hands over a token.
 */
export const TURNSTILE_SITE_KEY = (import.meta.env.VITE_TURNSTILE_SITE_KEY as string | undefined)?.trim() || null;

export function turnstileOnThisPage() {
  return Boolean(TURNSTILE_SITE_KEY) && (window.location.protocol === "https:" || window.location.protocol === "http:");
}

/** Sign-up asks for the check only where it can run; the desktop app sends people to the website instead. */
export function signupNeedsWebsite() {
  return Boolean(TURNSTILE_SITE_KEY) && !turnstileOnThisPage();
}

interface TurnstileApi {
  render: (element: HTMLElement, options: Record<string, unknown>) => string;
  remove: (widgetId: string) => void;
  reset: (widgetId: string) => void;
}
declare global { interface Window { turnstile?: TurnstileApi } }

let scriptLoad: Promise<TurnstileApi> | null = null;
function loadTurnstile(): Promise<TurnstileApi> {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  scriptLoad ??= new Promise<TurnstileApi>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
    script.async = true;
    script.onload = () => window.turnstile ? resolve(window.turnstile) : reject(new Error("Turnstile did not start."));
    script.onerror = () => { scriptLoad = null; reject(new Error("The check that you're a person couldn't load. Check your connection and reload.")); };
    document.head.appendChild(script);
  });
  return scriptLoad;
}

/**
 * Renders the check and reports its token (null until it passes, and again when it expires).
 * `resetKey` changing (after a failed submit) asks for a fresh token, since each one works once.
 */
export default function TurnstileCheck({ onToken, onError, resetKey = 0, theme }: {
  onToken: (token: string | null) => void;
  onError?: (message: string) => void;
  resetKey?: number;
  theme: "light" | "dark";
}) {
  const container = useRef<HTMLDivElement>(null);
  const widget = useRef<string | null>(null);
  const latest = useRef({ onToken, onError });
  latest.current = { onToken, onError };

  useEffect(() => {
    if (!TURNSTILE_SITE_KEY) return;
    let cancelled = false;
    loadTurnstile().then((api) => {
      if (cancelled || !container.current) return;
      widget.current = api.render(container.current, {
        sitekey: TURNSTILE_SITE_KEY,
        theme,
        appearance: "interaction-only",
        callback: (token: string) => latest.current.onToken(token),
        "expired-callback": () => latest.current.onToken(null),
        "error-callback": () => { latest.current.onToken(null); latest.current.onError?.("The check that you're a person didn't load. Reload the page and try again."); },
      });
    }, (error: Error) => latest.current.onError?.(error.message));
    return () => {
      cancelled = true;
      if (widget.current) window.turnstile?.remove(widget.current);
      widget.current = null;
    };
  }, [theme]);

  useEffect(() => {
    if (!resetKey || !widget.current) return;
    latest.current.onToken(null);
    window.turnstile?.reset(widget.current);
  }, [resetKey]);

  return <div className="auth-turnstile" ref={container} />;
}
