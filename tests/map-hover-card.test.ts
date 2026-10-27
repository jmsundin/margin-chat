import { describe, expect, test } from "bun:test";
import { createMapHoverIntent, MAP_HOVER_REST_MS, MAP_HOVER_WARM_MS, mapHoverSnippet, placeMapHoverCard, type MapHoverIntentTimers } from "../client/src/lib/mapHoverCard";

function fakeClock() {
  let now = 0, next = 1;
  const pending = new Map<number, { at: number; run: () => void }>();
  const timers: MapHoverIntentTimers = {
    now: () => now,
    setTimeout: (run, ms) => { pending.set(next, { at: now + ms, run }); return next++; },
    clearTimeout: (handle) => { pending.delete(handle); },
  };
  const advance = (ms: number) => {
    now += ms;
    for (const [handle, timer] of [...pending].sort((a, b) => a[1].at - b[1].at)) {
      if (timer.at <= now) { pending.delete(handle); timer.run(); }
    }
  };
  return { timers, advance };
}

function intent() {
  const clock = fakeClock(), shown: (string | null)[] = [];
  const hover = createMapHoverIntent((id) => shown.push(id), clock.timers);
  return { hover, shown, advance: clock.advance, current: () => shown.at(-1) ?? null };
}

describe("map hover card timing", () => {
  test("a pointer that rests on a circle opens its card after the wait", () => {
    const { hover, advance, current } = intent();
    hover.move("a", 10, 10);
    advance(MAP_HOVER_REST_MS - 1);
    expect(current()).toBeNull();
    advance(1);
    expect(current()).toBe("a");
  });

  test("sweeping across circles opens nothing", () => {
    const { hover, advance, shown } = intent();
    for (const id of ["a", "b", "c", "d"]) {
      hover.move(id, 0, 0);
      advance(80);
      hover.leave(id);
    }
    advance(1000);
    expect(shown).toEqual([]);
  });

  test("moving on a circle restarts the wait, but a small drift does not", () => {
    const { hover, advance, current } = intent();
    hover.move("a", 0, 0);
    advance(200);
    hover.move("a", 2, 1);
    advance(100);
    expect(current()).toBe("a");

    const second = intent();
    second.hover.move("a", 0, 0);
    second.advance(200);
    second.hover.move("a", 30, 0);
    second.advance(200);
    expect(second.current()).toBeNull();
    second.advance(100);
    expect(second.current()).toBe("a");
  });

  test("once a card is open, the next circle's card opens at once", () => {
    const { hover, advance, current } = intent();
    hover.move("a", 0, 0);
    advance(MAP_HOVER_REST_MS);
    hover.leave("a");
    expect(current()).toBeNull();
    advance(150);
    hover.move("b", 50, 0);
    expect(current()).toBe("b");
  });

  test("after a moment off every circle the wait comes back", () => {
    const { hover, advance, current } = intent();
    hover.move("a", 0, 0);
    advance(MAP_HOVER_REST_MS);
    hover.leave("a");
    advance(MAP_HOVER_WARM_MS);
    hover.move("b", 50, 0);
    expect(current()).toBeNull();
    advance(MAP_HOVER_REST_MS);
    expect(current()).toBe("b");
  });

  test("a press closes the card and starts cold", () => {
    const { hover, advance, current } = intent();
    hover.move("a", 0, 0);
    advance(MAP_HOVER_REST_MS);
    hover.cancel();
    expect(current()).toBeNull();
    hover.move("b", 50, 0);
    expect(current()).toBeNull();
  });

  test("leaving a circle before the wait ends opens nothing", () => {
    const { hover, advance, shown } = intent();
    hover.move("a", 0, 0);
    advance(200);
    hover.leave("a");
    advance(500);
    expect(shown).toEqual([]);
  });
});

describe("map hover snippet", () => {
  test("drops front matter, heading marks, code and Markdown", () => {
    const markdown = "---\ntags: [x]\n---\n# Rapamycin in old mice\n\nA **2009** study of [[mTOR]] found\n\n```js\nconst x = 1;\n```\n- lifespan grew by *14%*";
    expect(mapHoverSnippet(markdown)).toBe("Rapamycin in old mice A 2009 study of mTOR found lifespan grew by 14%");
  });

  test("long text is cut at a word with an ellipsis", () => {
    const snippet = mapHoverSnippet("word ".repeat(100), 40);
    expect(snippet.length).toBeLessThanOrEqual(41);
    expect(snippet.endsWith("word…")).toBe(true);
  });

  test("an empty document has no snippet", () => {
    expect(mapHoverSnippet("\n\n# \n")).toBe("");
  });
});

describe("map hover card placement", () => {
  const view = { width: 1000, height: 700 }, card = { width: 260, height: 150 };
  const anchor = { x0: 400, y0: 300, x1: 420, y1: 320 };

  test("goes right of the circle when that side is clear", () => {
    const placement = placeMapHoverCard(anchor, card, view, []);
    expect(placement.side).toBe("right");
    expect(placement.left).toBe(432);
  });

  test("moves to a clear side instead of covering a neighbor", () => {
    const neighbor = { x0: 470, y0: 300, x1: 490, y1: 320 };
    expect(placeMapHoverCard(anchor, card, view, [neighbor]).side).toBe("left");
  });

  test("stays inside the map near its right edge", () => {
    const placement = placeMapHoverCard({ x0: 960, y0: 300, x1: 980, y1: 320 }, card, view, []);
    expect(placement.side).toBe("left");
    expect(placement.left + card.width).toBeLessThanOrEqual(view.width);
  });
});
