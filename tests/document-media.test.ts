import { describe, expect, test } from "bun:test";
import {
  addTimestamp, attachmentPath, embedMarkdownForUrl, formatTimestamp, linkSeconds, parseMediaBlock, parseMediaEmbed,
  parseTimestamp, parseTimestampLine, resolveVaultMediaPath, timestampMarkdown, vaultEmbedMarkdown,
} from "../client/src/lib/documentMedia";
import { createEmptyState } from "../client/src/initialState";
import { getEditableDocument } from "../client/src/lib/editableDocument";
import { stateToVaultFiles, vaultToState } from "../client/src/lib/vaultWorkspace";

describe("document media embeds", () => {
  test("Obsidian embeds name vault images, video and audio with optional size and start", () => {
    expect(parseMediaEmbed("![[Attachments/photo.png|300]]")).toEqual({ source: "vault", target: "Attachments/photo.png", kind: "image", alt: "", width: 300 });
    expect(parseMediaEmbed("![[lecture.mp4#t=1:30]]")).toMatchObject({ source: "vault", target: "lecture.mp4", kind: "video", startSeconds: 90 });
    expect(parseMediaEmbed("![[talk.m4a|Keynote]]")).toMatchObject({ kind: "audio", alt: "Keynote" });
    expect(parseMediaEmbed("![[Some note]]")).toBeNull();
    expect(parseMediaEmbed("Look: ![[photo.png]]")).toBeNull();
  });

  test("links embed images, files, YouTube and Vimeo", () => {
    expect(parseMediaEmbed("![A cat](https://example.com/cat.jpg)")).toMatchObject({ source: "url", kind: "image", alt: "A cat" });
    expect(parseMediaEmbed("![](https://example.com/clip.webm)")).toMatchObject({ kind: "video" });
    expect(parseMediaEmbed("![](https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=1m5s)")).toMatchObject({ kind: "youtube", videoId: "dQw4w9WgXcQ", startSeconds: 65 });
    expect(parseMediaEmbed("![](https://youtu.be/dQw4w9WgXcQ)")).toMatchObject({ kind: "youtube", videoId: "dQw4w9WgXcQ" });
    expect(parseMediaEmbed("![](https://vimeo.com/76979871)")).toMatchObject({ kind: "vimeo", videoId: "76979871" });
    expect(parseMediaEmbed("![](Attachments/My%20clip.mp4)")).toMatchObject({ source: "vault", target: "Attachments/My clip.mp4", kind: "video" });
    expect(parseMediaEmbed("![](javascript:alert(1))")).toBeNull();
    expect(embedMarkdownForUrl("https://youtu.be/dQw4w9WgXcQ")).toBe("![](https://youtu.be/dQw4w9WgXcQ)");
    expect(embedMarkdownForUrl("not a link")).toBeNull();
  });

  test("times read and write in the forms people type", () => {
    expect(parseTimestamp("83")).toBe(83);
    expect(parseTimestamp("1:23")).toBe(83);
    expect(parseTimestamp("1:02:03")).toBe(3723);
    expect(parseTimestamp("1m23s")).toBe(83);
    expect(parseTimestamp("1:75")).toBeNull();
    expect(formatTimestamp(83.9)).toBe("1:23");
    expect(formatTimestamp(3723)).toBe("1:02:03");
    expect(linkSeconds("https://www.youtube.com/watch?v=x&t=83s")).toBe(83);
    expect(linkSeconds("lecture.mp4#t=1:23")).toBe(83);
  });

  test("timestamp lines may be wikilinks, links or plain times", () => {
    expect(parseTimestampLine("- [[lecture.mp4#t=83|1:23]] The proof starts")).toEqual({ seconds: 83, label: "1:23", note: "The proof starts" });
    expect(parseTimestampLine("- [1:23](https://www.youtube.com/watch?v=x&t=83s) Demo")).toEqual({ seconds: 83, label: "1:23", note: "Demo" });
    expect(parseTimestampLine("* 12:05 - Questions")).toEqual({ seconds: 725, label: "12:05", note: "Questions" });
    expect(parseTimestampLine("- Just a note")).toBeNull();
  });

  test("a block is media only when every line after the embed is a timestamp", () => {
    const block = parseMediaBlock("![[lecture.mp4]]\n- [[lecture.mp4#t=83|1:23]] Intro\n- 2:00 Outline\n");
    expect(block?.embed.target).toBe("lecture.mp4");
    expect(block?.timestamps.map((timestamp) => timestamp.seconds)).toEqual([83, 120]);
    expect(parseMediaBlock("![[lecture.mp4]]\nSome paragraph")).toBeNull();
    expect(parseMediaBlock("![[photo.png]]\n- 1:00 not for images")).toBeNull();
    expect(parseMediaBlock("Intro\n![[photo.png]]")).toBeNull();
  });

  test("new timestamps are written in time order with links Obsidian follows", () => {
    const vault = parseMediaBlock("![[lecture.mp4]]")!.embed;
    expect(timestampMarkdown(vault, 83.4, "Intro")).toBe("- [[lecture.mp4#t=83|1:23]] Intro");
    const youtube = parseMediaBlock("![](https://youtu.be/dQw4w9WgXcQ)")!.embed;
    expect(timestampMarkdown(youtube, 65, "")).toBe("- [1:05](https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=65s)");
    const source = "![[lecture.mp4]]\n- [[lecture.mp4#t=10|0:10]] Start\n- [[lecture.mp4#t=300|5:00]] End\n";
    expect(addTimestamp(source, 120, "Middle")).toBe("![[lecture.mp4]]\n- [[lecture.mp4#t=10|0:10]] Start\n- [[lecture.mp4#t=120|2:00]] Middle\n- [[lecture.mp4#t=300|5:00]] End\n");
    expect(addTimestamp("![[lecture.mp4]]", 5, "First")).toBe("![[lecture.mp4]]\n- [[lecture.mp4#t=5|0:05]] First");
  });

  test("vault files resolve by path, then by name, and new attachments never collide", () => {
    const paths = ["Attachments/photo.png", "Trips/2025/photo.png", "Notes/clip.MP4", "Long/folder/clip.mp4"];
    expect(resolveVaultMediaPath("Trips/2025/photo.png", paths)).toBe("Trips/2025/photo.png");
    expect(resolveVaultMediaPath("photo.png", paths)).toBe("Attachments/photo.png");
    expect(resolveVaultMediaPath("clip.mp4", paths)).toBe("Notes/clip.MP4");
    expect(resolveVaultMediaPath("missing.png", paths)).toBeNull();
    const now = new Date(2026, 9, 8, 20, 49, 53);
    expect(attachmentPath({ name: "image.png", type: "image/png" }, [], now)).toBe("Attachments/Pasted image 20261008204953.png");
    expect(attachmentPath({ name: "photo.png", type: "image/png" }, paths, now)).toBe("Attachments/photo 1.png");
    expect(attachmentPath({ name: "a/b#c.mp4", type: "video/mp4" }, [], now)).toBe("Attachments/a b c.mp4");
    expect(vaultEmbedMarkdown("Attachments/new.png", [...paths, "Attachments/new.png"])).toBe("![[new.png]]");
    expect(vaultEmbedMarkdown("Attachments/photo.png", paths)).toBe("![[Attachments/photo.png]]");
  });

  test("a video block with timestamps survives Markdown vault save and reopen", () => {
    const markdown = "![[lecture.mp4]]\n- [[lecture.mp4#t=83|1:23]] Intro\n- [1:23](https://example.com/x.mp4#t=83) Other";
    const state = createEmptyState();
    const conversation = state.conversations[state.rootId];
    conversation.document = getEditableDocument(conversation);
    conversation.document.blocks[0].content = markdown;
    const restored = vaultToState(stateToVaultFiles(state, {}), state);
    expect(restored.conversations[state.rootId].document!.blocks[0].content).toBe(markdown);
  });
});
