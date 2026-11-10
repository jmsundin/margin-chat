import type { Flashcard } from "./flashcards";
import { relinkFlashcards } from "./flashcards";
import type { FlashcardReview } from "./flashcardSchedule";

/**
 * Cards and every answer given to them, kept on this device in IndexedDB first
 * and copied to the account when it can be. Nothing here is ever overwritten by
 * something older, and reviews are only added, so two devices merge by union.
 */

export interface StoredFlashcard extends Flashcard {
  docTitle: string;
  /** Ids this card had before its text was edited; their reviews are its history. */
  historyFrom?: string[];
  /** The card is no longer written in its document. Its history is kept. */
  removed?: boolean;
  suspended?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface FlashcardSnapshot {
  cards: ReadonlyMap<string, StoredFlashcard>;
  reviews: ReadonlyMap<string, FlashcardReview>;
}

interface Pending { cards: Set<string>; reviews: Set<string> }

const DB_VERSION = 1;
const STORES = ["cards", "reviews", "pending", "meta"] as const;

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => { req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });
}

function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error("Saving flashcards was interrupted."));
  });
}

function openDatabase(name: string): Promise<IDBDatabase | null> {
  if (typeof indexedDB === "undefined") return Promise.resolve(null);
  return new Promise((resolve) => {
    let opened: IDBOpenDBRequest;
    try { opened = indexedDB.open(name, DB_VERSION); } catch { resolve(null); return; }
    opened.onupgradeneeded = () => {
      const db = opened.result;
      for (const store of STORES) if (!db.objectStoreNames.contains(store)) db.createObjectStore(store);
    };
    opened.onsuccess = () => resolve(opened.result);
    opened.onerror = () => resolve(null);
    opened.onblocked = () => resolve(null);
  });
}

const newer = (a: { updatedAt: string }, b: { updatedAt: string }) => a.updatedAt > b.updatedAt;

export class FlashcardStore {
  private cards = new Map<string, StoredFlashcard>();
  private reviews = new Map<string, FlashcardReview>();
  private pending: Pending = { cards: new Set(), reviews: new Set() };
  private listeners = new Set<() => void>();
  private snapshot: FlashcardSnapshot = { cards: this.cards, reviews: this.reviews };
  private db: IDBDatabase | null = null;
  private writes: Promise<void> = Promise.resolve();
  /** Set when this device couldn't keep a change; shown to the person. */
  saveError: string | null = null;
  readonly ready: Promise<void>;

  constructor(readonly namespace: string, options: { memoryOnly?: boolean } = {}) {
    this.ready = options.memoryOnly ? Promise.resolve() : this.load();
  }

  private async load() {
    this.db = await openDatabase(`margin-chat-flashcards:${this.namespace}`);
    if (!this.db) return;
    const tx = this.db.transaction(["cards", "reviews", "pending"], "readonly");
    const [cards, reviews, pendingCards, pendingReviews] = await Promise.all([
      request(tx.objectStore("cards").getAll()) as Promise<StoredFlashcard[]>,
      request(tx.objectStore("reviews").getAll()) as Promise<FlashcardReview[]>,
      request(tx.objectStore("pending").get("cards")) as Promise<string[] | undefined>,
      request(tx.objectStore("pending").get("reviews")) as Promise<string[] | undefined>,
    ]);
    // Anything added in memory while the database opened wins over what was stored.
    for (const card of cards) if (!this.cards.has(card.id) || newer(card, this.cards.get(card.id)!)) this.cards.set(card.id, card);
    for (const review of reviews) if (!this.reviews.has(review.id)) this.reviews.set(review.id, review);
    for (const id of pendingCards ?? []) this.pending.cards.add(id);
    for (const id of pendingReviews ?? []) this.pending.reviews.add(id);
    this.emit();
  }

  subscribe(listener: () => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  getSnapshot(): FlashcardSnapshot { return this.snapshot; }

  private emit() {
    this.snapshot = { cards: new Map(this.cards), reviews: new Map(this.reviews) };
    for (const listener of this.listeners) listener();
  }

  /** Writes run one after another so a later write never lands before an earlier one. */
  private persist(cards: StoredFlashcard[], reviews: FlashcardReview[]) {
    const db = this.db;
    if (!db) return this.writes;
    const pendingCards = [...this.pending.cards], pendingReviews = [...this.pending.reviews];
    this.writes = this.writes.then(async () => {
      const tx = db.transaction(["cards", "reviews", "pending"], "readwrite");
      for (const card of cards) tx.objectStore("cards").put(card, card.id);
      for (const review of reviews) tx.objectStore("reviews").put(review, review.id);
      tx.objectStore("pending").put(pendingCards, "cards");
      tx.objectStore("pending").put(pendingReviews, "reviews");
      await transactionDone(tx);
      this.saveError = null;
    }).catch((error: unknown) => {
      this.saveError = error instanceof Error ? error.message : "This device couldn't save your flashcards.";
      this.emit();
    });
    return this.writes;
  }

  /** Waits until every change so far is on disk. */
  flush() { return this.writes; }

  async getMeta<T>(key: string): Promise<T | undefined> {
    if (!this.db) return undefined;
    return request(this.db.transaction("meta", "readonly").objectStore("meta").get(key)) as Promise<T | undefined>;
  }

  async setMeta(key: string, value: unknown) {
    if (!this.db) return;
    const tx = this.db.transaction("meta", "readwrite");
    tx.objectStore("meta").put(value, key);
    await transactionDone(tx);
  }

  /** Every review that belongs to a card, including those from its earlier ids. */
  reviewsFor(card: Pick<StoredFlashcard, "id" | "historyFrom">, snapshot: FlashcardSnapshot = this.snapshot): FlashcardReview[] {
    const ids = new Set([card.id, ...(card.historyFrom ?? [])]);
    return [...snapshot.reviews.values()].filter((review) => ids.has(review.cardId));
  }

  /**
   * Bring a document's cards up to date with its text. Cards that left the text
   * are marked removed (never deleted); an edited card keeps its history.
   */
  syncDocument(docId: string, docTitle: string, parsed: Flashcard[], now = new Date().toISOString()) {
    const existing = [...this.cards.values()].filter((card) => card.docId === docId);
    const byId = new Map(existing.map((card) => [card.id, card]));
    const parsedIds = new Set(parsed.map((card) => card.id));
    const reviewed = new Set([...this.reviews.values()].map((review) => review.cardId));
    const hasHistory = (card: StoredFlashcard) => [card.id, ...(card.historyFrom ?? [])].some((id) => reviewed.has(id));

    const gone = existing.filter((card) => !card.removed && !parsedIds.has(card.id));
    const fresh = parsed.filter((card) => !byId.has(card.id) || byId.get(card.id)!.removed);
    const relinked = relinkFlashcards(gone.filter(hasHistory), fresh.filter((card) => !byId.has(card.id)));

    const changed: StoredFlashcard[] = [];
    for (const card of parsed) {
      const before = byId.get(card.id);
      const previous = relinked.get(card.id);
      const inherited = previous ? this.cards.get(previous) : undefined;
      const historyFrom = previous ? [...new Set([...(before?.historyFrom ?? []), ...(inherited?.historyFrom ?? []), previous])] : before?.historyFrom;
      const next: StoredFlashcard = {
        ...card, docTitle,
        ...(historyFrom?.length ? { historyFrom } : {}),
        ...((before?.suspended ?? inherited?.suspended) ? { suspended: true } : {}),
        createdAt: before?.createdAt ?? inherited?.createdAt ?? now,
        updatedAt: before?.updatedAt ?? now,
      };
      if (!before || before.removed || before.front !== next.front || before.back !== next.back || before.ordinal !== next.ordinal ||
          before.docTitle !== docTitle || (previous && !before.historyFrom?.includes(previous))) {
        changed.push({ ...next, updatedAt: now });
      }
    }
    // A card whose history moved to its edited version, or that was never studied, is still kept, marked removed.
    for (const card of gone) changed.push({ ...card, removed: true, updatedAt: now });
    if (!changed.length) return 0;
    for (const card of changed) { this.cards.set(card.id, card); this.pending.cards.add(card.id); }
    this.emit();
    void this.persist(changed, []);
    return changed.length;
  }

  /** Record one answer. It is on disk before this resolves (when the device can store it). */
  addReview(review: FlashcardReview) {
    if (this.reviews.has(review.id)) return this.writes;
    this.reviews.set(review.id, review);
    this.pending.reviews.add(review.id);
    this.emit();
    return this.persist([], [review]);
  }

  /** Take back the most recent answer, when it hasn't reached the account yet. */
  undoReview(reviewId: string) {
    if (!this.reviews.has(reviewId) || !this.pending.reviews.has(reviewId)) return false;
    this.reviews.delete(reviewId);
    this.pending.reviews.delete(reviewId);
    this.emit();
    const db = this.db;
    if (db) {
      const pendingReviews = [...this.pending.reviews];
      this.writes = this.writes.then(async () => {
        const tx = db.transaction(["reviews", "pending"], "readwrite");
        tx.objectStore("reviews").delete(reviewId);
        tx.objectStore("pending").put(pendingReviews, "reviews");
        await transactionDone(tx);
      }).catch(() => undefined);
    }
    return true;
  }

  setSuspended(cardId: string, suspended: boolean, now = new Date().toISOString()) {
    const card = this.cards.get(cardId);
    if (!card || Boolean(card.suspended) === suspended) return;
    const next = { ...card, updatedAt: now } as StoredFlashcard;
    if (suspended) next.suspended = true; else delete next.suspended;
    this.cards.set(cardId, next);
    this.pending.cards.add(cardId);
    this.emit();
    void this.persist([next], []);
  }

  /** Changes this device hasn't sent to the account yet. */
  pendingChanges(limit = 1000): { cards: StoredFlashcard[]; reviews: FlashcardReview[] } {
    const cards = [...this.pending.cards].slice(0, limit).map((id) => this.cards.get(id)).filter((card): card is StoredFlashcard => Boolean(card));
    const reviews = [...this.pending.reviews].slice(0, limit).map((id) => this.reviews.get(id)).filter((review): review is FlashcardReview => Boolean(review));
    return { cards, reviews };
  }

  /** The account has these; stop sending them unless they change again. */
  markSent(sent: { cards: ReadonlyArray<StoredFlashcard>; reviews: ReadonlyArray<FlashcardReview> }) {
    for (const card of sent.cards) if (this.cards.get(card.id)?.updatedAt === card.updatedAt) this.pending.cards.delete(card.id);
    for (const review of sent.reviews) this.pending.reviews.delete(review.id);
    return this.persist([], []);
  }

  /** Take in what other devices sent the account. A card only replaces an older version of itself. */
  applyRemote(remote: { cards?: ReadonlyArray<StoredFlashcard>; reviews?: ReadonlyArray<FlashcardReview> }) {
    const cards: StoredFlashcard[] = [], reviews: FlashcardReview[] = [];
    for (const card of remote.cards ?? []) {
      const local = this.cards.get(card.id);
      if (!local || newer(card, local)) { this.cards.set(card.id, card); cards.push(card); this.pending.cards.delete(card.id); }
    }
    for (const review of remote.reviews ?? []) {
      if (!this.reviews.has(review.id)) { this.reviews.set(review.id, review); reviews.push(review); }
    }
    if (!cards.length && !reviews.length) return;
    this.emit();
    void this.persist(cards, reviews);
  }

  /** Remove everything on this device (tests and account sign-out). */
  async clear() {
    this.cards.clear(); this.reviews.clear(); this.pending = { cards: new Set(), reviews: new Set() };
    this.emit();
    if (!this.db) return;
    const tx = this.db.transaction([...STORES], "readwrite");
    for (const store of STORES) tx.objectStore(store).clear();
    await transactionDone(tx);
  }
}
