import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { loadMigrations, migrateDatabase } from "../server/db/migrations.mjs";
import * as repository from "../server/db/interfaceSettingsRepository.mjs";
import { createInterfaceSettingsService } from "../server/interfaceSettings/index.mjs";
import { setApiTransport } from "../client/src/lib/apiTransport";
import { onSyncedSettingChange, startInterfaceSettingsSync, writeSyncedSetting } from "../client/src/lib/interfaceSettings";
import {
  FEATURES_KEY, applyFeaturePreset, featuresFromUsage, hasFeatureChoices, matchingPreset, parseFeatures, readFeatures, saveFeatures, setFeature, unchosenFeatures,
} from "../client/src/lib/features";

const databases: PGlite[] = [];
afterEach(async () => { await Promise.all(databases.splice(0).map((database) => database.close())); });

async function serviceWithDatabase() {
  const pg = new PGlite({ extensions: { vector } });
  databases.push(pg);
  const client = { async query(sql: string, values?: unknown[]) {
    const result = values === undefined && sql.includes(";") ? (await pg.exec(sql)).at(-1)! : await pg.query(sql, values);
    return { ...result, rowCount: result.rows.length || (result as { affectedRows?: number }).affectedRows || 0 };
  } };
  await migrateDatabase(client, { migrations: await loadMigrations() });
  await pg.query("insert into marginchat_users (id,email,password_hash,display_name) values ('u1','u1@example.test','hash','U1'), ('u2','u2@example.test','hash','U2')");
  return createInterfaceSettingsService({ database: {
    readInterfaceSettings: (args: any) => repository.readInterfaceSettings(client, args),
    saveInterfaceSettings: (args: any) => repository.saveInterfaceSettings(client, args),
  } });
}

describe("interface settings on the account", () => {
  test("merges each device's changes, removes on null, and stays private to the account", async () => {
    const service = await serviceWithDatabase();
    expect(await service.read({ userId: "u1" })).toEqual({ values: {} });
    await service.save({ userId: "u1", body: { values: { "margin-chat-theme": "dark", "margin-chat:features": "{\"voice\":true}" } } });
    // A second device changes only the theme; the features it didn't send stay.
    expect(await service.save({ userId: "u1", body: { values: { "margin-chat-theme": "light" } } }))
      .toEqual({ values: { "margin-chat-theme": "light", "margin-chat:features": "{\"voice\":true}" } });
    await service.save({ userId: "u1", body: { values: { "margin-chat-theme": null } } });
    expect(await service.read({ userId: "u1" })).toEqual({ values: { "margin-chat:features": "{\"voice\":true}" } });
    expect(await service.read({ userId: "u2" })).toEqual({ values: {} });
  }, 30_000);

  test("refuses names that aren't Margin Chat settings, non-text values, and too many settings", async () => {
    const service = await serviceWithDatabase();
    await expect(service.save({ userId: "u1", body: { values: { "token": "x" } } })).rejects.toMatchObject({ statusCode: 400 });
    await expect(service.save({ userId: "u1", body: { values: { "margin-chat:quiet-page": true } } })).rejects.toMatchObject({ statusCode: 400 });
    await expect(service.save({ userId: "u1", body: { values: { "margin-chat:x": "y".repeat(5000) } } })).rejects.toMatchObject({ statusCode: 400 });
    await expect(service.save({ userId: "u1", body: [] })).rejects.toMatchObject({ statusCode: 400 });
    const many = Object.fromEntries(Array.from({ length: 61 }, (_, index) => [`margin-chat:s${index}`, "1"]));
    await expect(service.save({ userId: "u1", body: { values: many } })).rejects.toMatchObject({ statusCode: 413 });
    expect(await service.read({ userId: "u1" })).toEqual({ values: {} });
  }, 30_000);
});

/** A browser just big enough for the settings modules: storage, events, and a fake account. */
function fakeBrowser(account: Record<string, string>) {
  const store = new Map<string, string>();
  const windowEvents = new EventTarget();
  const documentEvents = new EventTarget();
  const sent: Array<Record<string, string | null>> = [];
  class FakeStorageEvent extends Event {
    key: string | null; oldValue: string | null; newValue: string | null;
    constructor(type: string, init: { key?: string | null; oldValue?: string | null; newValue?: string | null } = {}) {
      super(type); this.key = init.key ?? null; this.oldValue = init.oldValue ?? null; this.newValue = init.newValue ?? null;
    }
  }
  const globals = globalThis as Record<string, unknown>;
  const previous = { localStorage: globals.localStorage, window: globals.window, document: globals.document, StorageEvent: globals.StorageEvent };
  globals.localStorage = { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => { store.set(key, value); }, removeItem: (key: string) => store.delete(key) };
  globals.window = { addEventListener: windowEvents.addEventListener.bind(windowEvents), removeEventListener: windowEvents.removeEventListener.bind(windowEvents), dispatchEvent: windowEvents.dispatchEvent.bind(windowEvents) };
  globals.document = { visibilityState: "visible", addEventListener: documentEvents.addEventListener.bind(documentEvents), removeEventListener: documentEvents.removeEventListener.bind(documentEvents) };
  globals.StorageEvent = FakeStorageEvent;
  setApiTransport({ fetch: (async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "POST") {
      const values = JSON.parse(String(init.body)).values as Record<string, string | null>;
      sent.push(values);
      for (const [name, value] of Object.entries(values)) value === null ? delete account[name] : account[name] = value;
    }
    return new Response(JSON.stringify({ values: { ...account } }), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch });
  return {
    store, sent,
    restore() { Object.assign(globals, previous); setApiTransport(null); },
  };
}

const settle = (ms = 0) => new Promise((done) => setTimeout(done, ms));

describe("interface settings sync on a device", () => {
  let browser: ReturnType<typeof fakeBrowser> | null = null;
  let stop: (() => void) | null = null;
  beforeEach(() => { browser = null; stop = null; });
  afterEach(() => { stop?.(); browser?.restore(); });

  test("the account's settings win on a new device and tell what shows them", async () => {
    browser = fakeBrowser({ "margin-chat-theme": "light", [FEATURES_KEY]: "{\"flashcards\":true}" });
    browser.store.set("margin-chat-theme", "dark");
    const changed: string[] = [];
    const off = onSyncedSettingChange(["margin-chat-theme"], () => changed.push("theme"));
    stop = startInterfaceSettingsSync("u1");
    await settle();
    expect(browser.store.get("margin-chat-theme")).toBe("light");
    expect(readFeatures().flashcards).toBe(true);
    expect(changed).toEqual(["theme"]);
    off();
  });

  test("a device's own settings seed an empty account, and later changes send only what changed", async () => {
    browser = fakeBrowser({});
    browser.store.set("margin-chat:quiet-page", "false");
    stop = startInterfaceSettingsSync("u1");
    await settle(700);
    expect(browser.sent).toEqual([{ "margin-chat:quiet-page": "false" }]);
    setFeature("voice", true);
    writeSyncedSetting("margin-chat-theme", "dark");
    await settle(700);
    const last = browser.sent.at(-1)!;
    expect(Object.keys(last).sort()).toEqual(["margin-chat-theme", FEATURES_KEY].sort());
    expect(last["margin-chat-theme"]).toBe("dark");
    expect(parseFeatures(last[FEATURES_KEY])).toEqual({ flashcards: false, roadmaps: false, boards: false, claims: false, voice: true, groups: false, spaces: false, outline: false, tiles: false, mapTools: false });
    // Writing the value the account already has sends nothing.
    const before = browser.sent.length;
    writeSyncedSetting("margin-chat-theme", "dark");
    await settle(700);
    expect(browser.sent.length).toBe(before);
  });
});

describe("features", () => {
  let browser: ReturnType<typeof fakeBrowser> | null = null;
  afterEach(() => browser?.restore());

  test("start with everything off and read unknown or broken values as off", () => {
    browser = fakeBrowser({});
    expect(hasFeatureChoices()).toBe(false);
    expect(Object.values(readFeatures()).every((on) => !on)).toBe(true);
    expect(parseFeatures("{\"voice\":\"yes\",\"boards\":true,\"sparkles\":true}")).toEqual({ flashcards: false, roadmaps: false, boards: true, claims: false, voice: false, groups: false, spaces: false, outline: false, tiles: false, mapTools: false });
    expect(parseFeatures("not json").boards).toBe(false);
    expect(parseFeatures("[true]").boards).toBe(false);
  });

  test("presets set every switch, and the matching preset is found again", () => {
    browser = fakeBrowser({});
    applyFeaturePreset("student");
    expect(readFeatures()).toEqual({ flashcards: true, roadmaps: false, boards: false, claims: false, voice: true, groups: false, spaces: false, outline: true, tiles: false, mapTools: false });
    expect(matchingPreset(readFeatures())).toBe("student");
    setFeature("boards", true);
    expect(matchingPreset(readFeatures())).toBeNull();
    applyFeaturePreset("everything");
    expect(matchingPreset(readFeatures())).toBe("everything");
    applyFeaturePreset("simple");
    expect(matchingPreset(readFeatures())).toBe("simple");
    expect(hasFeatureChoices()).toBe(true);
  });

  test("an existing account keeps on only what it already uses", () => {
    expect(featuresFromUsage({ roadmaps: true, boards: false, flashcards: true, groups: true }))
      .toEqual({ flashcards: true, roadmaps: true, boards: false, claims: false, voice: false, groups: true, spaces: false, outline: false, tiles: false, mapTools: false });
  });

  test("a feature added after the choice was saved is still unchosen, and only it", () => {
    browser = fakeBrowser({});
    expect(unchosenFeatures().length).toBe(10);
    localStorage.setItem(FEATURES_KEY, JSON.stringify({ flashcards: true, roadmaps: false, boards: false, claims: false, voice: false }));
    expect(unchosenFeatures().sort()).toEqual(["groups", "mapTools", "outline", "spaces", "tiles"]);
    saveFeatures({ groups: true, spaces: false, outline: false, tiles: false, mapTools: false });
    expect(unchosenFeatures()).toEqual([]);
    expect(readFeatures().flashcards).toBe(true);
  });
});
