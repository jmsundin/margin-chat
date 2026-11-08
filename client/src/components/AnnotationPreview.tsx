import { useEffect, useId, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { summarizeAnnotationText } from "../lib/annotationPreview";
import type { ConversationNote, MessageAnchorLink } from "../types";
import "./AnnotationPreview.css";

const HOVER_DELAY = 320;
const LEAVE_DELAY = 180;
const SELECTOR = ".message-anchor[data-annotation-branches], .message-anchor[data-annotation-notes]";

function annotationIds(element: HTMLElement, key: "annotationBranches" | "annotationNotes"): string[] {
  try {
    const value: unknown = JSON.parse(element.dataset[key] ?? "[]");
    return Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : [];
  } catch { return []; }
}

function selectedText() {
  const selection = window.getSelection();
  return Boolean(selection && !selection.isCollapsed);
}

interface AnnotationPreviewProps {
  containerRef: RefObject<HTMLElement | null>;
  anchors: MessageAnchorLink[];
  notes: ConversationNote[];
  onOpenBranch: (id: string) => void;
  onOpenNote?: (id: string) => void;
  onRemoveLink?: (id: string) => void;
}

/** One preview per pane; resolve saved IDs against current content, never a copied DOM snippet. */
export default function AnnotationPreview(props: AnnotationPreviewProps) {
  const latest = useRef(props);
  latest.current = props;
  const [target, setTarget] = useState<HTMLElement | null>(null);
  const targetRef = useRef<HTMLElement | null>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const timers = useRef<{ open?: number; close?: number }>({});
  const [position, setPosition] = useState({ left: 12, top: 12 });
  const previewId = useId();
  const descriptionId = `${previewId}-description`;

  function clearTimers() {
    window.clearTimeout(timers.current.open);
    window.clearTimeout(timers.current.close);
    timers.current = {};
  }

  function close() {
    clearTimers();
    targetRef.current = null;
    setTarget(null);
  }

  function keepOpen() { window.clearTimeout(timers.current.close); }

  function scheduleClose() {
    window.clearTimeout(timers.current.open);
    window.clearTimeout(timers.current.close);
    timers.current.close = window.setTimeout(close, LEAVE_DELAY);
  }

  function hasContent(element: HTMLElement) {
    const { anchors, notes } = latest.current;
    return annotationIds(element, "annotationBranches").some((id) => anchors.some((link) => link.branchConversationId === id)) ||
      annotationIds(element, "annotationNotes").some((id) => notes.some((note) => note.id === id));
  }

  function positionPreview(element: HTMLElement) {
    const popup = popupRef.current;
    if (!popup) return;
    const anchorRect = element.getBoundingClientRect();
    const popupRect = popup.getBoundingClientRect();
    const below = anchorRect.bottom + 8;
    const above = anchorRect.top - popupRect.height - 8;
    setPosition({
      left: Math.max(12, Math.min(anchorRect.left, window.innerWidth - popupRect.width - 12)),
      top: Math.max(12, Math.min(below + popupRect.height <= window.innerHeight - 12 ? below : above, window.innerHeight - popupRect.height - 12)),
    });
  }

  useEffect(() => {
    const container = props.containerRef.current;
    if (!container) return;
    const find = (eventTarget: EventTarget | null) => {
      const mark = eventTarget instanceof Element ? eventTarget.closest<HTMLElement>(SELECTOR) : null;
      return mark && container.contains(mark) ? mark : null;
    };
    const show = (mark: HTMLElement, immediate: boolean) => {
      clearTimers();
      if (selectedText() || !hasContent(mark)) return;
      const open = () => {
        if (!mark.isConnected || selectedText() || !hasContent(mark)) return;
        targetRef.current = mark;
        setTarget(mark);
      };
      if (immediate || targetRef.current) open();
      else timers.current.open = window.setTimeout(open, HOVER_DELAY);
    };
    const pointerOver = (event: PointerEvent) => {
      if (event.pointerType === "touch" || event.buttons) return;
      const mark = find(event.target);
      if (mark && !mark.contains(event.relatedTarget as Node | null)) show(mark, false);
    };
    const pointerOut = (event: PointerEvent) => {
      const mark = find(event.target);
      const next = event.relatedTarget instanceof Node ? event.relatedTarget : null;
      if (!mark || mark.contains(next) || popupRef.current?.contains(next)) return;
      if (find(next)) return;
      scheduleClose();
    };
    const focusIn = (event: FocusEvent) => {
      const mark = find(event.target);
      if (mark) show(mark, true);
    };
    const focusOut = (event: FocusEvent) => {
      if (popupRef.current?.contains(event.relatedTarget as Node | null)) return;
      if (find(event.target)) scheduleClose();
    };
    const openNote = (event: MouseEvent | KeyboardEvent) => {
      const mark = find(event.target);
      if (!mark || selectedText()) return;
      if (!annotationIds(mark, "annotationBranches").length) {
        const noteId = annotationIds(mark, "annotationNotes").find((id) => latest.current.notes.some((note) => note.id === id));
        if (noteId && latest.current.onOpenNote) {
          event.preventDefault();
          event.stopPropagation();
          latest.current.onOpenNote(noteId);
        }
      }
      close();
    };
    const keyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && targetRef.current) {
        event.preventDefault();
        event.stopPropagation();
        const restoreFocus = popupRef.current?.contains(document.activeElement);
        const mark = targetRef.current;
        if (restoreFocus && mark.isConnected) mark.focus({ preventScroll: true });
        close();
      } else if (event.key === "ArrowDown" && find(event.target) && targetRef.current) {
        event.preventDefault();
        popupRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
      } else if ((event.key === "Enter" || event.key === " ") && find(event.target)) {
        openNote(event);
      }
    };
    const selectionChange = () => { if (selectedText()) close(); };
    const dismissOutside = (event: Event) => {
      if (!popupRef.current?.contains(event.target as Node)) close();
    };
    const dismissOnScroll = (event: Event) => {
      if (popupRef.current?.contains(event.target as Node)) return;
      // Tab focus may scroll its highlight into view; keep and reposition that preview.
      const focusedMark = targetRef.current;
      if (focusedMark && document.activeElement === focusedMark) {
        const rect = focusedMark.getBoundingClientRect();
        if (rect.bottom > 0 && rect.top < window.innerHeight) {
          positionPreview(focusedMark);
          return;
        }
      }
      close();
    };
    const observer = new MutationObserver(() => {
      if (targetRef.current && !container.contains(targetRef.current)) close();
    });
    observer.observe(container, { childList: true, subtree: true });
    container.addEventListener("pointerover", pointerOver);
    container.addEventListener("pointerout", pointerOut);
    container.addEventListener("focusin", focusIn);
    container.addEventListener("focusout", focusOut);
    container.addEventListener("click", openNote);
    document.addEventListener("pointerdown", dismissOutside, true);
    document.addEventListener("click", dismissOutside, true);
    document.addEventListener("keydown", keyDown, true);
    document.addEventListener("selectionchange", selectionChange);
    window.addEventListener("scroll", dismissOnScroll, true);
    window.addEventListener("resize", close);
    return () => {
      clearTimers();
      observer.disconnect();
      container.removeEventListener("pointerover", pointerOver);
      container.removeEventListener("pointerout", pointerOut);
      container.removeEventListener("focusin", focusIn);
      container.removeEventListener("focusout", focusOut);
      container.removeEventListener("click", openNote);
      document.removeEventListener("pointerdown", dismissOutside, true);
      document.removeEventListener("click", dismissOutside, true);
      document.removeEventListener("keydown", keyDown, true);
      document.removeEventListener("selectionchange", selectionChange);
      window.removeEventListener("scroll", dismissOnScroll, true);
      window.removeEventListener("resize", close);
    };
  }, [props.containerRef]);

  const branches = target ? props.anchors.filter((link) => annotationIds(target, "annotationBranches").includes(link.branchConversationId)) : [];
  const notes = target ? props.notes.filter((note) => annotationIds(target, "annotationNotes").includes(note.id)) : [];
  const visible = Boolean(target?.isConnected && (branches.length || notes.length));

  useLayoutEffect(() => {
    if (!visible || !target || !popupRef.current) return;
    positionPreview(target);
    // ProseMirror owns decoration attributes. Mutating one makes its DOM
    // observer replace the highlight and dismiss the preview immediately.
    if (target.closest(".tiptap")) return;
    const previous = target.getAttribute("aria-describedby");
    target.setAttribute("aria-describedby", [previous, descriptionId].filter(Boolean).join(" "));
    return () => {
      if (previous) target.setAttribute("aria-describedby", previous);
      else target.removeAttribute("aria-describedby");
    };
  }, [target, visible, props.anchors, props.notes, descriptionId]);

  if (!visible) return null;
  return createPortal(
    <div
      aria-label="Linked chat and note preview"
      className="annotation-preview"
      id={previewId}
      onClick={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
      onPointerEnter={keepOpen}
      onPointerLeave={scheduleClose}
      onFocus={keepOpen}
      onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) scheduleClose(); }}
      ref={popupRef}
      role="dialog"
      style={position}
    >
      <div className="annotation-preview-heading"><span>Linked to this passage</span><button aria-label="Close preview" onClick={close} type="button">×</button></div>
      <div id={descriptionId}>
        {branches.map((link) => {
          const preview = link.preview;
          const isNote = preview?.kind === "note";
          const isLink = link.kind === "document-link";
          return <section className="annotation-preview-item" key={link.branchConversationId}>
            <div className="annotation-preview-kind">{isLink ? link.targetBlockId ? "Linked block" : "Linked document" : isNote ? "Side note" : "Side chat"}{preview?.messageCount ? ` · ${preview.messageCount} ${preview.messageCount === 1 ? "message" : "messages"}` : ""}</div>
            <h3>{link.title}</h3>
            {preview?.prompt || link.anchor.prompt ? <p className="annotation-preview-question">{summarizeAnnotationText(preview?.prompt || link.anchor.prompt, 160)}</p> : null}
            {preview?.content ? <><span className="annotation-preview-caption">{isLink ? "Linked content" : isNote ? "Note preview" : "Latest reply"}</span><p>{preview.content}</p></> : <p className="annotation-preview-empty">{isLink ? "This document is empty." : isNote ? "This note is empty." : "No reply yet. Open the chat to continue."}</p>}
            <button className="annotation-preview-open" onClick={() => { close(); props.onOpenBranch(link.branchConversationId); }} type="button">Open {isLink ? link.targetBlockId ? "linked block" : "linked document" : isNote ? "side note" : "side chat"}<span aria-hidden="true">↗</span></button>
            {isLink && props.onRemoveLink ? <button className="annotation-preview-open" onClick={() => { close(); props.onRemoveLink?.(link.branchConversationId); }} type="button">Remove link</button> : null}
          </section>;
        })}
        {notes.map((note) => <section className="annotation-preview-item" key={note.id}>
          <div className="annotation-preview-kind">Side note · Private</div>
          <p>{summarizeAnnotationText(note.content) || "This note is empty."}</p>
          {props.onOpenNote ? <button className="annotation-preview-open" onClick={() => { close(); props.onOpenNote?.(note.id); }} type="button">Open note<span aria-hidden="true">↗</span></button> : null}
        </section>)}
      </div>
    </div>, document.body,
  );
}
