/**
 * One review session: which card is on screen, which come next, and which cards still
 * being learned come back later in the session.
 *
 * The card on screen stays until it is answered, suspended or taken back. A learning
 * card that comes due waits for the next pick, so it never replaces the card you are on.
 */
export interface StudySession {
  /** Cards that were due when the session started, in study order. */
  order: string[];
  /** Cards answered in this session that come back once their short step is up. */
  later: Array<{ id: string; due: number }>;
  /** The card on screen, or null while nothing is ready. */
  current: string | null;
  /** Counts each card shown, so the same card shown twice in a row starts face down again. */
  turn: number;
}

/** With nothing else left, a learning card due within this long is shown early, as Anki does. */
export const LEARN_AHEAD_MS = 20 * 60_000;
/** Answers with a next step this short come back in the same session; longer ones wait for their day. */
export const SAME_SESSION_MS = 60 * 60_000;

type Has = (id: string) => boolean;
const always: Has = () => true;

/** The next card to show: a learning card whose step is up, then the session's due cards, then learning cards ahead of time. */
export function pickNextCard(session: Pick<StudySession, "order" | "later">, now: number, has: Has = always): string | null {
  const later = session.later.filter((entry) => has(entry.id)).sort((a, b) => a.due - b.due);
  const dueLater = later.find((entry) => entry.due <= now);
  if (dueLater) return dueLater.id;
  const next = session.order.find((id) => has(id) && !later.some((entry) => entry.id === id));
  if (next) return next;
  return later.find((entry) => entry.due <= now + LEARN_AHEAD_MS)?.id ?? null;
}

export function startSession(order: string[], now: number, has: Has = always, later: StudySession["later"] = []): StudySession {
  const session = { order, later, current: null, turn: 0 };
  const current = pickNextCard(session, now, has);
  return { ...session, current, turn: current ? 1 : 0 };
}

function advance(order: string[], later: StudySession["later"], turn: number, now: number, has: Has): StudySession {
  const current = pickNextCard({ order, later }, now, has);
  return { order, later, current, turn: current ? turn + 1 : turn };
}

/** After an answer: the card leaves the session, or comes back at `due` if that's soon, and the next card is picked. */
export function answerInSession(session: StudySession, cardId: string, due: number, now: number, has: Has = always): StudySession {
  const order = session.order.filter((id) => id !== cardId);
  const later = session.later.filter((entry) => entry.id !== cardId);
  if (due - now <= SAME_SESSION_MS) later.push({ id: cardId, due });
  return advance(order, later, session.turn, now, has);
}

/** A card taken out of the session, such as one just suspended. */
export function removeFromSession(session: StudySession, cardId: string, now: number, has: Has = always): StudySession {
  return advance(session.order.filter((id) => id !== cardId), session.later.filter((entry) => entry.id !== cardId), session.turn, now, has);
}

/**
 * Looks again without disturbing the card on screen: only when there is no card, or
 * the one shown no longer exists, is another one picked. Returns the same session when nothing changes.
 */
export function refreshSession(session: StudySession, now: number, has: Has = always): StudySession {
  if (session.current && has(session.current)) return session;
  const current = pickNextCard(session, now, has);
  if (current === session.current) return session;
  return { ...session, current, turn: current ? session.turn + 1 : session.turn };
}
