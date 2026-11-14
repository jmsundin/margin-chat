import { describe, expect, test } from "bun:test";
import { getNoteSnap } from "../client/src/lib/notesBeside";

const room = { roomLeft: 0, roomWidth: 1400 };

describe("a note opened beside its page", () => {
  test("keeps a new width when its edge is dragged a little", () => {
    expect(getNoteSnap({ ...room, requestedWidth: 700, pointerX: 700, leftEdge: true })).toBeNull();
    expect(getNoteSnap({ ...room, requestedWidth: 500, pointerX: 900, leftEdge: true })).toBeNull();
  });
  test("becomes the whole page when the line is dragged nearly all the way left", () => {
    expect(getNoteSnap({ ...room, requestedWidth: 1200, pointerX: 200, leftEdge: true })).toBe("page");
    expect(getNoteSnap({ ...room, requestedWidth: 1150, pointerX: 1300, leftEdge: false })).toBe("page");
  });
  test("goes back to the margin when the line is dragged nearly all the way right", () => {
    expect(getNoteSnap({ ...room, requestedWidth: 300, pointerX: 1300, leftEdge: true })).toBe("margin");
    expect(getNoteSnap({ ...room, requestedWidth: 200, pointerX: 600, leftEdge: false })).toBe("margin");
  });
  test("measures from where the room starts on screen", () => {
    expect(getNoteSnap({ roomLeft: 300, roomWidth: 1000, requestedWidth: 700, pointerX: 450, leftEdge: true })).toBe("page");
    expect(getNoteSnap({ roomLeft: 300, roomWidth: 1000, requestedWidth: 700, pointerX: 350, leftEdge: true })).toBe("page");
    expect(getNoteSnap({ roomLeft: 300, roomWidth: 1000, requestedWidth: 400, pointerX: 1250, leftEdge: true })).toBe("margin");
  });
});
