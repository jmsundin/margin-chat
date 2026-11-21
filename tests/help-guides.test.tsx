import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import HelpPanel from "../client/src/components/HelpPanel";
import { FEATURES } from "../client/src/lib/features";
import {
  HELP_CATEGORIES, HELP_GUIDES, POPULAR_GUIDE_IDS, getHelpGuide, guidesInCategory, searchHelpGuides,
} from "../client/src/lib/helpGuides";

describe("help guides", () => {
  test("every guide has a unique id, a known category and at least two steps", () => {
    const ids = HELP_GUIDES.map((guide) => guide.id);
    expect(new Set(ids).size).toBe(ids.length);
    const categories = new Set(HELP_CATEGORIES.map((category) => category.id));
    for (const guide of HELP_GUIDES) {
      expect(categories.has(guide.category)).toBe(true);
      expect(guide.steps.length).toBeGreaterThanOrEqual(2);
      expect(guide.summary.length).toBeGreaterThan(20);
      // Bold markers come in pairs, or the rest of the line renders bold.
      for (const text of [...guide.steps.map((step) => step.body), ...(guide.notes ?? []), ...(guide.before ?? [])]) {
        expect((text.match(/\*\*/g) ?? []).length % 2).toBe(0);
      }
    }
  });

  test("related and popular guides exist, and no guide points at itself", () => {
    for (const id of POPULAR_GUIDE_IDS) expect(getHelpGuide(id)).toBeDefined();
    for (const guide of HELP_GUIDES) {
      for (const related of guide.related ?? []) {
        expect(getHelpGuide(related)).toBeDefined();
        expect(related).not.toBe(guide.id);
      }
    }
  });

  test("every category has guides", () => {
    for (const category of HELP_CATEGORIES) expect(guidesInCategory(category.id).length).toBeGreaterThan(0);
  });

  test("a guide that needs a feature names it as Features does", () => {
    const names = FEATURES.map((feature) => feature.name);
    const cited = HELP_GUIDES.flatMap((guide) => guide.before ?? []).flatMap((line) => /\*\*(.+?)\*\* is turned on in Features/.exec(line)?.[1] ?? []);
    expect(cited.length).toBeGreaterThan(0);
    for (const name of cited) expect(names).toContain(name);
  });

  test("search matches word starts, ranks titles first and needs every word", () => {
    expect(searchHelpGuides("flash")[0].id).toBe("flashcards");
    expect(searchHelpGuides("obsidian").map((guide) => guide.id)).toContain("connect-folder");
    expect(searchHelpGuides("deleted")[0].id).toBe("recently-deleted");
    expect(searchHelpGuides("map zebra")).toEqual([]);
    expect(searchHelpGuides("   ")).toEqual([]);
  });
});

describe("help panel", () => {
  const render = (initialGuideId?: string, canRun?: () => boolean) =>
    renderToStaticMarkup(<HelpPanel initialGuideId={initialGuideId} onAction={() => {}} canRun={canRun} onClose={() => {}} />);

  test("opens on popular guides and topics with their counts", () => {
    const html = render();
    expect(html).toContain('aria-label="Help"');
    expect(html).toContain(`Search ${HELP_GUIDES.length} guides`);
    for (const id of POPULAR_GUIDE_IDS) expect(html).toContain(getHelpGuide(id)!.title);
    for (const category of HELP_CATEGORIES) expect(html).toContain(category.name.replace("&", "&amp;"));
  });

  test("a guide shows its steps in order, bold names and its button only when it can run", () => {
    const html = render("turn-on-features");
    expect(html).toContain("<h3>Steps</h3>");
    expect(html).toContain("<strong>Features</strong>");
    expect(html).not.toContain("**");
    expect(html).toContain("Open Features</button>");
    expect(render("turn-on-features", () => false)).not.toContain("Open Features</button>");
  });
});
