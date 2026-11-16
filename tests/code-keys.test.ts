import { describe, expect, test } from "bun:test";
import { codeKeyRows, codeWordInsert } from "../client/src/lib/codeKeys";

describe("programming keys above the phone keyboard", () => {
  test("only a SQL block gets the word row", () => {
    expect(codeKeyRows("sql").words.slice(0, 6)).toEqual(["SELECT", "FROM", "WHERE", "JOIN", "GROUP BY", "ORDER BY"]);
    for (const language of ["java", "python", "javascript", "typescript", "html", "css"]) expect(codeKeyRows(language).words).toEqual([]);
  });

  test("each language leads with the symbols it uses most, with no repeats", () => {
    expect(codeKeyRows("java").symbols.slice(0, 7)).toEqual(["{", "}", "(", ")", ";", "=", "\""]);
    expect(codeKeyRows("python").symbols[0]).toBe(":");
    expect(codeKeyRows("sql").symbols.slice(0, 2)).toEqual(["*", ","]);
    for (const language of ["sql", "java", "python", "javascript", "typescript", "html", "css", "unknown"]) {
      const { symbols } = codeKeyRows(language);
      expect(new Set(symbols).size).toBe(symbols.length);
      expect(symbols.length).toBeGreaterThan(8);
    }
  });

  test("a word key spaces itself from the text before the caret", () => {
    expect(codeWordInsert("SELECT", "")).toBe("SELECT ");
    expect(codeWordInsert("FROM", "*")).toBe(" FROM ");
    expect(codeWordInsert("FROM", " ")).toBe("FROM ");
    expect(codeWordInsert("COUNT", "(")).toBe("COUNT ");
    expect(codeWordInsert("WHERE", "\n")).toBe("WHERE ");
  });
});
