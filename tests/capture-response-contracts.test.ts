import { describe, expect, test } from "bun:test";
import {
  normalizeCapture,
  parseCapture,
  parseCaptureConnection,
  parseCaptureDetail,
  parseCapturePage,
  parseCaptureReceipt,
  parseExtensionSession,
} from "@margin-chat/capture-contracts";

const capturedAt = "2026-09-12T12:30:00.000Z";
const capture = {
  schemaVersion: 1,
  clientCaptureId: "a-stable-capture-id",
  kind: "article",
  title: "Useful reference",
  sourceUrl: "https://example.com/article",
  content: "Keep the source.",
  comment: "Discuss later.",
  capturedAt,
  id: "capture-id",
  createdAt: capturedAt,
};
const { content: _content, comment: _comment, ...metadata } = capture;
const summary = { ...metadata, excerpt: "Keep the source." };
const session = () => ({
  token: `mc_extension_${"A".repeat(43)}`,
  user: { id: "reader", displayName: "Reader", email: "reader@example.test" },
  expiresAt: new Date(Date.now() + 86400_000).toISOString(),
});

describe("capture response contracts", () => {
  test("accepts additive v1 fields without modifying response objects", () => {
    const future = { futureOptionalField: { enabled: true } };
    const values: [unknown, (input: unknown) => unknown][] = [
      [{ capture: { id: "saved-id", createdAt: capturedAt, ...future }, ...future }, parseCaptureReceipt],
      [{ ...session(), ...future }, parseExtensionSession],
      [{ userId: "reader", displayName: "Reader", expiresAt: capturedAt, ...future }, parseCaptureConnection],
      [{ ...capture, ...future }, parseCapture],
      [{ capture: { ...capture, ...future }, ...future }, parseCaptureDetail],
      [{ captures: [{ ...summary, ...future }], nextCursor: "opaque-cursor", ...future }, parseCapturePage],
    ];
    for (const [value, parse] of values) {
      const before = structuredClone(value);
      expect(parse(value)).toBe(value);
      expect(value).toEqual(before);
    }
    expect(parseCapturePage({ captures: [], nextCursor: null })).toEqual({ captures: [], nextCursor: null });
    expect(parseCapture({ ...capture, kind: "bookmark", content: "" }).content).toBe("");
  });

  test("rejects malformed receipts before they can confirm an upload", () => {
    for (const value of [
      null, [], {}, { capture: [] },
      { capture: { id: 42, createdAt: capturedAt } },
      { capture: { id: " ", createdAt: capturedAt } },
      { capture: { id: "saved-id", createdAt: "not-a-date" } },
      { capture: { id: "saved-id", createdAt: 2026 } },
    ]) {
      expect(() => parseCaptureReceipt(value)).toThrow("did not confirm");
    }
  });

  test("requires a current scoped session and typed account fields", () => {
    for (const value of [
      null, [], {},
      { ...session(), token: `mc_capture_${"A".repeat(43)}` },
      { ...session(), user: { ...session().user, id: 42 } },
      { ...session(), user: { ...session().user, email: " " } },
      { ...session(), expiresAt: "not-a-date" },
      { ...session(), expiresAt: 2099 },
      { ...session(), expiresAt: new Date(Date.now() - 60_000).toISOString() },
    ]) {
      expect(() => parseExtensionSession(value)).toThrow("valid session");
    }
  });

  test("allows legacy connection replies without a user ID but rejects malformed identities", () => {
    const legacy = { displayName: "Reader", expiresAt: capturedAt };
    expect(parseCaptureConnection(legacy)).toBe(legacy);
    for (const value of [
      null, [], {}, { ...legacy, userId: 42 }, { ...legacy, userId: "" },
      { ...legacy, displayName: null }, { ...legacy, expiresAt: "not-a-date" },
    ]) {
      expect(() => parseCaptureConnection(value)).toThrow("invalid capture connection");
    }
  });

  test("validates detail fields and source metadata before a capture becomes a note", () => {
    for (const value of [
      null, [], {},
      { ...capture, id: 42 }, { ...capture, createdAt: "not-a-date" },
      { ...capture, content: undefined }, { ...capture, comment: null },
      { ...capture, schemaVersion: 2 }, { ...capture, kind: "unknown" },
      { ...capture, sourceUrl: "javascript:alert(1)" },
      { ...capture, capturedAt: 2026 }, { ...capture, title: "" },
    ]) {
      expect(() => parseCaptureDetail({ capture: value })).toThrow("invalid capture");
    }
    expect(() => parseCaptureDetail([])).toThrow("invalid capture");
  });

  test("validates list containers, cursors, and summaries without requiring article bodies", () => {
    expect(parseCapturePage({ captures: [summary], nextCursor: null }).captures[0]).toBe(summary);
    for (const value of [
      null, [], {}, { captures: {}, nextCursor: null },
      { captures: [], nextCursor: 42 }, { captures: [] },
      ...[
        null, [], {}, { ...summary, excerpt: null },
        { ...summary, id: 42 }, { ...summary, createdAt: "not-a-date" },
        { ...summary, sourceUrl: "file:///tmp/private" },
        { ...summary, schemaVersion: 2 }, { ...summary, clientCaptureId: "short" },
      ].map((invalid) => ({ captures: [invalid], nextCursor: null })),
    ]) {
      expect(() => parseCapturePage(value)).toThrow("invalid Cloud Inbox page");
    }
  });

  test("preserves the v1 payload serialization used by existing retry hashes", () => {
    expect(JSON.stringify(normalizeCapture(capture))).toBe(
      '{"schemaVersion":1,"clientCaptureId":"a-stable-capture-id","kind":"article","title":"Useful reference","sourceUrl":"https://example.com/article","content":"Keep the source.","comment":"Discuss later.","capturedAt":"2026-09-12T12:30:00.000Z"}',
    );
  });
});
