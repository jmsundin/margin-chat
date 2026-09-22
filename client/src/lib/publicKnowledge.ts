import { isPublicMetadataProperty } from "./publicRelationFilters";

export interface PublicTopic {
  id: string;
  /** Previously requested Wikidata IDs which redirect to this item. */
  aliases: string[];
  label: string;
  description: string;
  wikidataUrl: string;
  wikipediaUrl?: string;
  retrievedAt: string;
  revision?: number;
}

export interface PublicRelation {
  id: string;
  sourceId: string;
  targetId: string;
  propertyId: string;
  label: string;
  sourceUrl: string;
}

export interface PublicExpansion {
  topic: PublicTopic;
  topics: PublicTopic[];
  relations: PublicRelation[];
  hasMore: boolean;
  /** Offset into direct statements, including skipped missing or duplicate targets. */
  nextOffset: number;
}

const API_URL = "https://www.wikidata.org/w/api.php";
const PAGE_SIZE = 10;
const SEARCH_LIMIT = 12;
const CACHE_TTL = 5 * 60_000;
const CACHE_LIMIT = 256;
const REQUEST_TIMEOUT = 15_000;
const ITEM_ID = /^Q[1-9]\d*$/;
const PROPERTY_ID = /^P[1-9]\d*$/;
const ENTITY_ID = /^[QP][1-9]\d*$/;
const PROPERTY_PRIORITY = ["P279", "P31", "P361", "P527", "P921", "P1269", "P1552", "P138"];
const PROPERTY_LABELS: Record<string, string> = {
  P279: "subclass of", P31: "instance of", P361: "part of", P527: "has part(s)",
  P921: "main subject", P1269: "facet of", P1552: "has quality", P138: "named after",
};

type JsonObject = Record<string, unknown>;
interface DirectStatement { propertyId: string; targetId: string }
interface Entity {
  topic: PublicTopic;
  statements?: DirectStatement[];
  expiresAt: number;
}
// Alias entries point at the same entity as its canonical entry. Only successful
// reads are cached, and returned topics are copied so UI edits cannot alter them.
const entityCache = new Map<string, Entity>();

function object(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : undefined;
}

function itemId(id: string): string {
  const normalized = id.trim().toUpperCase();
  if (!ITEM_ID.test(normalized)) throw new Error("Choose a valid Wikidata topic to explore.");
  return normalized;
}

function checkAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new DOMException("Request cancelled.", "AbortError");
}

async function requestApi(params: Record<string, string>, signal?: AbortSignal): Promise<JsonObject> {
  checkAborted(signal);
  const url = new URL(API_URL);
  url.search = new URLSearchParams({ ...params, format: "json", origin: "*" }).toString();
  const controller = new AbortController();
  let timedOut = false;
  const onAbort = () => controller.abort(signal?.reason);
  signal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, REQUEST_TIMEOUT);
  try {
    const response = await fetch(url.toString(), {
      signal: controller.signal, credentials: "omit", referrerPolicy: "no-referrer",
      headers: { Accept: "application/json" },
    });
    checkAborted(signal);
    if (!response.ok) {
      if (response.status === 429) throw new Error("Wikidata is receiving too many requests. Please try again shortly.");
      throw new Error(`Wikidata is temporarily unavailable (${response.status}). Please try again.`);
    }
    let payload: JsonObject | undefined;
    try { payload = object(await response.json()); }
    catch { checkAborted(signal); throw new Error("Wikidata returned an unreadable response. Please try again."); }
    checkAborted(signal);
    if (!payload) throw new Error("Wikidata returned an invalid response. Please try again.");
    const apiError = object(payload.error);
    if (apiError) {
      const code = typeof apiError.code === "string" ? apiError.code : "unknown";
      throw new Error(`Wikidata could not complete this request (${code}). Please try again shortly.`);
    }
    return payload;
  } catch (error) {
    checkAborted(signal);
    if (timedOut) throw new Error("Wikidata took too long to respond. Please try again.");
    if (error instanceof TypeError) throw new Error("Could not reach Wikidata. Check your connection and try again.");
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

function localizedText(value: unknown): string {
  const values = object(value);
  for (const language of ["en", "mul"]) {
    const text = object(values?.[language])?.value;
    if (typeof text === "string" && text.trim()) return text.trim();
  }
  return "";
}

function directStatements(claims: unknown): DirectStatement[] {
  const statements: DirectStatement[] = [];
  const seen = new Set<string>();
  for (const [propertyId, values] of Object.entries(object(claims) ?? {})) {
    if (!PROPERTY_ID.test(propertyId) || !Array.isArray(values)) continue;
    for (const value of values) {
      const statement = object(value);
      if (!statement || statement.rank === "deprecated") continue;
      const snak = object(statement.mainsnak);
      const data = object(snak?.datavalue);
      const target = object(data?.value);
      if (snak?.snaktype !== "value" || snak.datatype !== "wikibase-item" || data?.type !== "wikibase-entityid" || target?.["entity-type"] !== "item") continue;
      const targetId = typeof target.id === "string" ? target.id :
        Number.isSafeInteger(target["numeric-id"]) && Number(target["numeric-id"]) > 0 ? `Q${target["numeric-id"]}` : "";
      const key = `${propertyId}:${targetId}`;
      if (!ITEM_ID.test(targetId) || seen.has(key)) continue;
      seen.add(key);
      statements.push({ propertyId, targetId });
    }
  }
  const priority = (id: string) => {
    const index = PROPERTY_PRIORITY.indexOf(id);
    return index < 0 ? PROPERTY_PRIORITY.length + Number(isPublicMetadataProperty(id)) : index;
  };
  // Source statement order can change between reads. Use a predictable order
  // which places conceptual relationships first and Wikimedia metadata last.
  // Retain every statement: display filters never change pagination or caching.
  return statements.sort((a, b) => priority(a.propertyId) - priority(b.propertyId)
    || a.propertyId.localeCompare(b.propertyId, "en", { numeric: true })
    || a.targetId.localeCompare(b.targetId, "en", { numeric: true }));
}

function cachedEntity(id: string, withStatements: boolean): Entity | undefined {
  const cached = entityCache.get(id);
  if (!cached) return undefined;
  if (cached.expiresAt <= Date.now()) { entityCache.delete(id); return undefined; }
  return !withStatements || cached.statements !== undefined ? cached : undefined;
}

function cacheEntity(requestedId: string, raw: JsonObject, withStatements: boolean, retrievedAt: string): Entity | undefined {
  if ("missing" in raw) return undefined;
  if (typeof raw.id !== "string" || !ENTITY_ID.test(raw.id) || raw.id[0] !== requestedId[0]) {
    throw new Error("Wikidata returned an invalid topic. Please try again.");
  }
  const id = raw.id;
  const previous = cachedEntity(id, false);
  const redirect = object(raw.redirects);
  const aliases = new Set(previous?.topic.aliases ?? []);
  if (requestedId !== id) aliases.add(requestedId);
  if (typeof redirect?.from === "string" && ENTITY_ID.test(redirect.from) && redirect.from !== id) aliases.add(redirect.from);
  const sitelink = object(object(raw.sitelinks)?.enwiki);
  const title = typeof sitelink?.title === "string" ? sitelink.title : "";
  // Build the URL from the official sitelink title; do not follow arbitrary URLs
  // embedded in statement values or external identifiers.
  const wikipediaUrl = title ? `https://en.wikipedia.org/wiki/${encodeURIComponent(title.replaceAll(" ", "_"))}` : undefined;
  const revision = typeof raw.lastrevid === "number" && Number.isSafeInteger(raw.lastrevid) ? raw.lastrevid : undefined;
  const entity: Entity = {
    topic: {
      id, aliases: [...aliases].sort(), label: localizedText(raw.labels) || id,
      description: localizedText(raw.descriptions), wikidataUrl: `https://www.wikidata.org/wiki/${id}`,
      ...(wikipediaUrl ? { wikipediaUrl } : {}), retrievedAt, ...(revision === undefined ? {} : { revision }),
    },
    statements: withStatements ? directStatements(raw.claims)
      : previous?.topic.revision === revision ? previous?.statements : undefined,
    expiresAt: Date.now() + CACHE_TTL,
  };
  for (const key of [id, ...aliases]) { entityCache.delete(key); entityCache.set(key, entity); }
  while (entityCache.size > CACHE_LIMIT) entityCache.delete(entityCache.keys().next().value!);
  return entity;
}

/** Each call performs at most one batch, below the public API's 50-ID limit. */
async function readEntities(ids: string[], withStatements: boolean, signal?: AbortSignal): Promise<Map<string, Entity>> {
  checkAborted(signal);
  const uniqueIds = [...new Set(ids)];
  const result = new Map<string, Entity>();
  const missing = uniqueIds.filter((id) => {
    const entity = cachedEntity(id, withStatements);
    if (entity) result.set(id, entity);
    return !entity;
  });
  if (missing.length) {
    if (missing.length > 50) throw new Error("Please explore a smaller set of public topics.");
    const payload = await requestApi({
      action: "wbgetentities", ids: missing.join("|"), redirects: "yes",
      props: `info|labels|descriptions|sitelinks/urls${withStatements ? "|claims" : ""}`,
      languages: "en|mul", languagefallback: "1", sitefilter: "enwiki",
    }, signal);
    const entities = object(payload.entities);
    if (!entities) throw new Error("Wikidata returned an invalid topic list. Please try again.");
    const retrievedAt = new Date().toISOString();
    for (const id of missing) {
      const raw = object(entities[id]);
      if (!raw) continue;
      const entity = cacheEntity(id, raw, withStatements, retrievedAt);
      if (entity) result.set(id, entity);
    }
  }
  // A batch may contain both an alias and its canonical ID. Use the final cache
  // entry so both return the complete set of aliases learned in that batch.
  for (const [id, entity] of result) result.set(id, cachedEntity(entity.topic.id, withStatements) ?? entity);
  return result;
}

function topicCopy(entity: Entity): PublicTopic {
  return { ...entity.topic, aliases: [...entity.topic.aliases] };
}

export async function searchPublicTopics(query: string, signal?: AbortSignal): Promise<PublicTopic[]> {
  checkAborted(signal);
  const search = query.trim();
  if (!search) return [];
  const payload = await requestApi({
    action: "wbsearchentities", search: search.slice(0, 200), language: "en", uselang: "en", type: "item", limit: String(SEARCH_LIMIT),
  }, signal);
  if (!Array.isArray(payload.search)) throw new Error("Wikidata returned invalid search results. Please try again.");
  const ids = [...new Set(payload.search.flatMap((value) => {
    const id = object(value)?.id;
    return typeof id === "string" && ITEM_ID.test(id) ? [id] : [];
  }))].slice(0, SEARCH_LIMIT);
  const entities = await readEntities(ids, false, signal);
  const topics = new Map<string, PublicTopic>();
  for (const id of ids) {
    const entity = entities.get(id);
    if (entity) topics.set(entity.topic.id, topicCopy(entity));
  }
  return [...topics.values()];
}

export async function getPublicTopic(id: string, signal?: AbortSignal): Promise<PublicTopic> {
  const requestedId = itemId(id);
  const entities = await readEntities([requestedId], false, signal);
  const entity = entities.get(requestedId);
  if (!entity) throw new Error("This Wikidata topic is no longer available. Try searching for it again.");
  return topicCopy(entity);
}

export async function expandPublicTopic(id: string, offset = 0, signal?: AbortSignal): Promise<PublicExpansion> {
  const requestedId = itemId(id);
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("Choose a valid public map page.");
  const source = (await readEntities([requestedId], true, signal)).get(requestedId);
  if (!source) throw new Error("This Wikidata topic is no longer available. Try searching for it again.");
  const statements = source.statements ?? [];
  const page = statements.slice(offset, offset + PAGE_SIZE);
  const entities = await readEntities(page.flatMap((statement) => [statement.targetId, statement.propertyId]), false, signal);
  const topics = new Map<string, PublicTopic>();
  const relations = new Map<string, PublicRelation>();
  for (const statement of page) {
    const target = entities.get(statement.targetId);
    if (!target || target.topic.id === source.topic.id) continue;
    const property = entities.get(statement.propertyId)?.topic;
    const relationId = `${source.topic.id}:${statement.propertyId}:${target.topic.id}`;
    topics.set(target.topic.id, topicCopy(target));
    relations.set(relationId, {
      id: relationId, sourceId: source.topic.id, targetId: target.topic.id, propertyId: statement.propertyId,
      label: property && property.label !== property.id ? property.label : PROPERTY_LABELS[statement.propertyId] ?? `Related via ${statement.propertyId}`,
      sourceUrl: `${source.topic.wikidataUrl}#${statement.propertyId}`,
    });
  }
  const nextOffset = Math.min(offset + PAGE_SIZE, statements.length);
  return { topic: topicCopy(source), topics: [...topics.values()], relations: [...relations.values()], hasMore: nextOffset < statements.length, nextOffset };
}
