import { describe, expect, test } from "bun:test";
import { Window } from "happy-dom";

const browser = new Window({ url: "http://note-sheet-resize.test", width: 390, height: 844 });
for (const name of ["window", "document", "HTMLElement", "Element", "getComputedStyle"]) {
  const value = name === "window" ? browser : (browser as any)[name];
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: name === "getComputedStyle" ? value.bind(browser) : value });
}
const { noteSheetRest, keepsNoteOpen, NOTE_SHEET_MIN_PX } = await import("../client/src/components/DocumentMargin");

describe("phone note sheet: resizes to any height", () => {
  const screen = 844;
  test("stays wherever it is let go", () => {
    for (const share of [0.2, 0.37, 0.83]) {
      const rest = noteSheetRest(screen * share, screen);
      expect(rest !== "close" && rest.mode === "free" ? rest.share : -1).toBeCloseTo(share, 5);
    }
  });
  test("near the top it fills the screen", () => {
    expect(noteSheetRest(screen - 10, screen)).toEqual({ mode: "full" });
  });
  test("squeezed to its title it minimizes, below that it closes", () => {
    expect(noteSheetRest(NOTE_SHEET_MIN_PX + 10, screen)).toEqual({ mode: "min" });
    expect(noteSheetRest(40, screen)).toBe("close");
  });
});

describe("phone note sheet: taps that keep it open", () => {
  test("the Ask AI prompt over the keyboard keeps the note open, a tap on the page closes it", () => {
    const aside = document.createElement("aside");
    const composer = document.createElement("div");
    composer.setAttribute("data-mobile-composer", "");
    const prompt = document.createElement("textarea");
    composer.append(prompt);
    const page = document.createElement("p");
    document.body.append(aside, composer, page);
    expect(keepsNoteOpen(aside as any, prompt as any)).toBe(true);
    expect(keepsNoteOpen(aside as any, page as any)).toBe(false);
  });
});
