import { describe, expect, test } from "bun:test";
import { DEFAULT_NOTEBOOK_PREFS, parseNotebookPrefs } from "../client/src/lib/notebookPrefs";

describe("notebook prefs", () => {
  test("defaults to thinking with you, notes as bubbles", () => {
    expect(parseNotebookPrefs(null)).toEqual(DEFAULT_NOTEBOOK_PREFS);
    expect(DEFAULT_NOTEBOOK_PREFS).toEqual({ aiBehaviour: "thinks", marginMode: "bubbles", proactive: false, stance: "supportive" });
  });

  test("reads saved choices", () => {
    expect(parseNotebookPrefs(JSON.stringify({ aiBehaviour: "asks", marginMode: "full", proactive: true, stance: "antagonistic" }))).toEqual({ aiBehaviour: "asks", marginMode: "full", proactive: true, stance: "antagonistic" });
  });

  test("settings saved before bubbles start from the narrow margin", () => {
    expect(parseNotebookPrefs(JSON.stringify({ marginMode: "right" })).marginMode).toBe("bubbles");
    expect(parseNotebookPrefs(JSON.stringify({ marginMode: "marks" })).marginMode).toBe("bubbles");
  });

  test("ignores broken or unknown values", () => {
    expect(parseNotebookPrefs("{not json")).toEqual(DEFAULT_NOTEBOOK_PREFS);
    expect(parseNotebookPrefs("null")).toEqual(DEFAULT_NOTEBOOK_PREFS);
    expect(parseNotebookPrefs(JSON.stringify({ aiBehaviour: "loud", marginMode: "left", proactive: "yes", stance: "rude" }))).toEqual(DEFAULT_NOTEBOOK_PREFS);
  });
});
