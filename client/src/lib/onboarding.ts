/**
 * What this browser remembers about showing someone around: whether the
 * "Start here" document was made, and where the guided tour stands.
 */
export type TourStatus =
  /** Not a new account on this device, or the tour was never offered. */
  | "none"
  /** Showing now. */
  | "active"
  /** Left before the end; the Tour pill resumes it. */
  | "paused"
  /** Finished, or hidden from the pill. "Take the tour" still replays it. */
  | "done";

export interface OnboardingRecord {
  /** The workspace was checked once: either "Start here" was made, or it already had documents. */
  checked: boolean;
  tour: TourStatus;
  /** The tour step to show next. */
  step: number;
  /** Map View was opened at least once. */
  mapSeen: boolean;
  /** "Keep for now" was chosen on the hide question, so the pill stops asking. */
  keepPill: boolean;
  /** The free trial's example vault was added, so deleting it doesn't bring it back. */
  examples: boolean;
}

const EMPTY: OnboardingRecord = { checked: false, tour: "none", step: 0, mapSeen: false, keepPill: false, examples: false };
const recordKey = (userId: string) => `margin-chat:onboarding:${userId}`;
const TOUR_STATUSES = new Set<TourStatus>(["none", "active", "paused", "done"]);

export function loadOnboarding(userId: string): OnboardingRecord {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(recordKey(userId)) ?? "{}");
    if (!stored || typeof stored !== "object") return { ...EMPTY };
    const value = stored as Record<string, unknown>;
    return {
      checked: value.checked === true,
      tour: TOUR_STATUSES.has(value.tour as TourStatus) ? value.tour as TourStatus : "none",
      step: Number.isSafeInteger(value.step) && (value.step as number) >= 0 ? value.step as number : 0,
      mapSeen: value.mapSeen === true,
      keepPill: value.keepPill === true,
      examples: value.examples === true,
    };
  } catch {
    return { ...EMPTY };
  }
}

export function saveOnboarding(userId: string, record: OnboardingRecord) {
  try { localStorage.setItem(recordKey(userId), JSON.stringify(record)); }
  catch { /* Without storage the tour starts over next visit, and the starter is never remade over real documents. */ }
}
