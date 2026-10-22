import { describe, expect, test } from "bun:test";
import { zipSync } from "fflate";
import { describeVaultUpload, planVaultUpload } from "../client/src/lib/vaultUpload";
import { addVaultFileDocuments, vaultFileDocumentId, withAddedVaultFileDates } from "../client/src/lib/vaultFileDocuments";
import { sortByRecentlyViewed } from "../client/src/lib/sidebarDocumentOrder";
import { createEmptyState } from "../client/src/initialState";
import type { ThreadSummary } from "../client/src/types";

const text = (value: string) => new TextEncoder().encode(value);
const now = Date.UTC(2026, 9, 22, 17);
const upload = (name: string, bytes: Uint8Array, lastModified = 0) => ({ name, bytes, lastModified });

describe("planVaultUpload", () => {
  test("adds notes and text files as Markdown with their own date, numbering names already taken", () => {
    const plan = planVaultUpload([
      upload("Ideas.md", text("# Ideas"), Date.UTC(2026, 9, 1)),
      upload("Groceries.txt", text("milk")),
    ], ["ideas.md"], now);
    expect(Object.keys(plan.files).sort()).toEqual(["Groceries.md", "Ideas 2.md"]);
    expect(plan.files["Ideas 2.md"]).toEqual({ content: "# Ideas" });
    // A file without a date counts from the upload, never from 1970.
    expect(plan.createdAtByPath).toEqual({ "Ideas 2.md": "2026-10-01T00:00:00.000Z", "Groceries.md": "2026-10-22T17:00:00.000Z" });
    expect(plan.added).toEqual(["Ideas.md", "Groceries.txt"]);
  });

  test("adds PDFs and photos as files, and names what it leaves out", () => {
    const plan = planVaultUpload([
      upload("Paper.pdf", text("%PDF-1.7")),
      upload("IMG_0001.JPG", new Uint8Array([1, 2, 3])),
      upload("Huge.pdf", { length: 300 * 1024 * 1024 + 1 } as Uint8Array),
      upload("Song.mp3", new Uint8Array([1])),
      upload("Broken.md", new Uint8Array([0xff, 0xfe, 0xfd])),
    ], [], now);
    expect(plan.files["Paper.pdf"]).toMatchObject({ encoding: "base64", contentType: "application/pdf" });
    expect(plan.files["IMG_0001.jpg"]).toMatchObject({ encoding: "base64", contentType: "image/jpeg" });
    expect(plan.skipped.map((item) => item.name)).toEqual(["Huge.pdf", "Song.mp3", "Broken.md"]);
    expect(plan.createdAtByPath["Paper.pdf"]).toBe("2026-10-22T17:00:00.000Z");
    expect(describeVaultUpload(plan)).toBe("Added 2 files to your vault. Not added: “Huge.pdf” is larger than 300 MB, the most a vault file can sync; "
      + "“Song.mp3” isn’t a note, PDF, image or zip; “Broken.md” isn’t readable text.");
  });

  test("unpacks a zipped phone folder at the top of the vault without Mac junk", () => {
    const zip = zipSync({
      "My Vault/Note.md": text("hello"),
      "My Vault/Sub/Deep.md": text("deep"),
      "__MACOSX/My Vault/._Note.md": new Uint8Array([0xff, 0xfe]),
      "My Vault/.DS_Store": new Uint8Array([0]),
    });
    const plan = planVaultUpload([upload("My Vault.zip", zip)], [], now);
    expect(Object.keys(plan.files).sort()).toEqual(["Note.md", "Sub/Deep.md"]);
    expect(plan.createdAtByPath["Sub/Deep.md"]).toBe("2026-10-22T17:00:00.000Z");
    expect(describeVaultUpload(plan)).toBe("Added “My Vault.zip” to your vault.");
  });

  test("dates a file by the upload when its own date is in the future", () => {
    const plan = planVaultUpload([upload("Photo.png", new Uint8Array([1]), now + 86_400_000)], [], now);
    expect(plan.createdAtByPath).toEqual({ "Photo.png": "2026-10-22T17:00:00.000Z" });
  });
});

describe("uploaded file dates", () => {
  test("a PDF the cloud keeps no date for is dated from when this device added it", () => {
    const listings = withAddedVaultFileDates([{ path: "Paper.pdf" }, { path: "Old.png", modifiedAt: "2025-01-01T00:00:00.000Z" }],
      { "Paper.pdf": "2026-10-22T17:00:00.000Z", "Old.png": "2026-10-22T17:00:00.000Z" });
    expect(listings).toEqual([
      { path: "Paper.pdf", modifiedAt: "2026-10-22T17:00:00.000Z" },
      { path: "Old.png", modifiedAt: "2025-01-01T00:00:00.000Z" },
    ]);
    const state = addVaultFileDocuments(createEmptyState(), listings);
    expect(state.conversations[vaultFileDocumentId("Paper.pdf")]?.createdAt).toBe("2026-10-22T17:00:00.000Z");
  });

  test("a just-uploaded document leads Recently viewed", () => {
    const thread = (id: string, createdAt: string) => ({ id, title: id, createdAt, updatedAt: createdAt }) as ThreadSummary;
    const threads = [thread("opened-today", "2026-01-01T00:00:00.000Z"), thread("uploaded", "2020-01-01T00:00:00.000Z")];
    const opened = new Map([["opened-today", now - 60_000], ["uploaded", now]]);
    expect(sortByRecentlyViewed(threads, opened).map((item) => item.id)).toEqual(["uploaded", "opened-today"]);
  });
});
