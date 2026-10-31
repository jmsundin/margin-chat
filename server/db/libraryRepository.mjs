import { fromWorkspaceEntityId } from "./repository.mjs";

/** Literature library storage (migration 0025): public papers, the reader's fields and their layouts. */

async function sessionIdFor(client, userId) {
  const session = await client.query("select id from marginchat_app_sessions where user_id = $1 limit 1", [userId]);
  return session.rowCount ? session.rows[0].id : null;
}

const fieldRow = (row) => ({
  id: row.id, query: row.query, source: row.source, target: Number(row.target),
  available: row.available === null ? null : Number(row.available), fetched: Number(row.fetched),
  works: Number(row.works ?? 0), embedded: Number(row.embedded ?? 0),
  regions: Array.isArray(row.regions) ? row.regions : JSON.parse(row.regions ?? "[]"),
  laidOutAt: row.laid_out_at ? new Date(row.laid_out_at).toISOString() : null,
  createdAt: new Date(row.created_at).toISOString(),
});

const FIELD_COLUMNS = `f.*, (select count(*) from marginchat_library_field_works fw where fw.field_id = f.id) as works,
  (select count(*) from marginchat_library_field_works fw join marginchat_library_works w on w.id = fw.work_id
   where fw.field_id = f.id and w.vector is not null) as embedded`;

export async function listLibraryFields(client, { userId }) {
  const sessionId = await sessionIdFor(client, userId);
  if (!sessionId) return [];
  const rows = await client.query(`select ${FIELD_COLUMNS} from marginchat_library_fields f where f.session_id = $1 order by f.created_at`, [sessionId]);
  return rows.rows.map(fieldRow);
}

export async function readLibraryField(client, { userId, fieldId }) {
  const sessionId = await sessionIdFor(client, userId);
  if (!sessionId) return null;
  const rows = await client.query(`select ${FIELD_COLUMNS} from marginchat_library_fields f where f.session_id = $1 and f.id = $2`, [sessionId, fieldId]);
  return rows.rowCount ? fieldRow(rows.rows[0]) : null;
}

export async function createLibraryField(client, { userId, id, query, target }) {
  const sessionId = await sessionIdFor(client, userId);
  if (!sessionId) return null;
  await client.query("insert into marginchat_library_fields (id, session_id, query, target) values ($1, $2, $3, $4)", [id, sessionId, query, target]);
  return readLibraryField(client, { userId, fieldId: id });
}

export async function deleteLibraryField(client, { userId, fieldId }) {
  const sessionId = await sessionIdFor(client, userId);
  if (!sessionId) return false;
  const result = await client.query("delete from marginchat_library_fields where session_id = $1 and id = $2", [sessionId, fieldId]);
  return result.rowCount > 0;
}

/** Stores papers; one already stored keeps its vector unless its text changed. */
export async function saveLibraryWorks(client, { works }) {
  for (const work of works) {
    await client.query(
      `insert into marginchat_library_works (id, title, abstract, year, journal, doi, authors, topics)
       values ($1, $2, $3, $4, $5, $6, $7, $8::text[])
       on conflict (id) do update set title = excluded.title, abstract = excluded.abstract, year = excluded.year,
         journal = excluded.journal, doi = excluded.doi, authors = excluded.authors, topics = excluded.topics, fetched_at = now(),
         vector = case when marginchat_library_works.title = excluded.title and marginchat_library_works.abstract = excluded.abstract
           then marginchat_library_works.vector else null end`,
      [work.id, work.title, work.abstract, work.year, work.journal, work.doi, work.authors, work.topics],
    );
  }
}

export async function linkLibraryWorks(client, { fieldId, ids, startRank, fetched, available }) {
  if (ids.length) await client.query(
    `insert into marginchat_library_field_works (field_id, work_id, rank)
     select $1, id, $3 + ordinality - 1 from unnest($2::text[]) with ordinality as w(id, ordinality)
     on conflict (field_id, work_id) do nothing`,
    [fieldId, ids, startRank],
  );
  await client.query("update marginchat_library_fields set fetched = $2, available = $3 where id = $1", [fieldId, fetched, available]);
}

export async function listUnembeddedLibraryWorks(client, { fieldId, model, limit }) {
  const rows = await client.query(
    `select w.id, w.title, w.abstract from marginchat_library_field_works fw join marginchat_library_works w on w.id = fw.work_id
     where fw.field_id = $1 and (w.vector is null or w.embedding_model is distinct from $2) order by fw.rank limit $3`,
    [fieldId, model, limit],
  );
  return rows.rows;
}

export async function saveLibraryVectors(client, { model, vectors }) {
  for (const { id, vector } of vectors) {
    await client.query("update marginchat_library_works set vector = $2::halfvec, embedding_model = $3 where id = $1",
      [id, `[${vector.map((value) => Number(value).toFixed(5)).join(",")}]`, model]);
  }
}

/** Each paper's nearest papers of the same field, searched exactly (a field holds at most 5,000). */
export async function readLibraryNeighbours(client, { fieldId, perWork }) {
  const rows = await client.query(
    `select s.work_id, near.work_id as neighbour_id, 1 - near.distance as similarity
     from marginchat_library_field_works s
     join marginchat_library_works sw on sw.id = s.work_id
     cross join lateral (
       select fw.work_id, w.vector <=> sw.vector as distance
       from marginchat_library_field_works fw join marginchat_library_works w on w.id = fw.work_id
       where fw.field_id = $1 and fw.work_id <> s.work_id and w.vector is not null
       order by w.vector <=> sw.vector
       limit $2) near
     where s.field_id = $1 and sw.vector is not null`,
    [fieldId, perWork],
  );
  const lists = new Map();
  for (const row of rows.rows) (lists.get(row.work_id) ?? lists.set(row.work_id, []).get(row.work_id)).push({ id: row.neighbour_id, similarity: Number(row.similarity) });
  return lists;
}

export async function writeLibraryLayout(client, { fieldId, positions, regions }) {
  await client.query("begin");
  try {
    await client.query("update marginchat_library_field_works set x = null, y = null, region = -1 where field_id = $1", [fieldId]);
    for (let start = 0; start < positions.length; start += 5000) {
      const batch = positions.slice(start, start + 5000);
      await client.query(
        `update marginchat_library_field_works fw set x = p.x, y = p.y, region = p.region
         from unnest($2::text[], $3::real[], $4::real[], $5::int[]) as p(id, x, y, region)
         where fw.field_id = $1 and fw.work_id = p.id`,
        [fieldId, batch.map((entry) => entry.id), batch.map((entry) => entry.x), batch.map((entry) => entry.y), batch.map((entry) => entry.region)],
      );
    }
    await client.query("update marginchat_library_fields set regions = $2::jsonb, laid_out_at = now() where id = $1", [fieldId, JSON.stringify(regions)]);
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  }
}

const mapWorks = (rows) => rows.map((row) => ({ id: row.id, title: row.title, year: row.year === null ? null : Number(row.year),
  topics: row.topics ?? [], x: Number(row.x), y: Number(row.y), region: Number(row.region) }));

/** The laid-out papers of a field, and for each of the reader's documents its nearest papers there. */
export async function readLibraryMap(client, { userId, fieldId, perDocument }) {
  const sessionId = await sessionIdFor(client, userId);
  if (!sessionId) return { works: [], own: [] };
  const works = await client.query(
    `select w.id, w.title, w.year, w.topics, fw.x, fw.y, fw.region from marginchat_library_field_works fw
     join marginchat_library_works w on w.id = fw.work_id
     join marginchat_library_fields f on f.id = fw.field_id
     where fw.field_id = $1 and f.session_id = $2 and fw.x is not null order by fw.rank`,
    [fieldId, sessionId],
  );
  if (!perDocument) return { works: mapWorks(works.rows), own: [] };
  const own = await client.query(
    `select e.conversation_id, near.work_id, 1 - near.distance as similarity
     from marginchat_topic_embeddings e
     cross join lateral (
       select fw.work_id, w.vector <=> e.vector as distance
       from marginchat_library_field_works fw join marginchat_library_works w on w.id = fw.work_id
       where fw.field_id = $1 and fw.x is not null and w.vector is not null
       order by w.vector <=> e.vector
       limit $3) near
     where e.session_id = $2 and e.vector is not null`,
    [fieldId, sessionId, perDocument],
  );
  const lists = new Map();
  for (const row of own.rows) {
    const id = fromWorkspaceEntityId(sessionId, row.conversation_id);
    (lists.get(id) ?? lists.set(id, []).get(id)).push({ id: row.work_id, similarity: Number(row.similarity) });
  }
  return {
    works: mapWorks(works.rows),
    own: [...lists].map(([id, neighbours]) => ({ id, neighbours: neighbours.sort((a, b) => b.similarity - a.similarity) })),
  };
}

/** One paper, if it is in one of the reader's fields. */
export async function readLibraryWork(client, { userId, workId }) {
  const sessionId = await sessionIdFor(client, userId);
  if (!sessionId) return null;
  const rows = await client.query(
    `select w.id, w.title, w.abstract, w.year, w.journal, w.doi, w.authors, w.topics from marginchat_library_works w
     where w.id = $1 and exists (select 1 from marginchat_library_field_works fw join marginchat_library_fields f on f.id = fw.field_id
       where fw.work_id = w.id and f.session_id = $2)`,
    [workId, sessionId],
  );
  if (!rows.rowCount) return null;
  const row = rows.rows[0];
  return { id: row.id, title: row.title, abstract: row.abstract, year: row.year === null ? null : Number(row.year), journal: row.journal,
    doi: row.doi, authors: row.authors, topics: row.topics ?? [] };
}

/** Every paper of a field with its PubMed major topics, laid out or not. */
export async function readLibraryWorkTopics(client, { fieldId }) {
  const rows = await client.query(
    "select w.id, w.topics from marginchat_library_field_works fw join marginchat_library_works w on w.id = fw.work_id where fw.field_id = $1", [fieldId]);
  return new Map(rows.rows.map((row) => [row.id, row.topics ?? []]));
}
