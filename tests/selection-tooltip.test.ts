import { describe, expect, test } from "bun:test";
import {
  getSelectionTooltipLayout,
  writeSelectedQuoteToClipboard,
} from "../client/src/lib/selectionTooltip";

describe("selected text popup positioning", () => {
  test("places the popup below the selected text", () => {
    const layout = getSelectionTooltipLayout({
      rect: { height: 36, left: 240, top: 180, width: 160 },
      tooltipHeight: 240,
      tooltipWidth: 360,
      viewportHeight: 800,
      viewportMargin: 16,
      viewportWidth: 1000,
    });

    expect(layout.top).toBe(228);
    expect(layout.maxHeight).toBe(556);
    expect(layout.placement).toBe("below");
  });

  test("places the popup above the last selected line when it cannot fit below", () => {
    const layout = getSelectionTooltipLayout({
      rect: { height: 22, left: 240, top: 700, width: 160 },
      tooltipHeight: 260,
      tooltipWidth: 360,
      viewportHeight: 800,
      viewportMargin: 16,
      viewportWidth: 1000,
    });

    expect(layout.top).toBe(428);
    expect(layout.maxHeight).toBe(672);
    expect(layout.placement).toBe("above");
  });

  test("keeps the popup horizontally inside the viewport", () => {
    expect(
      getSelectionTooltipLayout({
        rect: { height: 20, left: 4, top: 80, width: 40 },
        tooltipHeight: 240,
        tooltipWidth: 360,
        viewportHeight: 600,
        viewportMargin: 16,
        viewportWidth: 390,
      }).left,
    ).toBe(195);
  });
});

describe("selected text copying", () => {
  test("writes the saved quote when the original DOM selection is gone", () => {
    const copied: Record<string, string> = {};
    const handled = writeSelectedQuoteToClipboard({
      clipboardData: {
        setData(type, value) {
          copied[type] = value;
        },
      },
      isEditingText: false,
      quote: "The selected passage",
    });

    expect(handled).toBe(true);
    expect(copied["text/plain"]).toBe("The selected passage");
  });

  test("preserves native copying while editing the branch prompt", () => {
    let writeCount = 0;

    expect(
      writeSelectedQuoteToClipboard({
        clipboardData: {
          setData() {
            writeCount += 1;
          },
        },
        isEditingText: true,
        quote: "The selected passage",
      }),
    ).toBe(false);
    expect(writeCount).toBe(0);
  });
});
