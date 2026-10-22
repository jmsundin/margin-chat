import { useEffect, useRef, useState } from "react";

/** Recordings of the real app, in client/public/landing. mp4 rather than GIF: about a tenth of the size. */
export type ClipName = "web-docs" | "web-map" | "ext-docs" | "ext-map" | "phone-docs" | "phone-map";

const FORMS = [
  { id: "web", label: "Web and desktop", docs: "web-docs", map: "web-map", phone: false,
    docsCaption: "Select a passage: a margin note stays beside it, a side document opens the new idea in its own pane.",
    mapCaption: "Map View draws every document, with lines for side documents, notes and links. Zoom in for titles." },
  { id: "extension", label: "Chrome extension", docs: "ext-docs", map: "ext-map", phone: false,
    docsCaption: "The same workspace docked beside any page you're reading, so notes never leave the source.",
    mapCaption: "Your whole map, right beside the page." },
  { id: "phone", label: "Phone", docs: "phone-docs", map: "phone-map", phone: true,
    docsCaption: "Hold and drag to select. The row under it makes notes and side documents; + and the mic sit by your thumb.",
    mapCaption: "Pinch the map to zoom from topics down to single documents." },
] as const satisfies readonly { id: string; label: string; docs: ClipName; map: ClipName; phone: boolean; docsCaption: string; mapCaption: string }[];

function reducedMotion() {
  return typeof window !== "undefined" && Boolean(window.matchMedia?.("(prefers-reduced-motion: reduce)").matches);
}

/** A muted looping recording. With reduced motion it waits on its poster with controls. */
export function Clip({ name, label, phone = false }: { name: ClipName; label: string; phone?: boolean }) {
  const video = useRef<HTMLVideoElement>(null);
  const [still] = useState(reducedMotion);
  useEffect(() => {
    const element = video.current;
    if (!element || still) return;
    // Plays only while on screen, so a long page doesn't decode six videos at once.
    if (typeof IntersectionObserver === "undefined") { void element.play().catch(() => {}); return; }
    const observer = new IntersectionObserver(([entry]) => {
      if (entry?.isIntersecting) void element.play().catch(() => {});
      else element.pause();
    }, { threshold: 0.25 });
    observer.observe(element);
    return () => observer.disconnect();
  }, [still, name]);
  return <video ref={video} key={name} className={`mk-clip${phone ? " is-phone" : ""}`} src={`/landing/${name}.mp4`} poster={`/landing/${name}.jpg`}
    muted loop playsInline preload={still ? "none" : "metadata"} controls={still} aria-label={label} />;
}

export default function SeeItWorking() {
  const [formId, setFormId] = useState<(typeof FORMS)[number]["id"]>("web");
  const form = FORMS.find((item) => item.id === formId) ?? FORMS[0];
  return <>
    <div className="mk-tabs" role="tablist" aria-label="Where you use Margin Chat">
      {FORMS.map((item) => <button key={item.id} type="button" role="tab" id={`mk-tab-${item.id}`} aria-controls="mk-see-panel"
        aria-selected={item.id === form.id} className={item.id === form.id ? "is-active" : undefined} onClick={() => setFormId(item.id)}>
        {item.label}
      </button>)}
    </div>
    <div id="mk-see-panel" role="tabpanel" aria-labelledby={`mk-tab-${form.id}`} className={`mk-see${form.phone ? " is-phone" : ""}`}>
      <figure>
        <Clip name={form.docs} phone={form.phone} label={`Margin Chat ${form.label}: making a margin note and a side document`} />
        <figcaption><strong>Documents.</strong> {form.docsCaption}</figcaption>
      </figure>
      <figure>
        <Clip name={form.map} phone={form.phone} label={`Margin Chat ${form.label}: Map View`} />
        <figcaption><strong>Map View.</strong> {form.mapCaption}</figcaption>
      </figure>
    </div>
  </>;
}
