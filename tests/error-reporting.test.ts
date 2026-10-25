import { expect, test } from "bun:test";
import { buildErrorEvent, createErrorReporter, parseSentryDsn, stackFrames } from "../server/lib/errorReporting.mjs";
import { sentryTarget, stackFrames as browserFrames } from "../client/src/lib/errorReporting";

const DSN = "https://abc123@o42.ingest.us.sentry.io/4507";

test("a Sentry DSN becomes its envelope endpoint, and anything else turns reporting off", () => {
  expect(parseSentryDsn(DSN)).toEqual({ publicKey: "abc123", endpoint: "https://o42.ingest.us.sentry.io/api/4507/envelope/" });
  for (const bad of [undefined, "", "not a url", "http://abc@host/1", "https://host/1", "https://abc@host/project"]) expect(parseSentryDsn(bad)).toBeNull();
  expect(sentryTarget(DSN)?.endpoint).toBe("https://o42.ingest.us.sentry.io/api/4507/envelope/?sentry_key=abc123&sentry_version=7&sentry_client=margin-chat-web/1.0");
  expect(sentryTarget(undefined)).toBeNull();
});

test("stack lines become frames, oldest first", () => {
  const stack = "Error: boom\n    at inner (/app/server/x.mjs:10:5)\n    at /app/server/y.mjs:3:1\n    at Module._compile (node:internal/modules:1:1)";
  expect(stackFrames(stack).map((frame) => [frame.function, frame.lineno, frame.in_app])).toEqual([["Module._compile", 1, false], ["?", 3, true], ["inner", 10, true]]);
  expect(browserFrames("render@https://www.marginchat.com/assets/index-abc.js?v=1:12:34").at(0)).toMatchObject({ function: "render", filename: "https://www.marginchat.com/assets/index-abc.js", lineno: 12 });
  expect(buildErrorEvent(new TypeError("bad"), { platform: "node" }).exception.values[0]).toMatchObject({ type: "TypeError", value: "bad" });
});

test("the server reporter sends the path but never the query string, and stays off without a DSN", async () => {
  const sent: { url: string; init: any }[] = [];
  const fetchImpl = (async (url: string, init: any) => { sent.push({ url, init }); return new Response("{}", { status: 200 }); }) as any;
  const off = createErrorReporter({ env: {}, fetchImpl });
  expect(off.enabled).toBe(false);
  expect(await off.report(new Error("x"))).toBe(false);

  const reporter = createErrorReporter({ env: { SENTRY_DSN: DSN, MARGIN_RELEASE_SHA: "abc" }, fetchImpl });
  expect(await reporter.report(new Error("database down"), { request: { url: "/api/auth/password-reset/confirm?token=secret", method: "POST" } })).toBe(true);
  expect(sent[0].url).toBe("https://o42.ingest.us.sentry.io/api/4507/envelope/");
  expect(sent[0].init.headers["X-Sentry-Auth"]).toContain("sentry_key=abc123");
  expect(sent[0].init.body).not.toContain("secret");
  const event = JSON.parse(sent[0].init.body.split("\n")[2]);
  expect(event).toMatchObject({ release: "abc", request: { url: "/api/auth/password-reset/confirm", method: "POST" } });

  const failing = createErrorReporter({ env: { SENTRY_DSN: DSN }, fetchImpl: (async () => { throw new Error("offline"); }) as any });
  expect(await failing.report(new Error("x"))).toBe(false);
});
