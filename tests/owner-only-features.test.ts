import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { createServer } from "node:http";
import { createApiHandler } from "../server/routes/api.mjs";
import { canUseOwnerOnlyFeature, ownerOnlyFeatureEmails, ownerOnlyFeaturesFor, withOwnerOnlyFeatures } from "../server/features/ownerOnly.mjs";
import { LOCAL_USER_EMAIL } from "../server/local/mode.mjs";
import {
  applyFeaturePreset, availableFeatures, featureAvailable, matchFeatures, matchingPreset, readFeatures, readUsableFeatures, saveFeatures, setOwnerFeatureAccess,
} from "../client/src/lib/features";

const env = { OWNER_ONLY_FEATURE_EMAILS: " Owner@Example.com , second@example.com" };

describe("owner-only features on the server", () => {
  test("only listed emails get them; unset means nobody, local mode included", () => {
    expect([...ownerOnlyFeatureEmails(env)]).toEqual(["owner@example.com", "second@example.com"]);
    expect(ownerOnlyFeaturesFor({ email: "OWNER@example.com" }, env)).toEqual(["voice", "flashcards"]);
    expect(ownerOnlyFeaturesFor({ email: "someone@example.com" }, env)).toEqual([]);
    expect(ownerOnlyFeaturesFor({ email: "owner@example.com" }, {})).toEqual([]);
    expect(ownerOnlyFeaturesFor({ email: LOCAL_USER_EMAIL }, env)).toEqual([]);
    expect(ownerOnlyFeaturesFor(null, env)).toEqual([]);
    expect(canUseOwnerOnlyFeature({ email: "someone@example.com" }, "voice", env)).toBe(false);
    expect(canUseOwnerOnlyFeature({ email: "someone@example.com" }, "boards", env)).toBe(true);
    expect(withOwnerOnlyFeatures({ id: "u", email: "owner@example.com" }, env)).toEqual({ id: "u", email: "owner@example.com", ownerFeatures: ["voice", "flashcards"] });
  });

  describe("API", () => {
    let server: ReturnType<typeof createServer>, origin: string;
    const started: unknown[] = [];
    beforeAll(async () => {
      const dictationService = {
        startLive: async () => { started.push("live"); return { token: "t" }; },
        finishLive: async () => ({ settled: true }),
        renewLive: async () => ({ renewed: true }),
        transcribe: async () => ({ text: "" }),
      };
      server = createServer(createApiHandler({ runtimeConfig: { host: "127.0.0.1", port: 0 }, env, dictationService,
        authService: { getAuthContext: async (request: any) => ({ user: { id: "u", email: String(request.headers["x-test-email"]) } }) } } as any));
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      origin = `http://127.0.0.1:${(server.address() as any).port}`;
    });
    afterAll(async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); });

    test("voice typing and flashcard sync refuse everyone not on the list", async () => {
      for (const path of ["/api/dictation/live", "/api/dictation/live/finish", "/api/dictation/live/renew", "/api/flashcards/sync"]) {
        const response = await fetch(`${origin}${path}`, { method: "POST", headers: { "Content-Type": "application/json", "X-Margin-Vault-User": "u", "X-Test-Email": "someone@example.com" }, body: "{}" });
        expect(response.status).toBe(403);
      }
      expect(started).toEqual([]);
    });

    test("the listed account gets through", async () => {
      const response = await fetch(`${origin}/api/dictation/live`, { method: "POST", headers: { "Content-Type": "application/json", "X-Margin-Vault-User": "u", "X-Test-Email": "owner@example.com" }, body: "{}" });
      expect(response.status).not.toBe(403);
    });
  });
});

describe("owner-only features in the app", () => {
  const globals = globalThis as Record<string, unknown>;
  const store = new Map<string, string>();
  const previous = globals.localStorage;
  beforeAll(() => { globals.localStorage = { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => { store.set(key, value); }, removeItem: (key: string) => store.delete(key) }; });
  afterAll(() => { globals.localStorage = previous; });
  afterEach(() => { store.clear(); setOwnerFeatureAccess([]); });

  test("without access they have no switch, stay off and aren't found in ⌘K", () => {
    saveFeatures({ voice: true, flashcards: true, boards: true });
    expect(readFeatures().voice).toBe(true);
    expect(readUsableFeatures()).toMatchObject({ voice: false, flashcards: false, boards: true });
    expect(featureAvailable("voice")).toBe(false);
    expect(availableFeatures().map(({ id }) => id)).not.toContain("voice");
    expect(availableFeatures().map(({ id }) => id)).not.toContain("flashcards");
    expect(matchFeatures("dictat")).toEqual([]);
    expect(matchFeatures("flash")).toEqual([]);
  });

  test("presets leave held-back features alone and still match", () => {
    applyFeaturePreset("student");
    expect(readFeatures()).toMatchObject({ voice: false, flashcards: false, language: true, outline: true });
    expect(matchingPreset(readUsableFeatures())).toBe("student");
  });

  test("the owner's account gets them back, and losing access hides them again", () => {
    saveFeatures({ voice: true });
    setOwnerFeatureAccess(["voice", "flashcards", "unknown"]);
    expect(readUsableFeatures().voice).toBe(true);
    expect(matchFeatures("dictat").map(({ id }) => id)).toEqual(["voice"]);
    setOwnerFeatureAccess([]);
    expect(readUsableFeatures().voice).toBe(false);
  });
});
