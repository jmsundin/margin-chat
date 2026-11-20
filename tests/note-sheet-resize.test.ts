import { describe, expect, test } from "bun:test";
import { Window } from "happy-dom";

const browser = new Window({ url: "http://note-sheet-resize.test", width: 390, height: 844 });
for (const name of ["window", "document", "HTMLElement", "Element", "getComputedStyle"]) {
  const value = name === "window" ? browser : (browser as any)[name];
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: name === "getComputedStyle" ? value.bind(browser) : value });
}
const { noteSheetRest, keepsNoteOpen } = await import("../client/src/components/DocumentMargin");

describe("phone note sheet: where a dragged handle comes to rest", () => {
  const screen = 844;
  test("rests at the nearest of peek, half and full", () => {
    expect(noteSheetRest(screen * 0.33, screen)).toBe(0);
    expect(noteSheetRest(screen * 0.5, screen)).toBe(1);
    expect(noteSheetRest(screen * 0.85, screen)).toBe(2);
  });
  test("dragged right down, it closes", () => {
    expect(noteSheetRest(60, screen)).toBe("close");
  });
  test("a quick flick goes one stop in its direction", () => {
    expect(noteSheetRest(screen * 0.55, screen, 1.2)).toBe(2);
    expect(noteSheetRest(screen * 0.5, screen, -1.2)).toBe(0);
    expect(noteSheetRest(screen * 0.28, screen, -1.2)).toBe("close");
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
