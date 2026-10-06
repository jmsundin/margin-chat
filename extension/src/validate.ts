import { CAPTURE_LIMITS } from "@margin-chat/capture-contracts";
import type { TextQuoteAnchor } from "./overlay-types";

export function record(value: unknown, label = "page draft"): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`Invalid ${label}.`);
  return value as Record<string, unknown>;
}
export function textValue(value: unknown, limit: number, label: string): string {
  if (typeof value !== "string" || value.length > limit || value.includes("\0"))
    throw new Error(`Invalid ${label}.`);
  return value;
}
export function normalizeAnchor(value: unknown): TextQuoteAnchor | undefined {
  if (value === undefined) return undefined;
  const anchor = record(value, "selected passage anchor");
  const exact = textValue(anchor.exact, CAPTURE_LIMITS.content, "selected text");
  if (!exact.trim() || !Number.isSafeInteger(anchor.start) || !Number.isSafeInteger(anchor.end) ||
      (anchor.start as number) < 0 || (anchor.end as number) <= (anchor.start as number))
    throw new Error("Invalid selected passage anchor.");
  return {
    exact,
    prefix: textValue(anchor.prefix, 512, "passage prefix"),
    suffix: textValue(anchor.suffix, 512, "passage suffix"),
    start: anchor.start as number,
    end: anchor.end as number,
  };
}
