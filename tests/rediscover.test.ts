import { describe, expect, test } from "bun:test";
import { createEmptyState } from "../client/src/initialState";
import {
  applyRediscoverAnswer, dayNumber, parseRediscoverLog, pickRediscoverNote, plainText, rediscoverDueToday, serializeRediscoverLog,
  type RediscoverLog,
} from "../client/src/lib/rediscover";
import type { Conversation } from "../client/src/types";

const NOW = Date.parse("2026-11-21T12:00:00Z");
const TODAY = dayNumber(NOW);
const daysAgo = (days: number) => new Date(NOW - days * 86_400_000).toISOString();
const empty: RediscoverLog = { shown: 0, ignored: 0, notes: {} };

function doc(id: string, text: string, extra: Partial<Conversation> = {}): Conversation {
  const base = createEmptyState();
  const root = base.conversations[base.rootId];
  const at = extra.updatedAt ?? daysAgo(100);
  return {
    ...root, id, title: id, parentId: null, childIds: [], messages: [], updatedAt: at, kind: "note",
    document: { schemaVersion: 1, prompts: [], generations: [], blocks: [{ id: `${id}-b1`, kind: "markdown", content: text, createdAt: at, updatedAt: at }] },
    ...extra,
  } as Conversation;
}
const vault = (...docs: Conversation[]) => ({ conversations: Object.fromEntries(docs.map((d) => [d.id, d])) });
const LONG = "Pulsed weekly dosing seemed to spare mTORC2, which is where the glucose side effects come from.";

describe("Rediscover picker", () => {
  test("picks the older note that other notes link to, with a reason and an excerpt", () => {
    const pick = pickRediscoverNote({
      state: vault(
        doc("Rapamycin", LONG),
        doc("Plain", "A note nobody links to, with enough words of its own to count here."),
        doc("Hub A", `See [[Rapamycin]] for the dosing. ${LONG}`, { updatedAt: daysAgo(2) }),
        doc("Hub B", `Also [[Rapamycin|the rapamycin note]]. ${LONG}`, { updatedAt: daysAgo(2) }),
      ),
      opened: new Map(), log: empty, now: NOW,
    });
    expect(pick?.id).toBe("Rapamycin");
    expect(pick?.reasons[0]).toBe("2 notes link to it");
    expect(pick?.excerpt).toBe(LONG);
    expect(pick?.lastSeen).toBe("3 months ago");
  });

  test("skips notes seen recently, opened on this device, AI-only or imported text, stopped or not yet due", () => {
    const state = vault(
      doc("Fresh", LONG, { updatedAt: daysAgo(5) }),
      doc("Opened", LONG),
      doc("AI", LONG, { document: { schemaVersion: 1, prompts: [], generations: [], blocks: [{ id: "x", kind: "markdown", content: LONG, createdAt: daysAgo(100), updatedAt: daysAgo(100), authorship: "ai" }] } }),
      doc("Import", LONG, { document: { schemaVersion: 1, prompts: [], generations: [], blocks: [{ id: "y", kind: "markdown", content: LONG, createdAt: daysAgo(100), updatedAt: daysAgo(100), origin: { type: "import" } }] } }),
      doc("Stopped", LONG),
      doc("Later", LONG),
      doc("Active", LONG),
    );
    const log: RediscoverLog = { shown: 0, ignored: 0, notes: { Stopped: { due: Number.MAX_SAFE_INTEGER, gap: -1 }, Later: { due: TODAY + 3, gap: 30 } } };
    expect(pickRediscoverNote({ state, opened: new Map([["Opened", NOW - 86_400_000]]), log, now: NOW, skipIds: ["Active"] })).toBeNull();
  });

  test("a Markdown note not yet opened in the editor counts, without its heading", () => {
    const base = doc("Sleep log", "", { document: undefined, updatedAt: "1970-01-01T00:00:00.000Z" });
    const note = { ...base, notes: [{ id: "n", kind: "standalone", content: `# Sleep log\n\n${LONG}\n`, sourceMessageId: null, startOffset: null, endOffset: null, quote: null, createdAt: base.createdAt, updatedAt: base.updatedAt }] } as Conversation;
    const pick = pickRediscoverNote({ state: vault(note), log: empty, now: NOW });
    expect(pick).toMatchObject({ id: "Sleep log", excerpt: LONG, lastSeen: null, reasons: [] });
  });

  test("answers stretch or shorten the gap", () => {
    let log = applyRediscoverAnswer(empty, "a", "glad", TODAY);
    expect(log.notes.a).toEqual({ due: TODAY + 30, gap: 30 });
    log = applyRediscoverAnswer(log, "a", "glad", TODAY + 30);
    expect(log.notes.a).toEqual({ due: TODAY + 30 + 75, gap: 75 });
    log = applyRediscoverAnswer(log, "a", "notNow", TODAY + 105);
    expect(log.notes.a).toEqual({ due: TODAY + 119, gap: 75 });
    expect(applyRediscoverAnswer(log, "a", "stop", TODAY).notes.a.gap).toBe(-1);
  });

  test("one card a day, and fewer after three go unanswered", () => {
    expect(rediscoverDueToday({ ...empty, shown: TODAY }, TODAY)).toBe(false);
    expect(rediscoverDueToday({ ...empty, shown: TODAY - 1 }, TODAY)).toBe(true);
    let log: RediscoverLog = { ...empty, shown: TODAY - 1 };
    for (const id of ["a", "b", "c"]) log = applyRediscoverAnswer(log, id, "ignored", TODAY);
    expect(log.ignored).toBe(3);
    expect(rediscoverDueToday(log, TODAY)).toBe(false);
    expect(rediscoverDueToday(log, TODAY + 3)).toBe(true);
    expect(applyRediscoverAnswer(log, "d", "glad", TODAY).ignored).toBe(0);
  });

  test("the saved log round-trips and stays under the account's setting size", () => {
    let log: RediscoverLog = { shown: TODAY, ignored: 1, notes: {} };
    for (let i = 0; i < 200; i += 1) log = { ...log, notes: { ...log.notes, [`00000000-0000-4000-8000-${String(i).padStart(12, "0")}`]: { due: TODAY + i, gap: i % 7 === 0 ? -1 : 30 } } };
    const raw = serializeRediscoverLog(log);
    expect(raw.length).toBeLessThan(4000);
    const back = parseRediscoverLog(raw);
    expect(back.shown).toBe(TODAY);
    expect(Object.values(back.notes).filter((e) => e.gap < 0).length).toBe(29);
    expect(parseRediscoverLog("not json")).toEqual(empty);
  });

  test("excerpts read as plain words", () => {
    expect(plainText("## Heading\n- [x] **Bold** [[Note|alias]] and [link](https://x.y) `code`")).toBe("Heading Bold alias and link code");
  });
});
