/**
 * Which notes are opened beside their page on this device. A note is one kind of document: it shows in its
 * page's margin until it is opened beside the page, and goes back there when it is put away. This only
 * remembers how notes show, never anything about the notes themselves.
 */
const STORAGE_KEY = "margin-chat:notes-beside";
const MAX_REMEMBERED = 200;

export function loadNotesBeside(): string[] {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string").slice(-MAX_REMEMBERED) : [];
  } catch {
    return [];
  }
}

export function saveNotesBeside(ids: string[]) {
  try {
    if (ids.length) window.localStorage.setItem(STORAGE_KEY, JSON.stringify(ids.slice(-MAX_REMEMBERED)));
    else window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Private windows and full storage only lose which notes were open beside.
  }
}

/** A note opened beside its page becomes the whole page when dragged this wide, as a share of the room. */
export const NOTE_PAGE_SNAP_SHARE = 0.8;
/** …and goes back to its page's margin when dragged this narrow, well past the smallest pane, */
export const NOTE_MARGIN_SNAP_WIDTH = 220;
/** …or when the line between them is dragged into this last share of the room. */
export const NOTE_MARGIN_SNAP_SHARE = 0.1;

/**
 * Where a note opened beside its page goes if a drag of its edge ends here: the whole page, back to the
 * margin, or nowhere (it just keeps the new width). The line between page and note is the note's left edge.
 */
export function getNoteSnap({ requestedWidth, pointerX, leftEdge, roomLeft, roomWidth }: {
  requestedWidth: number; pointerX: number; leftEdge: boolean; roomLeft: number; roomWidth: number;
}): "page" | "margin" | null {
  if (leftEdge && pointerX <= roomLeft + roomWidth * (1 - NOTE_PAGE_SNAP_SHARE)) return "page";
  if (leftEdge && pointerX >= roomLeft + roomWidth * (1 - NOTE_MARGIN_SNAP_SHARE)) return "margin";
  if (requestedWidth >= roomWidth * NOTE_PAGE_SNAP_SHARE) return "page";
  if (requestedWidth <= NOTE_MARGIN_SNAP_WIDTH) return "margin";
  return null;
}
