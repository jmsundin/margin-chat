import { useLayoutEffect, useRef } from "react";
import "./AutoSizingDocumentTitle.css";

interface AutoSizingDocumentTitleProps {
  value: string;
  onChange: (value: string) => void;
  onCommit: () => void;
}

const MIN_TITLE_FONT_SIZE = 24;

export default function AutoSizingDocumentTitle({ value, onChange, onCommit }: AutoSizingDocumentTitleProps) {
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const measureRef = useRef<HTMLSpanElement>(null);

  useLayoutEffect(() => {
    const input = inputRef.current;
    const measure = measureRef.current;
    if (!input || !measure) return;
    let active = true;
    let measuredWidth = -1;

    function fitTitle() {
      if (!active || !input || !measure || !input.clientWidth) return;
      measuredWidth = input.clientWidth;
      const maximum = Number.parseFloat(window.getComputedStyle(measure).fontSize) || 36;
      const minimum = Math.min(MIN_TITLE_FONT_SIZE, maximum);
      // Measure at the full title size, shrink to fit a line, then let the
      // textarea wrap naturally once further shrinking would hurt readability.
      const fittingSize = measure.scrollWidth > 0
        ? maximum * Math.max(0, measuredWidth - 1) / measure.scrollWidth
        : maximum;
      let fontSize = Math.max(minimum, Math.min(maximum, fittingSize));
      input.style.height = "0px";
      function fitsOneLine(size: number) {
        input!.style.fontSize = `${size}px`;
        return input!.scrollHeight <= Math.ceil(size * 1.25 + 12);
      }
      // Native textareas can wrap slightly earlier than the measurement span.
      // Check the actual input so a near-fitting title still stays on one line.
      if (!fitsOneLine(fontSize) && fontSize > minimum) {
        let lower = minimum;
        let upper = fontSize;
        if (fitsOneLine(minimum)) {
          for (let attempt = 0; attempt < 8; attempt++) {
            const middle = (lower + upper) / 2;
            if (fitsOneLine(middle)) lower = middle;
            else upper = middle;
          }
        }
        fontSize = lower;
        input.style.fontSize = `${fontSize}px`;
      }
      input.style.height = `${Math.max(input.scrollHeight, Math.ceil(fontSize * 1.25 + 12))}px`;
    }

    fitTitle();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => {
      // Height changes are our own result; only a width change needs a new fit.
      if (input.clientWidth !== measuredWidth) fitTitle();
    });
    observer?.observe(input);
    window.addEventListener("resize", fitTitle);
    document.fonts?.addEventListener("loadingdone", fitTitle);
    void document.fonts?.ready.then(fitTitle);
    return () => {
      active = false;
      observer?.disconnect();
      window.removeEventListener("resize", fitTitle);
      document.fonts?.removeEventListener("loadingdone", fitTitle);
    };
  }, [value]);

  return <div className="document-title">
    <span className="document-title-measure" ref={measureRef} aria-hidden="true">{value || " "}</span>
    <textarea
      aria-label="Document title"
      className="document-title-input"
      ref={inputRef}
      rows={1}
      value={value}
      onChange={(event) => onChange(event.target.value.replace(/[\r\n]+/g, " "))}
      onBlur={onCommit}
      onKeyDown={(event) => {
        if (event.key === "Enter" && !event.nativeEvent.isComposing) {
          event.preventDefault();
          event.currentTarget.blur();
        }
      }}
    />
  </div>;
}
