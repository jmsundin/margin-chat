import { createEmptyCard, fsrs, generatorParameters, Rating, State, type Card as FsrsCard, type Grade } from "ts-fsrs";

/** Again, Hard, Good, Easy. */
export type FlashcardRating = 1 | 2 | 3 | 4;

export const FLASHCARD_RATINGS: ReadonlyArray<{ rating: FlashcardRating; label: string; key: string }> = [
  { rating: 1, label: "Again", key: "1" },
  { rating: 2, label: "Hard", key: "2" },
  { rating: 3, label: "Good", key: "3" },
  { rating: 4, label: "Easy", key: "4" },
];

/** One answer to one card. Reviews are only ever added; a card's schedule is replayed from them. */
export interface FlashcardReview {
  id: string;
  cardId: string;
  rating: FlashcardRating;
  reviewedAt: string;
  durationMs?: number;
}

export interface FlashcardSchedule {
  state: "new" | "learning" | "review" | "relearning";
  due: number;
  stability: number;
  difficulty: number;
  reps: number;
  lapses: number;
  lastReview: number | null;
}

export interface ScheduleOptions {
  /** Chance of remembering a card when it comes due, 0.7–0.97. */
  retention?: number;
  maximumIntervalDays?: number;
}

const STATE_NAMES: Record<State, FlashcardSchedule["state"]> = {
  [State.New]: "new", [State.Learning]: "learning", [State.Review]: "review", [State.Relearning]: "relearning",
};

const schedulers = new Map<string, ReturnType<typeof fsrs>>();
function scheduler(options: ScheduleOptions = {}) {
  const retention = Math.min(0.97, Math.max(0.7, options.retention ?? 0.9));
  const maximum = Math.max(1, Math.round(options.maximumIntervalDays ?? 36500));
  const key = `${retention}:${maximum}`;
  let found = schedulers.get(key);
  if (!found) {
    // Fuzz spreads reviews of cards learned together; ts-fsrs seeds it from the card, so a replay is the same everywhere.
    found = fsrs(generatorParameters({ request_retention: retention, maximum_interval: maximum, enable_fuzz: true }));
    schedulers.set(key, found);
  }
  return found;
}

const toSchedule = (card: FsrsCard): FlashcardSchedule => ({
  state: STATE_NAMES[card.state],
  due: card.due.getTime(),
  stability: card.stability,
  difficulty: card.difficulty,
  reps: card.reps,
  lapses: card.lapses,
  lastReview: card.last_review ? card.last_review.getTime() : null,
});

const sortReviews = (reviews: ReadonlyArray<FlashcardReview>) =>
  [...reviews].sort((a, b) => a.reviewedAt.localeCompare(b.reviewedAt) || a.id.localeCompare(b.id));

function replay(reviews: ReadonlyArray<FlashcardReview>, createdAt: number, options?: ScheduleOptions): FsrsCard {
  const engine = scheduler(options);
  let card = createEmptyCard(new Date(createdAt));
  for (const review of sortReviews(reviews)) {
    const at = new Date(review.reviewedAt);
    if (Number.isNaN(at.getTime()) || review.rating < 1 || review.rating > 4) continue;
    card = engine.next(card, at, review.rating as Grade).card;
  }
  return card;
}

/** Where a card stands after its reviews, oldest first or in any order. */
export function scheduleFromReviews(reviews: ReadonlyArray<FlashcardReview>, createdAt = 0, options?: ScheduleOptions): FlashcardSchedule {
  return toSchedule(replay(reviews, createdAt, options));
}

/** When the card would next come due for each answer, given now. */
export function previewRatings(reviews: ReadonlyArray<FlashcardReview>, now: number, options?: ScheduleOptions): Record<FlashcardRating, number> {
  const card = replay(reviews, now, options);
  const outcomes = scheduler(options).repeat(card, new Date(now));
  return {
    1: outcomes[Rating.Again].card.due.getTime(),
    2: outcomes[Rating.Hard].card.due.getTime(),
    3: outcomes[Rating.Good].card.due.getTime(),
    4: outcomes[Rating.Easy].card.due.getTime(),
  };
}

/** "1m", "10m", "3h", "4d", "2.5mo", "1.2y" */
export function formatInterval(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = minutes / 60;
  if (hours < 24) return `${Math.round(hours)}h`;
  const days = hours / 24;
  if (days < 30) return `${Math.round(days)}d`;
  if (days < 365) return `${Number((days / 30).toFixed(1)).toString()}mo`;
  return `${Number((days / 365).toFixed(1)).toString()}y`;
}

/** Start of the study day: 4 AM local, like most flashcard apps, so a late-night session counts for that day. */
export function studyDayStart(now: number): number {
  const date = new Date(now);
  date.setHours(4, 0, 0, 0);
  if (date.getTime() > now) date.setDate(date.getDate() - 1);
  return date.getTime();
}

export interface QueueCard<T> { card: T; schedule: FlashcardSchedule }

/**
 * The cards to study now: learning cards due, then reviews due (most overdue first),
 * then new cards up to today's allowance, in the order they were written.
 */
export function buildStudyQueue<T extends { id: string }>(
  cards: ReadonlyArray<QueueCard<T>>,
  now: number,
  { newPerDay = 20, newStudiedToday = 0 }: { newPerDay?: number; newStudiedToday?: number } = {},
): { learning: QueueCard<T>[]; review: QueueCard<T>[]; fresh: QueueCard<T>[]; dueCount: number; newCount: number } {
  const dayEnd = studyDayStart(now) + 24 * 3_600_000;
  const learning: QueueCard<T>[] = [], review: QueueCard<T>[] = [], fresh: QueueCard<T>[] = [];
  for (const entry of cards) {
    const { state, due } = entry.schedule;
    if (state === "new") fresh.push(entry);
    else if (state === "review" ? due < dayEnd : due <= now) (state === "review" ? review : learning).push(entry);
  }
  learning.sort((a, b) => a.schedule.due - b.schedule.due);
  review.sort((a, b) => a.schedule.due - b.schedule.due);
  const allowance = Math.max(0, newPerDay - newStudiedToday);
  const freshToday = fresh.slice(0, allowance);
  return { learning, review, fresh: freshToday, dueCount: learning.length + review.length, newCount: freshToday.length };
}
