import { useSyncExternalStore } from "react";
import { dictationSupported, readDictationButtonPreference, subscribeDictationButtonPreference } from "../lib/dictation";

/** Whether mic buttons show: the browser can record and the "Voice typing button" setting is on. */
export function useDictationButton(): boolean {
  const shown = useSyncExternalStore(subscribeDictationButtonPreference, readDictationButtonPreference, () => true);
  return shown && dictationSupported();
}

export function MicIcon({ size = 14 }: { size?: number }) {
  return (
    <svg aria-hidden="true" fill="none" height={size} stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth={size > 14 ? 1.6 : 2} viewBox="0 0 24 24" width={size}>
      <rect height="12" rx="3" width="6" x="9" y="3" />
      <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
    </svg>
  );
}
