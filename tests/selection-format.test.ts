import { describe, expect, test } from "bun:test";
import { applySelectionFormat, hasSelectionFormat } from "../client/src/lib/selectionFormat";

describe("formatting selected text", () => {
  test("wraps and unwraps inline marks", () => {
    const text = "Rapamycin extends lifespan in mice.";
    const bold = applySelectionFormat(text, 10, 26, "bold")!;
    expect(bold).toBe("Rapamycin **extends lifespan** in mice.");
    expect(hasSelectionFormat(bold, 12, 28, "bold")).toBe(true);
    expect(hasSelectionFormat(bold, 12, 28, "italic")).toBe(false);
    expect(applySelectionFormat(bold, 12, 28, "bold")).toBe(text);
    expect(applySelectionFormat(text, 0, 9, "code")).toBe("`Rapamycin` extends lifespan in mice.");
    expect(applySelectionFormat(text, 9, 10, "bold")).toBeNull();
    // A triple-click on a bold line selects its marks too.
    expect(hasSelectionFormat("**Bold line**", 0, 13, "bold")).toBe(true);
    expect(hasSelectionFormat("**Bold line**", 0, 13, "italic")).toBe(false);
    expect(applySelectionFormat("**Bold line**", 0, 13, "bold")).toBe("Bold line");
  });

  test("changes every line the selection touches, and toggles back to text", () => {
    const text = "Mice live longer\nPeople are unclear";
    const bullets = applySelectionFormat(text, 3, 22, "bullets")!;
    expect(bullets).toBe("- Mice live longer\n- People are unclear");
    expect(applySelectionFormat(bullets, 3, 24, "bullets")).toBe(text);
    expect(applySelectionFormat(bullets, 3, 24, "numbers")).toBe("1. Mice live longer\n2. People are unclear");
    expect(applySelectionFormat("## Old heading", 4, 8, "h1")).toBe("# Old heading");
    expect(applySelectionFormat("# Heading", 3, 6, "text")).toBe("Heading");
    expect(hasSelectionFormat("> quoted", 3, 5, "quote")).toBe(true);
  });
});
