/**
 * Files dragged onto the app from the desktop or Finder. The app has its own
 * drags too (tabs, blocks, chats, links), and those never carry "Files".
 */

export function carriesFiles(dataTransfer: Pick<DataTransfer, "types"> | null | undefined) {
  return !!dataTransfer && Array.from(dataTransfer.types ?? []).includes("Files");
}

function closest(target: EventTarget | null, selector: string) {
  const element = target as Element | null;
  return typeof element?.closest === "function" && !!element.closest(selector);
}

/** Places that take dropped files for themselves, such as the ChatGPT import box, or that sit under a dialog. */
export function handlesOwnFileDrop(target: EventTarget | null) {
  return closest(target, "[data-file-drop], [aria-modal='true']");
}

/** Images, video and sound dropped into a document go into that document instead of the vault. */
export function dropsIntoDocument(target: EventTarget | null, itemTypes: string[]) {
  return closest(target, ".ProseMirror")
    && itemTypes.length > 0 && itemTypes.every((type) => /^(?:image|video|audio)\//u.test(type));
}

/** Dropped files, minus folders, which a browser hands over as unreadable empty files. */
export function droppedFiles(dataTransfer: Pick<DataTransfer, "files" | "items">) {
  const files = Array.from(dataTransfer.files ?? []);
  const items = Array.from(dataTransfer.items ?? []).filter((item) => item.kind === "file");
  const folders = new Set<number>();
  if (items.length === files.length) {
    items.forEach((item, index) => { if (item.webkitGetAsEntry?.()?.isDirectory) folders.add(index); });
  }
  return {
    files: files.filter((_, index) => !folders.has(index)),
    folders: files.filter((_, index) => folders.has(index)).map((file) => file.name),
  };
}

export function describeDroppedFolders(folders: string[]) {
  if (!folders.length) return "";
  const names = folders.map((name) => `“${name}”`).join(", ");
  return folders.length === 1
    ? `${names} is a folder, so it wasn’t added. Zip it first, or use Open folder as vault.`
    : `${names} are folders, so they weren’t added. Zip them first, or use Open folder as vault.`;
}
