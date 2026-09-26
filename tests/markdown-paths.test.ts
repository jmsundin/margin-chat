import { describe, expect, test } from "bun:test";
import { legacyMarkdownPath, titleMarkdownPath } from "../packages/workspace-contracts/markdownPaths.mjs";
import { isSafeMarkdownPath } from "../packages/workspace-contracts/markdown.mjs";
import { validVaultPath } from "../client/src/lib/vaultTypes";

const stem = (path: string) => path.slice(path.indexOf("/") + 1, path.lastIndexOf(" — "));
const folded = (path: string) => path.normalize("NFC").toLowerCase();
const encoder = new TextEncoder();

describe("readable portable Markdown paths", () => {
  test("retains readable Unicode, spaces, and emoji while normalizing composed titles", () => {
    const title = "Cafe\u0301 東京 — launch 👩🏽‍💻";
    const path = titleMarkdownPath("Notes", title, "unicode-id");
    expect(stem(path)).toBe("Café 東京 — launch 👩🏽‍💻");
    expect(path).toBe(titleMarkdownPath("Notes", title.normalize("NFC"), "unicode-id"));
    expect(isSafeMarkdownPath(path)).toBe(true);
    expect(validVaultPath(path)).toBe(true);
  });

  test("sanitizes path, filesystem, wiki-link, and control characters without creating directories", () => {
    const path = titleMarkdownPath("Chats", '  ../Plan\\A/B: "test" * ? <tag> | [link] #anchor ^block\u0000\u007f\u0085 .  ', "hostile-id");
    expect(stem(path)).toBe("Plan A B test tag link anchor block");
    expect(path.split("/")).toHaveLength(2);
    expect(isSafeMarkdownPath(path)).toBe(true);
    expect(validVaultPath(path)).toBe(true);
    expect(stem(titleMarkdownPath("Notes", "\ud800 valid \udfff", "id"))).toBe("valid");
  });

  test.each(["", "  \t\n", ".", "..", "...", '/\\:*?"<>|[]#^'])("uses Untitled for an empty sanitized title: %j", (title) => {
    expect(stem(titleMarkdownPath("Notes", title, "empty-id"))).toBe("Untitled");
  });

  test.each(["CON", "con.txt", "PRN", "AUX", "NUL", "COM1", "lpt9", "COM¹", "LPT².md"])("protects reserved device basename %s", (title) => {
    expect(stem(titleMarkdownPath("Chats", title, "reserved-id"))).toBe(`_${title}`);
  });

  test("does not unnecessarily modify ordinary words or numeric device-like names", () => {
    for (const title of ["Console", "Auxiliary", "COM0", "LPT10", "Résumé", "Plan.md"]) {
      expect(stem(titleMarkdownPath("Chats", title, "id"))).toBe(title);
    }
  });

  test("identical and casefold-equivalent titles for different IDs have different portable paths", () => {
    const paths = [
      titleMarkdownPath("Notes", "Shared plan", "local-device-document"),
      titleMarkdownPath("Notes", "Shared plan", "remote-device-document"),
      titleMarkdownPath("Notes", "SHARED PLAN", "third-document"),
      titleMarkdownPath("Notes", "shared plan", "fourth-document"),
    ];
    expect(new Set(paths.map(folded)).size).toBe(4);
    expect(new Set([titleMarkdownPath("Notes", "Café", "first"), titleMarkdownPath("Notes", "Cafe\u0301", "second")].map(folded)).size).toBe(2);
  });

  test("distinct opaque IDs stay distinct even when their old slug characters would be stripped", () => {
    const ids = ["A B", "A/B", "A\\B", "東京", "京都", "💡", "🧠", "é", "e\u0301", "id\u0000x", "idx"];
    expect(new Set(ids.map((id) => folded(titleMarkdownPath("Notes", "Same title", id)))).size).toBe(ids.length);
  });

  test.each(["x".repeat(10_000), "東京".repeat(1000), "😀".repeat(1000), "a".repeat(170) + "😀. ".repeat(20)])("limits the entire filename to 200 UTF-8 bytes without broken surrogate pairs", (title) => {
    const path = titleMarkdownPath("Chats", title, "long-name-id");
    const filename = path.slice(path.indexOf("/") + 1);
    expect(encoder.encode(filename).length).toBeLessThanOrEqual(200);
    expect(stem(path)).not.toMatch(/[. ]$/);
    expect(filename).not.toMatch(/[\ud800-\udfff]/u);
    expect(isSafeMarkdownPath(path)).toBe(true);
    expect(validVaultPath(path)).toBe(true);
  });

  test("is deterministic and retains the same suffix through title and folder changes", () => {
    const initial = titleMarkdownPath("Chats", "Original title", "stable-identity");
    expect(initial).toBe("Chats/Original title — 8nkq0-ec4f4a.md");
    expect(titleMarkdownPath("Chats", "Original title", "stable-identity")).toBe(initial);
    const suffix = initial.slice(initial.lastIndexOf(" — "));
    expect(titleMarkdownPath("Chats", "New title", "stable-identity").endsWith(suffix)).toBe(true);
    expect(titleMarkdownPath("Notes", "New title", "stable-identity").endsWith(suffix)).toBe(true);
    expect(suffix).toMatch(/^ — [a-z0-9]{1,7}-[a-z0-9]{1,7}\.md$/);
  });
});

describe("legacy Markdown path recognition", () => {
  function originalPath(folder: "Chats" | "Notes", id: string) {
    const slug = id.normalize("NFKD").replace(/[^a-z0-9._-]+/gi, "-").replace(/^-+|-+$/g, "").slice(0, 96) || "item";
    let hash = 2166136261;
    for (let index = 0; index < id.length; index++) { hash ^= id.charCodeAt(index); hash = Math.imul(hash, 16777619); }
    return `${folder}/${folder === "Notes" ? "note" : "chat"}-${slug}-${(hash >>> 0).toString(36)}.md`;
  }
  test("exactly matches the prior codec for existing IDs including Unicode and truncation", () => {
    for (const folder of ["Chats", "Notes"] as const) {
      for (const id of ["", "chat-123", "a/b\\c", "Café", "Cafe\u0301", "東京", "💡", "---", "...", "a".repeat(100) + "suffix", "a\u0000b", "\ud800"]) {
        expect(legacyMarkdownPath(folder, id)).toBe(originalPath(folder, id));
      }
    }
    expect(legacyMarkdownPath("Chats", "chat-123")).toBe("Chats/chat-chat-123-1to5mh2.md");
  });
});
