import { describe, expect, test } from "bun:test";
import { currentPdfOutlineEntry, pdfDestinationTarget, readPdfOutline } from "../client/src/lib/pdfOutline";

const refs = [{ num: 10, gen: 0 }, { num: 20, gen: 0 }, { num: 30, gen: 0 }, { num: 40, gen: 0 }];
const named: Record<string, unknown[]> = { chapter2: [refs[2], { name: "XYZ" }, 0, 640, null] };

function fakePdf(outline: unknown[] | null) {
  return {
    numPages: refs.length,
    getOutline: async () => outline,
    getDestination: async (id: string) => named[id] ?? null,
    getPageIndex: async (ref: { num: number }) => {
      const index = refs.findIndex((item) => item.num === ref.num);
      if (index < 0) throw new Error("Invalid page reference");
      return index;
    },
  } as never;
}

const node = (title: string, dest: unknown, items: unknown[] = []) => ({ title, dest, items, bold: false, italic: false, url: null });

describe("PDF table of contents", () => {
  test("works out each entry's page and height, including named destinations", async () => {
    const outline = await readPdfOutline(fakePdf([
      node("Introduction", [refs[0], { name: "Fit" }]),
      node("Chapter 1", [refs[1], { name: "FitH" }, 500], [node("1.1 Basics", [refs[1], { name: "XYZ" }, 0, 300, 0])]),
      node("Chapter 2", "chapter2"),
      node("Website", null),
      node("Broken", [{ num: 99, gen: 0 }, { name: "Fit" }]),
      node("By index", [3, { name: "Fit" }]),
    ]));
    expect(outline.map((entry) => [entry.title, entry.page, entry.top])).toEqual([
      ["Introduction", 1, null], ["Chapter 1", 2, 500], ["Chapter 2", 3, 640], ["Website", null, null], ["Broken", null, null], ["By index", 4, null],
    ]);
    expect(outline[1].items[0]).toMatchObject({ id: "1.0", title: "1.1 Basics", page: 2, top: 300 });
  });

  test("a PDF without bookmarks has no contents", async () => {
    expect(await readPdfOutline(fakePdf(null))).toEqual([]);
    expect(await readPdfOutline(fakePdf([]))).toEqual([]);
  });

  test("ignores destinations past the last page", async () => {
    expect(await pdfDestinationTarget(fakePdf(null), [12, { name: "Fit" }])).toBeNull();
    expect(await pdfDestinationTarget(fakePdf(null), "missing")).toBeNull();
  });

  test("the current entry is the last one starting on or before the reader's page", async () => {
    const outline = await readPdfOutline(fakePdf([
      node("Introduction", [refs[0], { name: "Fit" }]),
      node("Chapter 1", [refs[1], { name: "Fit" }], [node("1.1", [refs[1], { name: "Fit" }]), node("1.2", [refs[2], { name: "Fit" }])]),
      node("Chapter 2", [refs[3], { name: "Fit" }]),
    ]));
    expect(currentPdfOutlineEntry(outline, 1)?.entry.title).toBe("Introduction");
    expect(currentPdfOutlineEntry(outline, 2)?.entry.title).toBe("1.1");
    const inSection = currentPdfOutlineEntry(outline, 3);
    expect(inSection?.entry.title).toBe("1.2");
    expect(inSection?.parents).toEqual(["1"]);
    expect(currentPdfOutlineEntry(outline, 4)?.entry.title).toBe("Chapter 2");
  });
});
