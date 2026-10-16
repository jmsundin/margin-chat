import { afterEach, describe, expect, test } from "bun:test";
import { createEmptyState } from "../client/src/initialState";
import {
  addVaultFileDocuments, imageAreaFromSourceId, imageAreaQuote, imageAreaSourceId, isSyncableVaultFileSize, isVaultFileDocumentPath,
  pdfPageFromSourceId, pdfPageSourceId, pdfPageText, pdfTextForAI, vaultFileDocumentId, withoutUntouchedVaultFileDocuments,
} from "../client/src/lib/vaultFileDocuments";
import { stateToVaultFiles, vaultFileListings, vaultToState } from "../client/src/lib/vaultWorkspace";
import { nearestVaultFile } from "../client/src/lib/vaultFileContext";
import { getConversationRequestPayload } from "../client/src/lib/chatContext";
import { createMarginDocument } from "@margin-chat/workspace-contracts";
import {
  listConnectedDirectoryFiles, localDirectorySignature, readConnectedDirectoryCompanions, syncConnectedDirectoryCompanions,
} from "../client/src/lib/workspaceStorage";
import { createChatService } from "../server/chat/index.mjs";
import { validateVaultFileContext, vaultFileInstruction } from "../server/chat/fileContext.mjs";
import { anthropicBody } from "../server/chat/providers.mjs";
import type { AppState, Conversation } from "../client/src/types";
import type { VaultFile } from "../client/src/lib/vaultTypes";

const PDF = { content: "JVBERi0=", encoding: "base64" as const, contentType: "application/pdf" };
const PNG = { content: "iVBORw0=", encoding: "base64" as const, contentType: "image/png" };

function openVault(files: Record<string, VaultFile>) {
  return vaultToState(files, createEmptyState());
}

describe("PDFs and images open as documents", () => {
  test("each PDF and image outside Margin Chat's own folders gets a document with a stable ID", () => {
    expect(isVaultFileDocumentPath("Papers/Attention.pdf")).toBe(true);
    expect(isVaultFileDocumentPath("Diagram.PNG")).toBe(true);
    expect(isVaultFileDocumentPath("Attachments/Pasted image 1.png")).toBe(false);
    expect(isVaultFileDocumentPath(".obsidian/icon.png")).toBe(false);
    expect(isVaultFileDocumentPath("Notes/Plan.md")).toBe(false);
    const state = openVault({ "Papers/Attention.pdf": PDF, "Diagram.png": PNG, "Attachments/clip.png": PNG });
    const files = Object.values(state.conversations).filter((conversation) => conversation.vaultFile);
    expect(files.map((conversation) => [conversation.title, conversation.vaultFile]).sort()).toEqual([
      ["Attention.pdf", { path: "Papers/Attention.pdf", kind: "pdf" }],
      ["Diagram.png", { path: "Diagram.png", kind: "image" }],
    ]);
    expect(state.conversations[vaultFileDocumentId("Papers/Attention.pdf")]).toBeDefined();
    expect(vaultFileDocumentId("Papers/Attention.pdf")).toBe(vaultFileDocumentId("Papers/Attention.pdf"));
    expect(vaultFileDocumentId("Papers/Attention.pdf")).not.toBe(vaultFileDocumentId("Papers/attention.pdf"));
  });

  test("a file only in the cloud or only in the folder still lists, dated by the folder", () => {
    const listings = vaultFileListings({}, ["Scans/Receipt.jpg"], [{ path: "Books/Big.pdf", localOnly: true, size: 9_000_000, modifiedAt: "2026-10-01T10:00:00.000Z" }]);
    const state = addVaultFileDocuments(createEmptyState(), listings);
    expect(state.conversations[vaultFileDocumentId("Scans/Receipt.jpg")].vaultFile?.kind).toBe("image");
    expect(state.conversations[vaultFileDocumentId("Books/Big.pdf")].createdAt).toBe("2026-10-01T10:00:00.000Z");
  });

  test("an untouched file writes nothing; the first note saves a companion that reopens as the same document", () => {
    const files = { "Papers/Attention.pdf": PDF, "Reading list.md": { content: "# Reading list\n\nPapers to read.", contentType: "text/markdown; charset=utf-8" } };
    const opened = openVault(files);
    const id = vaultFileDocumentId("Papers/Attention.pdf");
    const unchanged = stateToVaultFiles(opened, files);
    expect(Object.keys(unchanged).filter((path) => path.endsWith(".md"))).toEqual(["Reading list.md"]);
    expect(unchanged["Papers/Attention.pdf"]).toEqual(PDF);

    const now = "2026-10-11T12:00:00.000Z";
    const document = opened.conversations[id];
    const edited: AppState = { ...opened, conversations: { ...opened.conversations, [id]: { ...document, updatedAt: now,
      document: { ...document.document!, blocks: [{ id: "block-1", kind: "markdown", content: "Key idea: self-attention.", createdAt: now, updatedAt: now, authorship: "user" }] } } } };
    const saved = stateToVaultFiles(edited, files);
    const companions = Object.keys(saved).filter((path) => path.endsWith(".md")).sort();
    expect(companions).toHaveLength(2);
    expect(companions[0]).toStartWith("Attention.pdf");
    expect(saved["Papers/Attention.pdf"]).toEqual(PDF);

    const reopened = openVault(saved);
    const files2 = Object.values(reopened.conversations).filter((conversation) => conversation.vaultFile);
    expect(files2).toHaveLength(1);
    expect(files2[0].id).toBe(id);
    expect(files2[0].vaultFile).toEqual({ path: "Papers/Attention.pdf", kind: "pdf" });
    expect(files2[0].document?.blocks.map((block) => block.content)).toEqual(["Key idea: self-attention."]);
  });

  test("a branch from a page keeps the file document saved and finds the file for AI", () => {
    const files = { "Papers/Attention.pdf": PDF };
    const opened = openVault(files);
    const id = vaultFileDocumentId("Papers/Attention.pdf");
    const now = "2026-10-11T12:00:00.000Z";
    const branch: Conversation = { id: "branch-1", kind: "chat", title: "Why multi-head?", parentId: id,
      serviceId: opened.defaultServiceId, modelId: opened.defaultModelId, childIds: [], messages: [], notes: [], documents: [],
      branchAnchor: { id: "anchor-1", sourceConversationId: id, sourceMessageId: pdfPageSourceId(4), startOffset: 10, endOffset: 30,
        quote: "multi-head attention", prompt: "Why multi-head?", createdAt: now }, createdAt: now, updatedAt: now };
    const state: AppState = { ...opened, conversations: { ...opened.conversations, [id]: { ...opened.conversations[id], childIds: ["branch-1"] }, "branch-1": branch } };
    expect(withoutUntouchedVaultFileDocuments(state).conversations[id]).toBeDefined();
    const saved = stateToVaultFiles(state, files);
    const reopened = openVault(saved);
    expect(reopened.conversations["branch-1"].parentId).toBe(id);
    expect(reopened.conversations["branch-1"].branchAnchor?.sourceMessageId).toBe("file:page:4");
    expect(nearestVaultFile(reopened.conversations, reopened.conversations["branch-1"])).toEqual({ file: { path: "Papers/Attention.pdf", kind: "pdf" }, page: 4 });
    // The file document is named in the branch's context even with no notes of its own.
    const payload = getConversationRequestPayload(reopened.conversations, reopened.conversations["branch-1"]);
    expect(payload.ancestorContext[0].messages[0].content).toBe("The PDF “Attention.pdf”.");
  });

  test("a margin note on a page or an area is anchored to it", () => {
    const opened = openVault({ "Papers/Attention.pdf": PDF, "Diagram.png": PNG });
    const pdf = opened.conversations[vaultFileDocumentId("Papers/Attention.pdf")];
    const note = createMarginDocument(pdf, { id: "note-1", content: "Check this", kind: "comment", sourceMessageId: pdfPageSourceId(2),
      startOffset: 5, endOffset: 12, quote: "encoder", createdAt: "2026-10-11T12:00:00.000Z", updatedAt: "2026-10-11T12:00:00.000Z" });
    expect(note.branchAnchor?.sourceMessageId).toBe("file:page:2");
    const image = opened.conversations[vaultFileDocumentId("Diagram.png")];
    const area = { x: 0.1, y: 0.2, width: 0.3, height: 0.25 };
    const quote = imageAreaQuote(area);
    const areaNote = createMarginDocument(image, { id: "note-2", content: "This box", kind: "comment", sourceMessageId: imageAreaSourceId(area),
      startOffset: 0, endOffset: quote.length, quote, createdAt: "2026-10-11T12:00:00.000Z", updatedAt: "2026-10-11T12:00:00.000Z" });
    expect(imageAreaFromSourceId(areaNote.branchAnchor?.sourceMessageId)).toEqual(area);
  });

  test("page text matches the text layer and labels pages for AI", () => {
    expect(pdfPageText([{ str: "Attention", hasEOL: false }, { str: " is", hasEOL: true }, { str: "all" }, {}])).toBe("Attention is\nall");
    expect(pdfTextForAI(["First page.", "  ", "Third page."])).toBe("[Page 1]\nFirst page.\n\n[Page 3]\nThird page.");
    expect(pdfPageFromSourceId("file:page:12")).toBe(12);
    expect(pdfPageFromSourceId("document:block-1")).toBeNull();
    expect(imageAreaFromSourceId("file:area:0,0,0,10")).toBeNull();
  });
});

function memoryDirectory(initial: Record<string, string | Uint8Array>) {
  const files = new Map(Object.entries(initial));
  function missing() { const error = new Error("Missing"); error.name = "NotFoundError"; return error; }
  function directory(prefix = ""): FileSystemDirectoryHandle {
    return {
      kind: "directory", name: prefix || "vault",
      async *entries() {
        const names = new Set([...files.keys()].filter((path) => path.startsWith(prefix)).map((path) => path.slice(prefix.length).split("/")[0]));
        for (const name of names) yield [name, files.has(prefix + name) ? fileHandle(prefix + name) : directory(`${prefix}${name}/`)];
      },
      async getDirectoryHandle(name: string, options?: { create?: boolean }) {
        if (!options?.create && ![...files.keys()].some((file) => file.startsWith(`${prefix}${name}/`))) throw missing();
        return directory(`${prefix}${name}/`);
      },
      async getFileHandle(name: string, options?: { create?: boolean }) {
        if (!files.has(prefix + name) && !options?.create) throw missing();
        return fileHandle(prefix + name);
      },
      async removeEntry(name: string) { if (!files.delete(prefix + name)) throw missing(); },
    } as unknown as FileSystemDirectoryHandle;
  }
  function fileHandle(path: string): FileSystemFileHandle {
    return {
      kind: "file", name: path.split("/").at(-1),
      async getFile() { if (!files.has(path)) throw missing(); return new File([files.get(path)!], path, { lastModified: 1_760_000_000_000 }); },
      async createWritable() {
        return { async write(content: string | ArrayBuffer) { files.set(path, typeof content === "string" ? content : new Uint8Array(content)); }, async close() {}, async abort() {} };
      },
    } as unknown as FileSystemFileHandle;
  }
  return { handle: directory(), files };
}

describe("a connected folder's PDFs and images", () => {
  test("sync byte for byte, large ones included", async () => {
    const big = new Uint8Array(5 * 1024 * 1024).fill(7);
    const folder = memoryDirectory({ "Note.md": "Hello.", "Papers/Small.pdf": new Uint8Array([37, 80, 68, 70]), "Pics/Cat.jpg": new Uint8Array([255, 216]),
      "Books/Big.pdf": big, ".obsidian/icon.png": new Uint8Array([1]), "Other/data.bin": new Uint8Array([2]) });
    const listing = await listConnectedDirectoryFiles(folder.handle);
    expect(listing.map((file) => [file.path, Boolean(file.localOnly)]).sort()).toEqual([["Books/Big.pdf", false], ["Papers/Small.pdf", false], ["Pics/Cat.jpg", false]]);
    const { files: companions, stats } = await readConnectedDirectoryCompanions(folder.handle, undefined, listing);
    expect(Object.keys(companions).sort()).toEqual(["Books/Big.pdf", "Papers/Small.pdf", "Pics/Cat.jpg"]);
    expect(companions["Papers/Small.pdf"]).toEqual({ content: "JVBERg==", encoding: "base64", contentType: "application/pdf" });
    expect(companions["Pics/Cat.jpg"].contentType).toBe("image/jpeg");
    expect(companions["Books/Big.pdf"].content.length).toBe(Math.ceil(big.length / 3) * 4);

    // A rescan reuses an unchanged large file instead of reading and encoding it again.
    const again = await readConnectedDirectoryCompanions(folder.handle, companions, await listConnectedDirectoryFiles(folder.handle), stats);
    expect(again.files["Books/Big.pdf"]).toBe(companions["Books/Big.pdf"]);

    // A PDF that arrives from another device is written into the folder; unchanged files aren't touched.
    const next = { ...companions, "Scans/Receipt.png": { content: "AQI=", encoding: "base64" as const, contentType: "image/png" } };
    await syncConnectedDirectoryCompanions(folder.handle, next, companions, stats);
    expect(folder.files.get("Scans/Receipt.png")).toEqual(new Uint8Array([1, 2]));
    expect(folder.files.get("Books/Big.pdf")).toBe(big);
  });

  test("only files over the sync limit stay in the folder", () => {
    expect(isSyncableVaultFileSize(300 * 1024 * 1024)).toBe(true);
    expect(isSyncableVaultFileSize(300 * 1024 * 1024 + 1)).toBe(false);
  });

  test("adding a PDF changes the folder signature, so it appears within seconds", async () => {
    const folder = memoryDirectory({ "Note.md": "Hello." });
    const before = await localDirectorySignature(folder.handle);
    folder.files.set("Papers/New.pdf", new Uint8Array([1]));
    expect(await localDirectorySignature(folder.handle)).not.toBe(before);
  });
});

describe("AI reads the file a conversation is about", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = originalFetch; });

  function payload(serviceId: string, modelId: string, file: object) {
    return {
      conversation: { ancestorContext: [], branchAnchor: null, id: "file-doc", parentId: null, title: "Attention.pdf", file },
      messages: [{ content: "What does page 2 say about heads?", role: "user" }],
      modelId, serviceId,
    };
  }

  function service() {
    return createChatService({
      autoRouter: async () => null, database: {},
      env: { OPENAI_API_KEY: "openai-test-key", HUGGINGFACE_API_KEY: "hf-test-key" },
      runtimeConfig: { defaultBackendProvider: "openai-api", openaiModel: "gpt-5.6", huggingFaceModel: "openai/gpt-oss-120b" },
    });
  }

  test("checks what the browser sends", () => {
    expect(validateVaultFileContext(undefined)).toBeNull();
    expect(() => validateVaultFileContext({ name: "x.pdf", kind: "doc" })).toThrow();
    expect(() => validateVaultFileContext({ name: "x.png", kind: "image", image: { mediaType: "image/bmp", data: "AAAA" } })).toThrow();
    expect(() => validateVaultFileContext({ name: "x.png", kind: "image", image: { mediaType: "image/png", data: "not base64!" } })).toThrow();
    expect(validateVaultFileContext({ name: "x.pdf", kind: "pdf", text: "[Page 1]\nHi", page: 1 })).toEqual({ name: "x.pdf", kind: "pdf", text: "[Page 1]\nHi", page: 1 });
  });

  test("a long PDF keeps the selected page and the pages that match the request", () => {
    const pages = Array.from({ length: 40 }, (_, index) => `[Page ${index + 1}]\n${index === 29 ? "Rotary embeddings explained." : "Filler text. ".repeat(250)}`).join("\n\n");
    const result = vaultFileInstruction({ name: "Book.pdf", kind: "pdf", text: pages, page: 7 }, { query: "What are rotary embeddings?", mode: "fast" })!;
    expect(result.instruction).toContain("[Page 7]");
    expect(result.instruction).toContain("[Page 30]\nRotary embeddings explained.");
    expect(result.instruction).toContain("Pages left out:");
    expect(result.truncated).toBe(true);
    expect(result.warnings[0]).toContain("of 40 pages");
  });

  test("a PDF's text reaches the model, and an image reaches models that can see", async () => {
    const bodies: any[] = [];
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return Response.json({ output_text: "OK", model: "gpt-5.6", choices: [{ message: { content: "OK" } }] });
    }) as typeof fetch;
    const chat = service();
    await chat.requestReply(payload("openai-api", "gpt-5.6", { name: "Attention.pdf", kind: "pdf", text: "[Page 1]\nIntro.\n\n[Page 2]\nEight heads." }));
    expect(bodies[0].instructions).toContain('The user is reading the PDF "Attention.pdf"');
    expect(bodies[0].instructions).toContain("[Page 2]\nEight heads.");

    await chat.requestReply(payload("openai-api", "gpt-5.6", { name: "Cat.png", kind: "image", image: { mediaType: "image/png", data: "iVBORw0=" } }));
    expect(bodies[1].input.at(-1).content).toEqual([
      { type: "input_image", image_url: "data:image/png;base64,iVBORw0=" },
      { type: "input_text", text: "What does page 2 say about heads?" },
    ]);

    const blind = await chat.requestReply(payload("huggingface-api", "openai/gpt-oss-120b", { name: "Cat.png", kind: "image", image: { mediaType: "image/png", data: "iVBORw0=" } }));
    expect(JSON.stringify(bodies[2])).not.toContain("iVBORw0=");
    expect(bodies[2].messages[0].content).toContain("you cannot see images");
    expect(blind.metadata.execution.warnings.some((warning: string) => warning.includes("can't see images"))).toBe(true);
  });

  test("Claude gets the image as a base64 block before the question", () => {
    const body = anthropicBody({ model: "claude-opus-5-5", systemInstruction: "", image: { mediaType: "image/jpeg", data: "/9j/" },
      chatRequest: { ai: { mode: "balanced" }, messages: [{ role: "user", content: "What is this?" }] } });
    expect(body.messages[0].content).toEqual([
      { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "/9j/" } },
      { type: "text", text: "What is this?" },
    ]);
  });
});
