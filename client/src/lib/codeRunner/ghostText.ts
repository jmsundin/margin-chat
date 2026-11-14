import { Prec, StateEffect, StateField, type Extension } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, WidgetType, keymap, type ViewUpdate } from "@codemirror/view";
import type { CodeCellSibling, CodeLanguage } from "./languages";
import { buildSuggestionPrompt, findSuggestionTrigger, shapeSuggestion } from "./codeSuggestion";

/**
 * Ghost text for code cells: after a comment, the AI's code for it shows as
 * faint text at the cursor. Tab (or a tap on it) puts it in; Esc, moving the
 * cursor or typing something else dismisses it. Typing the same characters
 * it shows keeps the rest of it, as in VS Code.
 */

const WAIT_MS = 650;

interface Ghost { at: number; text: string }

/** Shows a suggestion, or clears it with null. */
export const setGhost = StateEffect.define<Ghost | null>();

const ghostField = StateField.define<Ghost | null>({
  create: () => null,
  update(ghost, tr) {
    for (const effect of tr.effects) if (effect.is(setGhost)) return effect.value;
    if (!ghost) return null;
    let next: Ghost | null = ghost;
    if (tr.docChanged) {
      let changes = 0;
      const typed = { text: "" };
      tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
        changes += 1;
        if (fromA === ghost.at && toA === ghost.at) typed.text = inserted.toString();
      });
      const text = typed.text;
      next = changes === 1 && text && ghost.text.startsWith(text) ? { at: ghost.at + text.length, text: ghost.text.slice(text.length) } : null;
      if (next && !next.text) next = null;
    }
    const selection = tr.state.selection.main;
    if (next && (!selection.empty || selection.head !== next.at)) next = null;
    return next;
  },
  provide: (field) => EditorView.decorations.from(field, (ghost) => ghost
    ? Decoration.set([Decoration.widget({ widget: new GhostWidget(ghost.text), side: 1 }).range(ghost.at)])
    : Decoration.none),
});

class GhostWidget extends WidgetType {
  constructor(readonly text: string) { super(); }
  eq(other: GhostWidget) { return other.text === this.text; }
  toDOM(view: EditorView) {
    const ghost = document.createElement("span");
    ghost.className = "cm-ghost-text";
    ghost.setAttribute("aria-hidden", "true");
    ghost.textContent = this.text;
    const hint = document.createElement("span");
    hint.className = "cm-ghost-hint";
    hint.textContent = "Tab to insert";
    ghost.append(hint);
    // Phones have no Tab key: a tap on the suggestion puts it in.
    ghost.addEventListener("mousedown", (event) => { event.preventDefault(); acceptGhost(view); view.focus(); });
    return ghost;
  }
  ignoreEvent() { return false; }
}

function acceptGhost(view: EditorView): boolean {
  const ghost = view.state.field(ghostField, false);
  if (!ghost) return false;
  view.dispatch({
    changes: { from: ghost.at, insert: ghost.text },
    selection: { anchor: ghost.at + ghost.text.length },
    effects: setGhost.of(null),
    userEvent: "input.complete",
    scrollIntoView: true,
  });
  return true;
}

/** Whether a suggestion is showing now. */
export function hasGhost(view: EditorView): boolean {
  return Boolean(view.state.field(ghostField, false));
}

export interface CodeSuggestionOptions {
  language: CodeLanguage;
  /** Asks the AI; resolves to its code, or "" for nothing. */
  request: (prompt: string, signal: AbortSignal) => Promise<string>;
  /** The document's code cells and this cell's place among them, read when a suggestion is asked for. */
  context?: () => { cells: ReadonlyArray<CodeCellSibling>; own: number };
  /** Told when a request fails, so the caller can stop asking (signed out, out of AI allowance). */
  onError?: (error: unknown) => void;
  /** Checked before each request. */
  enabled?: () => boolean;
}

/** Ghost-text code suggestions after comments, for one code cell's editor. */
export function codeSuggestions(options: CodeSuggestionOptions): Extension {
  const asker = ViewPlugin.fromClass(class {
    timer: ReturnType<typeof setTimeout> | null = null;
    pending: AbortController | null = null;
    /** The comment last answered, so dismissing its suggestion doesn't bring it back. */
    done = "";

    constructor(readonly view: EditorView) {}

    update(update: ViewUpdate) {
      const typed = update.transactions.some((tr) => tr.isUserEvent("input") || tr.isUserEvent("delete"));
      if (update.docChanged || update.selectionSet) this.cancel();
      if (typed && !update.state.field(ghostField) && !update.transactions.some((tr) => tr.isUserEvent("input.complete"))) {
        this.timer = setTimeout(() => void this.ask(), WAIT_MS);
      }
    }

    cancel() {
      if (this.timer) { clearTimeout(this.timer); this.timer = null; }
      this.pending?.abort();
      this.pending = null;
    }

    async ask() {
      this.timer = null;
      if (options.enabled && !options.enabled()) return;
      const state = this.view.state;
      const selection = state.selection.main;
      if (!selection.empty) return;
      const doc = state.doc.toString();
      const trigger = findSuggestionTrigger(options.language, doc, selection.head);
      if (!trigger || trigger.key === this.done) return;
      const context = options.context?.();
      const prompt = buildSuggestionPrompt({ language: options.language, doc, at: trigger.at, siblings: context?.cells, own: context?.own });
      const controller = new AbortController();
      this.pending = controller;
      let code = "";
      try {
        code = await options.request(prompt, controller.signal);
      } catch (error) {
        if (!controller.signal.aborted) options.onError?.(error);
        return;
      } finally {
        if (this.pending === controller) this.pending = null;
      }
      // Anything typed or moved meanwhile makes the answer stale.
      if (controller.signal.aborted || this.view.state.doc !== state.doc || this.view.state.selection.main.head !== selection.head) return;
      this.done = trigger.key;
      const text = shapeSuggestion(code, trigger, options.language);
      if (text) this.view.dispatch({ effects: setGhost.of({ at: trigger.at, text }) });
    }

    destroy() { this.cancel(); }
  });

  return [
    ghostField,
    asker,
    Prec.highest(keymap.of([
      { key: "Tab", run: acceptGhost },
      { key: "Escape", run: (view) => { if (!hasGhost(view)) return false; view.dispatch({ effects: setGhost.of(null) }); return true; } },
    ])),
  ];
}

/** The suggestion showing in `state`, if any. */
export function ghostIn(state: import("@codemirror/state").EditorState): Ghost | null {
  return state.field(ghostField, false) ?? null;
}
