import { describe, expect, test } from "bun:test";
import { zipSync } from "fflate";
import { describeVaultUpload, planVaultUpload } from "../client/src/lib/vaultUpload";

const text = (value: string) => new TextEncoder().encode(value);
const upload = (name: string, bytes: Uint8Array, lastModified = 0) => ({ name, bytes, lastModified });

describe("planVaultUpload", () => {
  test("adds notes and text files as Markdown with their own date, numbering names already taken", () => {
    const plan = planVaultUpload([
      upload("Ideas.md", text("# Ideas"), Date.UTC(2026, 9, 1)),
      upload("Groceries.txt", text("milk")),
    ], ["ideas.md"]);
    expect(Object.keys(plan.files).sort()).toEqual(["Groceries.md", "Ideas 2.md"]);
    expect(plan.files["Ideas 2.md"]).toEqual({ content: "# Ideas" });
    expect(plan.createdAtByPath).toEqual({ "Ideas 2.md": "2026-10-01T00:00:00.000Z" });
    expect(plan.added).toEqual(["Ideas.md", "Groceries.txt"]);
  });

  test("adds PDFs and photos as files, and names what it leaves out", () => {
    const plan = planVaultUpload([
      upload("Paper.pdf", text("%PDF-1.7")),
      upload("IMG_0001.JPG", new Uint8Array([1, 2, 3])),
      upload("Huge.pdf", new Uint8Array(4 * 1024 * 1024 + 1)),
      upload("Song.mp3", new Uint8Array([1])),
      upload("Broken.md", new Uint8Array([0xff, 0xfe, 0xfd])),
    ], []);
    expect(plan.files["Paper.pdf"]).toMatchObject({ encoding: "base64", contentType: "application/pdf" });
    expect(plan.files["IMG_0001.jpg"]).toMatchObject({ encoding: "base64", contentType: "image/jpeg" });
    expect(plan.skipped.map((item) => item.name)).toEqual(["Huge.pdf", "Song.mp3", "Broken.md"]);
    expect(describeVaultUpload(plan)).toBe("Added 2 files to your vault. Not added: “Huge.pdf” is larger than 4 MB, the most a vault file can sync; "
      + "“Song.mp3” isn’t a note, PDF, image or zip; “Broken.md” isn’t readable text.");
  });

  test("unpacks a zipped phone folder at the top of the vault without Mac junk", () => {
    const zip = zipSync({
      "My Vault/Note.md": text("hello"),
      "My Vault/Sub/Deep.md": text("deep"),
      "__MACOSX/My Vault/._Note.md": new Uint8Array([0xff, 0xfe]),
      "My Vault/.DS_Store": new Uint8Array([0]),
    });
    const plan = planVaultUpload([upload("My Vault.zip", zip)], []);
    expect(Object.keys(plan.files).sort()).toEqual(["Note.md", "Sub/Deep.md"]);
    expect(describeVaultUpload(plan)).toBe("Added “My Vault.zip” to your vault.");
  });
});
