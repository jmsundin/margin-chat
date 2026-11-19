import { formatDocumentDateTime } from "./documentDateTime";

/**
 * Actions the phone keyboard bar sends to whichever editor holds the caret. Ask AI, the caret's
 * ⋯ menu and voice typing are offered only when the field lists them in EDITOR_ACTIONS_ATTRIBUTE.
 */
export type EditorCommand = "wiki-link" | "date-time" | "indent" | "outdent" | EditorAction;
export type EditorAction = "ask-ai" | "caret-menu" | "dictate";

/** Space-separated EditorActions a field answers, e.g. `data-editor-actions="ask-ai dictate"`. */
export const EDITOR_ACTIONS_ATTRIBUTE = "data-editor-actions";

export function editorActionsOf(field: HTMLElement | null): EditorAction[] {
  const value = field?.closest(`[${EDITOR_ACTIONS_ATTRIBUTE}]`)?.getAttribute(EDITOR_ACTIONS_ATTRIBUTE) ?? "";
  return value.split(/\s+/u).filter((action): action is EditorAction => action === "ask-ai" || action === "caret-menu" || action === "dictate");
}

const EDITOR_COMMAND_EVENT = "margin-editor-command";

/** Lets an editor answer the keyboard bar. Return true when the command was handled. */
export function listenForEditorCommands(element: HTMLElement, run: (command: EditorCommand) => boolean) {
  const listener = (event: Event) => {
    const command = (event as CustomEvent<EditorCommand>).detail;
    if (!event.defaultPrevented && run(command)) event.preventDefault();
  };
  element.addEventListener(EDITOR_COMMAND_EVENT, listener);
  return () => element.removeEventListener(EDITOR_COMMAND_EVENT, listener);
}

/** Sends a command to the focused field. Plain text fields fall back to inserting text themselves. */
export function runEditorCommand(field: HTMLElement, command: EditorCommand) {
  const event = new CustomEvent<EditorCommand>(EDITOR_COMMAND_EVENT, { detail: command, cancelable: true });
  if (!field.dispatchEvent(event)) return true;
  if (!(field instanceof HTMLTextAreaElement || field instanceof HTMLInputElement) || field.readOnly || field.disabled) return false;
  if (command === "ask-ai" || command === "caret-menu" || command === "dictate") return false;
  if (command === "wiki-link") return insertIntoField(field, "[[");
  if (command === "date-time") return insertIntoField(field, formatDocumentDateTime());
  if (!(field instanceof HTMLTextAreaElement)) return false;
  // Indent or outdent the caret's line by two spaces, like a code editor's Tab.
  const start = field.selectionStart ?? 0, end = field.selectionEnd ?? start;
  const lineStart = field.value.lastIndexOf("\n", start - 1) + 1;
  if (command === "indent") {
    field.setSelectionRange(lineStart, lineStart);
    insertIntoField(field, "  ");
    field.setSelectionRange(start + 2, end + 2);
    return true;
  }
  const remove = field.value.startsWith("  ", lineStart) ? 2 : field.value[lineStart] === " " || field.value[lineStart] === "\t" ? 1 : 0;
  if (!remove) return true;
  field.setSelectionRange(lineStart, lineStart + remove);
  insertIntoField(field, "");
  field.setSelectionRange(Math.max(lineStart, start - remove), Math.max(lineStart, end - remove));
  return true;
}

/** execCommand keeps the field's undo history and fires the input event React listens for. */
function insertIntoField(field: HTMLTextAreaElement | HTMLInputElement, text: string) {
  if (text ? document.execCommand("insertText", false, text) : document.execCommand("delete")) return true;
  field.setRangeText(text, field.selectionStart ?? 0, field.selectionEnd ?? 0, "end");
  field.dispatchEvent(new Event("input", { bubbles: true }));
  return true;
}
