import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import postcss from "postcss";
import { clearance } from "../client/src/lib/floatingHeader";

/**
 * Dialogs, menus and toasts share one stacking scale (styles.css :root). A view or panel that
 * picks a big number of its own can climb over a dialog: the delete confirmation once opened
 * behind a roadmap. These checks keep views under the scale and dialogs on it.
 */
const src = join(import.meta.dir, "../client/src");
const cssFiles = [...readdirSync(src).filter((name) => name.endsWith(".css")).map((name) => join(src, name)),
  ...readdirSync(join(src, "components")).filter((name) => name.endsWith(".css")).map((name) => join(src, "components", name))];

type ZRule = { file: string; selector: string; value: string };
const zRules: ZRule[] = cssFiles.flatMap((file) => {
  const found: ZRule[] = [];
  postcss.parse(readFileSync(file, "utf8")).walkDecls("z-index", (decl) => {
    const rule = decl.parent as postcss.Rule;
    found.push({ file: file.slice(src.length + 1), selector: rule.selector?.replace(/\s+/g, " ") ?? "", value: decl.value });
  });
  return found;
});

function token(name: string) {
  const match = readFileSync(join(src, "styles.css"), "utf8").match(new RegExp(`--${name}:\\s*(\\d+)`));
  return match ? Number(match[1]) : NaN;
}

describe("stacking scale", () => {
  test("dialogs sit under menus, then toasts, the tour and consent prompts", () => {
    const order = ["z-modal", "z-popover", "z-toast", "z-tour", "z-alert"].map(token);
    expect(order.every(Number.isFinite)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  test("no view or panel picks a number at or above the dialogs' layer", () => {
    // A file dropped anywhere and the dictation pill cover the whole app on purpose.
    const allowed = new Set([".vault-file-drop", ".dictation-mic, .dictation-pill"]);
    const floor = token("z-modal");
    const over = zRules.filter((rule) => /^\d+$/.test(rule.value) && Number(rule.value) >= floor && !allowed.has(rule.selector));
    expect(over.map((rule) => `${rule.file}: ${rule.selector} ${rule.value}`)).toEqual([]);
  });

  test("every dialog backdrop uses the dialogs' layer", () => {
    const backdrops = [".thread-dialog-backdrop", ".search-modal-backdrop", ".service-picker-backdrop", ".mermaid-viewer-backdrop",
      ".diagram-overlay", ".roadmap-picker", ".claims-backdrop", ".make-cards-backdrop", ".document-rename-backdrop",
      ".vault-search-backdrop", ".group-picker-backdrop", ".document-drawing-backdrop", ".mermaid-diagram-backdrop",
      ".notebook-customise-backdrop", ".math-equation-backdrop", ".flashcard-review"];
    for (const selector of backdrops) {
      const rules = zRules.filter((rule) => rule.selector === selector);
      expect(rules.length, selector).toBeGreaterThan(0);
      for (const rule of rules) expect(rule.value, `${rule.file}: ${selector}`).toBe("var(--z-modal)");
    }
  });
});

describe("floating header clearance", () => {
  const edges = { left: 52, right: 1340, bottom: 51 };
  const none = { left: 0, right: 0 };

  test("a centred page header far from the buttons needs nothing", () => {
    expect(clearance({ left: 340, right: 1100, top: 9 }, { left: 16, right: 16 }, edges)).toEqual(none);
  });

  test("a header reaching under the buttons widens its padding on that side only", () => {
    expect(clearance({ left: 0, right: 1440, top: 9 }, { left: 16, right: 16 }, edges)).toEqual({ left: 44, right: 92 });
    expect(clearance({ left: 300, right: 1400, top: 9 }, { left: 16, right: 16 }, edges)).toEqual({ left: 0, right: 52 });
  });

  test("a header below the buttons is left alone", () => {
    expect(clearance({ left: 0, right: 1440, top: 60 }, { left: 16, right: 16 }, edges)).toEqual(none);
  });
});
