import { useEffect, useId, useRef } from "react";
import { createPortal } from "react-dom";
import type { AIBehaviour, AIStance, MarginMode, NotebookPrefs } from "../lib/notebookPrefs";
import "./NotebookCustomise.css";

type Option<T extends string> = { value: T; label: string; hint: string };
const BEHAVIOURS: Option<AIBehaviour>[] = [
  { value: "thinks", label: "Thinks with you", hint: "Answers end with a question that hands the thinking back to you." },
  { value: "asks", label: "When you ask", hint: "The AI answers what you ask and nothing more." },
];
const PROACTIVE: Option<"on" | "off">[] = [
  { value: "off", label: "Only when asked", hint: "The AI posts a question only when you choose Question this." },
  { value: "on", label: "On its own", hint: "After you pause, the AI may ask one question beside what you just wrote, once per section while the page is open." },
];
const STANCES: Option<AIStance>[] = [
  { value: "supportive", label: "Supportive", hint: "Questions that help the strongest version of your idea." },
  { value: "neutral", label: "Neutral", hint: "Plain questions about evidence and gaps." },
  { value: "antagonistic", label: "Antagonistic", hint: "Questions from a sharp sceptic who disagrees with you." },
];
const MARGINS: Option<MarginMode>[] = [
  { value: "right", label: "Right margin", hint: "Notes and questions sit beside their passage." },
  { value: "marks", label: "Marks only", hint: "A dot beside each passage; click it to read the note. Phones always use marks." },
];

export interface NotebookCustomiseProps {
  open: boolean;
  prefs: NotebookPrefs;
  theme: "light" | "dark";
  quietPage: boolean;
  onChange: (change: Partial<NotebookPrefs>) => void;
  onThemeChange: (theme: "light" | "dark") => void;
  onQuietPageChange: (quiet: boolean) => void;
  onClose: () => void;
}

function Pills<T extends string>({ label, options, value, onChange }: { label: string; options: Option<T>[]; value: T; onChange: (value: T) => void }) {
  const id = useId();
  const chosen = options.find((option) => option.value === value);
  return <fieldset className="notebook-customise-group" aria-describedby={chosen ? `${id}-hint` : undefined}>
    <legend>{label}</legend>
    <div className="notebook-customise-pills" role="radiogroup" aria-label={label}>
      {options.map((option) => <button key={option.value} type="button" role="radio" aria-checked={option.value === value}
        onClick={() => onChange(option.value)}>{option.label}</button>)}
    </div>
    {chosen ? <p id={`${id}-hint`}>{chosen.hint}</p> : null}
  </fieldset>;
}

/** One window, pill toggles only: how the AI behaves, where notes show, and how the page looks. */
export default function NotebookCustomise({ open, prefs, theme, quietPage, onChange, onThemeChange, onQuietPageChange, onClose }: NotebookCustomiseProps) {
  const titleId = useId();
  const dialogRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    dialogRef.current?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus();
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") { event.stopPropagation(); onClose(); } };
    document.addEventListener("keydown", onKey, true);
    return () => { document.removeEventListener("keydown", onKey, true); previous?.focus?.(); };
  }, [open, onClose]);
  if (!open) return null;
  return createPortal(<div className="notebook-customise-backdrop" role="presentation" onClick={onClose}>
    <section ref={dialogRef} className="notebook-customise" role="dialog" aria-modal="true" aria-labelledby={titleId}
      onClick={(event) => event.stopPropagation()}>
      <header>
        <h2 id={titleId}>Customise</h2>
        <button type="button" className="notebook-customise-close" aria-label="Close" onClick={onClose}>×</button>
      </header>
      <Pills label="AI behaviour" options={BEHAVIOURS} value={prefs.aiBehaviour} onChange={(aiBehaviour) => onChange({ aiBehaviour })} />
      <Pills label="AI asks questions" options={PROACTIVE} value={prefs.proactive ? "on" : "off"} onChange={(value) => onChange({ proactive: value === "on" })} />
      <Pills label="Its questions lean" options={STANCES} value={prefs.stance} onChange={(stance) => onChange({ stance })} />
      <Pills label="Notes and questions appear" options={MARGINS} value={prefs.marginMode} onChange={(marginMode) => onChange({ marginMode })} />
      <Pills label="Theme" value={theme} onChange={onThemeChange}
        options={[{ value: "light", label: "Light", hint: "Warm paper and dark ink." }, { value: "dark", label: "Dark", hint: "Light ink on a dark page." }]} />
      <Pills label="Page" value={quietPage ? "paper" : "full"} onChange={(value) => onQuietPageChange(value === "paper")}
        options={[{ value: "paper", label: "Quiet paper", hint: "Paper colours, a serif page, and controls that wait until you point at them." },
          { value: "full", label: "Full toolbars", hint: "Every toolbar shown, on a plain white or dark page." }]} />
    </section>
  </div>, document.body);
}
