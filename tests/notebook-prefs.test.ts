import { describe, expect, test } from "bun:test";
import { DEFAULT_NOTEBOOK_PREFS, parseNotebookPrefs } from "../client/src/lib/notebookPrefs";

describe("notebook prefs", () => {
  test("defaults to thinking with you in the right margin", () => {
    expect(parseNotebookPrefs(null)).toEqual(DEFAULT_NOTEBOOK_PREFS);
    expect(DEFAULT_NOTEBOOK_PREFS).toEqual({ aiBehaviour: "thinks", marginMode: "right" });
  });

  test("reads saved choices", () => {
    expect(parseNotebookPrefs(JSON.stringify({ aiBehaviour: "asks", marginMode: "marks" }))).toEqual({ aiBehaviour: "asks", marginMode: "marks" });
  });

  test("ignores broken or unknown values", () => {
    expect(parseNotebookPrefs("{not json")).toEqual(DEFAULT_NOTEBOOK_PREFS);
    expect(parseNotebookPrefs("null")).toEqual(DEFAULT_NOTEBOOK_PREFS);
    expect(parseNotebookPrefs(JSON.stringify({ aiBehaviour: "loud", marginMode: "left" }))).toEqual(DEFAULT_NOTEBOOK_PREFS);
  });
});
