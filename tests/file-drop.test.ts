import { describe, expect, test } from "bun:test";
import { carriesFiles, describeDroppedFolders, droppedFiles, dropsIntoDocument, handlesOwnFileDrop } from "../client/src/lib/fileDrop";

function file(name: string, type = "") {
  return new File([new Uint8Array(1)], name, { type });
}

function item(type: string, isDirectory = false) {
  return { kind: "file", type, webkitGetAsEntry: () => ({ isDirectory }) } as unknown as DataTransferItem;
}

describe("dropping files on the app", () => {
  test("only drags from outside the app carry files", () => {
    expect(carriesFiles({ types: ["Files"] })).toBe(true);
    expect(carriesFiles({ types: ["application/x-margin-document"] })).toBe(false);
    expect(carriesFiles({ types: ["text/uri-list", "text/plain"] })).toBe(false);
    expect(carriesFiles(null)).toBe(false);
  });

  test("folders are left out and named", () => {
    const dropped = droppedFiles({
      files: [file("a.md"), file("Vault"), file("b.pdf", "application/pdf")] as unknown as FileList,
      items: [item(""), item("", true), item("application/pdf")] as unknown as DataTransferItemList,
    });
    expect(dropped.files.map((each) => each.name)).toEqual(["a.md", "b.pdf"]);
    expect(dropped.folders).toEqual(["Vault"]);
    expect(describeDroppedFolders(dropped.folders)).toBe("“Vault” is a folder, so it wasn’t added. Zip it first, or use Open folder as vault.");
    expect(describeDroppedFolders([])).toBe("");
  });

  test("files are kept when the browser lists no items", () => {
    const dropped = droppedFiles({ files: [file("a.md")] as unknown as FileList, items: [] as unknown as DataTransferItemList });
    expect(dropped.files).toHaveLength(1);
    expect(dropped.folders).toEqual([]);
  });

  test("dialogs, own drop boxes and pictures in a document keep their drops", () => {
    const fake = (selector: string) => ({
      closest: (query: string) => query.split(",").some((part) => part.trim() === selector) ? {} : null,
    }) as unknown as Element;
    expect(handlesOwnFileDrop(fake("[data-file-drop]"))).toBe(true);
    expect(handlesOwnFileDrop(fake("[aria-modal='true']"))).toBe(true);
    expect(handlesOwnFileDrop(fake(".sidebar"))).toBe(false);
    expect(dropsIntoDocument(fake(".ProseMirror"), ["image/png"])).toBe(true);
    expect(dropsIntoDocument(fake(".ProseMirror"), ["image/png", "application/pdf"])).toBe(false);
    expect(dropsIntoDocument(fake(".ProseMirror"), [])).toBe(false);
    expect(dropsIntoDocument(fake(".sidebar"), ["image/png"])).toBe(false);
  });
});
