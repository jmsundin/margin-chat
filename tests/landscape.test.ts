import { describe, expect, test } from "bun:test";
import { alignTo, createLandscapeService, layoutLandscape, LANDSCAPE_SPACING, placeBesideNeighbours } from "../server/documents/landscape.mjs";

/** Three subjects of eight documents, each document near the rest of its subject. */
function vault() {
  const lists = new Map<string, { id: string; similarity: number }[]>();
  for (const subject of ["bread", "rust", "aging"]) for (let index = 0; index < 8; index++) {
    const id = `${subject}-${index}`;
    lists.set(id, Array.from({ length: 8 }, (_, other) => other).filter((other) => other !== index)
      .map((other) => ({ id: `${subject}-${other}`, similarity: 0.8 })));
  }
  // One weak bridge between two subjects.
  lists.get("bread-0")!.push({ id: "rust-0", similarity: 0.25 });
  return lists;
}
const subjectOf = (id: string) => id.split("-")[0];
const distance = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);

describe("landscape layout", () => {
  test("documents of one subject sit together and each subject is its own region", () => {
    const { positions, regions } = layoutLandscape({ neighbours: vault() });
    expect(positions.size).toBe(24);
    expect(regions).toBe(3);
    const ids = [...positions.keys()];
    let same = 0, sameCount = 0, other = 0, otherCount = 0;
    for (const a of ids) for (const b of ids) {
      if (a >= b) continue;
      const d = distance(positions.get(a)!, positions.get(b)!);
      if (subjectOf(a) === subjectOf(b)) { same += d; sameCount++; } else { other += d; otherCount++; }
    }
    expect(same / sameCount).toBeLessThan(other / otherCount / 2);
    for (const subject of ["bread", "rust", "aging"]) {
      expect(new Set(ids.filter((id) => subjectOf(id) === subject).map((id) => positions.get(id)!.region)).size).toBe(1);
    }
  });

  test("is the same every time for the same vault", () => {
    expect([...layoutLandscape({ neighbours: vault() }).positions]).toEqual([...layoutLandscape({ neighbours: vault() }).positions]);
  });

  test("a second layout starts from the first and stays close to it", () => {
    const first = layoutLandscape({ neighbours: vault() }).positions;
    const lists = vault();
    lists.set("aging-8", [{ id: "aging-1", similarity: 0.8 }, { id: "aging-2", similarity: 0.7 }]);
    const second = layoutLandscape({ neighbours: lists, previous: first }).positions;
    const moved = [...first.keys()].map((id) => distance(first.get(id)!, second.get(id)!)).sort((a, b) => a - b);
    expect(moved[Math.floor(moved.length / 2)]).toBeLessThan(LANDSCAPE_SPACING * 2);
    expect(distance(second.get("aging-8")!, second.get("aging-1")!)).toBeLessThan(distance(second.get("aging-8")!, second.get("bread-1")!));
  });

  test("turning back onto the previous layout undoes a rotation", () => {
    const targets = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 0, y: 50 }, { x: 30, y: 30 }];
    const rotated = targets.map(({ x, y }) => ({ x: -y + 7, y: x - 3 }));
    const turn = alignTo(rotated, targets);
    rotated.forEach((point, index) => {
      const back = turn(point);
      expect(back.x).toBeCloseTo(targets[index].x, 6);
      expect(back.y).toBeCloseTo(targets[index].y, 6);
    });
  });

  test("a new document is placed beside its neighbours, in their region", () => {
    const positions = new Map([["a", { x: 0, y: 0, region: 2 }], ["b", { x: 1000, y: 0, region: 2 }], ["c", { x: 0, y: 9000, region: 5 }]]);
    const at = placeBesideNeighbours("new", [{ id: "a", similarity: 0.9 }, { id: "b", similarity: 0.9 }, { id: "gone", similarity: 1 }], positions)!;
    expect(at.region).toBe(2);
    expect(Math.abs(at.x - 500)).toBeLessThan(LANDSCAPE_SPACING);
    expect(Math.abs(at.y)).toBeLessThan(LANDSCAPE_SPACING);
    expect(placeBesideNeighbours("lost", [{ id: "gone", similarity: 1 }], positions)).toBeNull();
  });
});

describe("landscape service", () => {
  function memoryDatabase(lists: Map<string, { id: string; similarity: number }[]>) {
    let stored = { positions: [] as { id: string; x: number; y: number; region: number }[], regions: 0, computedAt: null as string | null };
    let writes = 0;
    return {
      get writes() { return writes; },
      readTopicNeighbours: async () => ({ neighbours: [...lists].map(([id, neighbours]) => ({ id, neighbours })), cursor: null }),
      readLandscape: async () => stored,
      writeLandscape: async ({ positions, regions }: { positions: typeof stored.positions; regions: number }) => {
        writes++; stored = { positions, regions, computedAt: new Date(clock).toISOString() };
      },
    };
  }
  let clock = Date.parse("2026-10-31T12:00:00Z");

  test("asks for a layout when there is none, lays out once, then places new documents without a new layout", async () => {
    const lists = vault();
    const database = memoryDatabase(lists);
    const service = createLandscapeService({ database, now: () => clock });
    expect((await service.read({ userId: "u" })).stale).toBe(true);
    const laid = await service.relayout({ userId: "u" });
    expect(laid.positions).toHaveLength(24);
    expect(laid.stale).toBe(false);
    expect(laid.regions).toBe(3);

    lists.set("aging-8", [{ id: "aging-1", similarity: 0.8 }]);
    const read = await service.read({ userId: "u" });
    expect(read.positions).toHaveLength(25);
    expect(read.unplaced).toBe(1);
    expect(read.stale).toBe(false);

    // A second layout within ten minutes is refused.
    await service.relayout({ userId: "u" });
    expect(database.writes).toBe(1);
  });

  test("documents removed from the vault leave the landscape", async () => {
    const lists = vault();
    const database = memoryDatabase(lists);
    const service = createLandscapeService({ database, now: () => clock });
    await service.relayout({ userId: "u" });
    for (let index = 0; index < 8; index++) lists.delete(`rust-${index}`);
    clock += 60 * 60 * 1000;
    const read = await service.read({ userId: "u" });
    expect(read.positions).toHaveLength(16);
    expect(read.stale).toBe(true);
  });
});
