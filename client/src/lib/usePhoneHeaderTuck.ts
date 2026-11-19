import { useEffect } from "react";

/** Same width as the phone layout in MobileKeyboard; tablets and computers keep the header in place. */
const PHONE_QUERY = "(max-width: 700px)";
/** Near the top of a page the header always shows. */
const SHOW_NEAR_TOP = 80;
/** Small scrolls (a finger settling, CodeMirror re-measuring lines) don't move the header. */
const MIN_MOVE = 12;
export const PHONE_HEADER_ATTRIBUTE = "data-phone-header";

/**
 * On phones the document header slides away while the reader scrolls down a page and comes
 * back as soon as they scroll up, like a browser's address bar. It marks the body with
 * data-phone-header="tucked" and the header's height (--tucked-header-height); CSS does the rest.
 * `resetKey` (the open document) brings the header back when another page opens.
 */
export function usePhoneHeaderTuck(resetKey: string) {
  useEffect(() => {
    const body = document.body;
    body.removeAttribute(PHONE_HEADER_ATTRIBUTE);
    const phone = window.matchMedia?.(PHONE_QUERY);
    if (!phone) return undefined;
    const last = new WeakMap<HTMLElement, number>();
    const show = () => body.removeAttribute(PHONE_HEADER_ATTRIBUTE);
    const onScroll = (event: Event) => {
      const target = event.target;
      if (!phone.matches || !(target instanceof HTMLElement) || !target.classList.contains("document-body")) return;
      const top = target.scrollTop;
      const previous = last.get(target);
      if (previous === undefined) { last.set(target, top); return; }
      if (top < SHOW_NEAR_TOP) { last.set(target, top); show(); return; }
      if (Math.abs(top - previous) < MIN_MOVE) return;
      last.set(target, top);
      if (top < previous) { show(); return; }
      const header = target.closest(".document-workspace")?.querySelector<HTMLElement>(".document-workspace-header");
      if (!header?.offsetHeight) return;
      body.style.setProperty("--tucked-header-height", `${header.offsetHeight}px`);
      body.setAttribute(PHONE_HEADER_ATTRIBUTE, "tucked");
    };
    const onChange = () => { if (!phone.matches) show(); };
    document.addEventListener("scroll", onScroll, { capture: true, passive: true });
    phone.addEventListener?.("change", onChange);
    return () => {
      document.removeEventListener("scroll", onScroll, { capture: true });
      phone.removeEventListener?.("change", onChange);
      show();
    };
  }, [resetKey]);
}
