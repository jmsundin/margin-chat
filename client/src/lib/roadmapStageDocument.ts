import { getCurrentDocumentText } from "./documentSources";
import { plainPreview } from "./roadmap";
import type { MapPath } from "./mapPaths";
import type { Conversation } from "../types";

/**
 * A roadmap's stage opens as a document of its own, like every other node: an index that
 * says where the stage sits and links to each of its lessons with a line on what it covers.
 * It lives under the roadmap, made the first time the stage is opened, and is the user's
 * from then on. A link followed from it opens the lesson in the index's place.
 */

const STAGE_MARK = ".stage.";

/** The stage's document id: the roadmap's, then the stage's, so the same stage always opens the same document. */
export function stageDocumentId(pathId: string, stageId: string) {
  return `${pathId}${STAGE_MARK}${stageId}`.slice(0, 200);
}

/** A document made as a roadmap stage's index. */
export function isStageDocumentId(id: string) {
  return id.includes(STAGE_MARK);
}

/** One line on what a lesson covers: its first sentences, without the title it repeats. */
export function lessonSummary(conversation: Conversation | undefined, limit = 150): string {
  if (!conversation) return "";
  const lines = getCurrentDocumentText(conversation).split(/\n/u);
  const title = conversation.title.trim().toLocaleLowerCase();
  const body = lines.filter((line) => {
    const heading = /^\s*#{1,6}\s+(.*)$/u.exec(line);
    return !(heading && heading[1].trim().toLocaleLowerCase() === title);
  }).join("\n");
  const text = plainPreview(body);
  if (text.length <= limit) return text;
  const cut = text.slice(0, limit);
  const sentence = cut.lastIndexOf(". ");
  return sentence > limit * 0.5 ? cut.slice(0, sentence + 1) : `${cut.slice(0, cut.lastIndexOf(" ") > 0 ? cut.lastIndexOf(" ") : limit)}…`;
}

const linkTitle = (title: string) => title.replace(/[[\]|]/gu, " ").replace(/\s+/gu, " ").trim() || "Untitled";

/** One lesson's line in the index: its link, and what it covers once there is something to say. */
function lessonLine(title: string, conversation: Conversation | undefined, optional: boolean) {
  const summary = lessonSummary(conversation);
  return `- [[${linkTitle(title)}]]${optional ? " (optional)" : ""}${summary ? `: ${summary}` : ""}`;
}

/** The index's Markdown: where the stage sits in its roadmap, then each lesson in order. */
export function stageDocumentMarkdown(path: MapPath, stageId: string, conversations: Record<string, Conversation>): string {
  const stageIds = [...new Set(path.steps.map((step) => step.stageId))];
  const steps = path.steps.filter((step) => step.stageId === stageId);
  const number = stageIds.indexOf(stageId) + 1;
  const done = steps.filter((step) => step.status === "done" || step.status === "skipped").length;
  return [
    `Stage ${number} of ${stageIds.length} in [[${linkTitle(path.name)}]] · ${done} of ${steps.length} done`,
    "",
    ...steps.map((step) => lessonLine(step.title, conversations[step.docId], step.optional)),
    "",
  ].join("\n");
}

/** Lines for lessons the stage gained since its index was made; empty when every lesson is already linked. */
export function missingLessonLines(path: MapPath, stageId: string, existing: string, conversations: Record<string, Conversation>): string[] {
  return path.steps.filter((step) => step.stageId === stageId && !existing.includes(`[[${linkTitle(step.title)}]]`))
    .map((step) => lessonLine(step.title, conversations[step.docId], step.optional));
}
