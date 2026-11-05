/**
 * The Postgres projection of line authorship: a row per revision, the current
 * revision's lines and one summary per document. The sidecars in cloud storage
 * are the record; these rows are rebuilt from them.
 */

/** Records one revision and, when it is the document's newest, replaces its lines and summary. */
export async function recordDocumentProvenance(client, { userId, documentId, revision, lines, summary, current = true }) {
  await client.query("begin");
  try {
    await client.query(
      `insert into marginchat_document_revisions
         (user_id, document_id, revision_key, revision_id, parent_revision_id, vault_revision,
          actor_type, actor_id, actor_label, source, reason, created_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       on conflict (user_id, document_id, revision_key) do nothing`,
      [userId, documentId, revision.revisionKey, revision.revisionId, revision.parentRevisionId ?? null, revision.vaultRevision,
        revision.actor.type, revision.actor.id ?? null, revision.actor.label ?? null, revision.source, revision.reason ?? null, revision.createdAt],
    );
    if (current) {
      // A slower save of an older revision never replaces a newer one's lines.
      const newer = await client.query(
        `select 1 from marginchat_document_authorship a
         join marginchat_document_revisions r on r.user_id = a.user_id and r.document_id = a.document_id and r.revision_key = a.revision_key
         where a.user_id = $1 and a.document_id = $2 and r.vault_revision > $3`,
        [userId, documentId, revision.vaultRevision],
      );
      if (!newer.rows.length) {
        await client.query("delete from marginchat_line_authorship where user_id = $1 and document_id = $2", [userId, documentId]);
        if (lines.length) {
          await client.query(
            `insert into marginchat_line_authorship
               (user_id, document_id, block_id, line_index, sha256, author_type, author_id, author_label, origin_revision_id)
             select $1, $2, * from unnest($3::text[], $4::int[], $5::text[], $6::text[], $7::text[], $8::text[], $9::text[])`,
            [userId, documentId, lines.map((line) => line.blockId), lines.map((line) => line.i), lines.map((line) => line.sha256),
              lines.map((line) => line.author.type), lines.map((line) => line.author.id ?? null), lines.map((line) => line.author.label ?? null),
              lines.map((line) => line.originRevisionId)],
          );
        }
        await client.query(
          `insert into marginchat_document_authorship
             (user_id, document_id, revision_key, revision_id, human_lines, ai_lines, agent_lines, import_lines, system_lines,
              unknown_lines, total_lines, last_actor_type, last_actor_label, updated_at)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, now())
           on conflict (user_id, document_id) do update set revision_key = excluded.revision_key, revision_id = excluded.revision_id,
             human_lines = excluded.human_lines, ai_lines = excluded.ai_lines, agent_lines = excluded.agent_lines,
             import_lines = excluded.import_lines, system_lines = excluded.system_lines, unknown_lines = excluded.unknown_lines,
             total_lines = excluded.total_lines, last_actor_type = excluded.last_actor_type, last_actor_label = excluded.last_actor_label,
             updated_at = now()`,
          [userId, documentId, revision.revisionKey, revision.revisionId, summary.humanLines, summary.aiLines, summary.agentLines,
            summary.importLines, summary.systemLines, summary.unknownLines, summary.totalLines,
            revision.actor.type, revision.actor.label ?? null],
        );
      }
    }
    await client.query("commit");
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  }
}

/** Authorship totals for these documents, keyed by document id. */
export async function readDocumentAuthorship(client, { userId, documentIds }) {
  if (!documentIds?.length) return {};
  const result = await client.query(
    `select document_id, revision_id, human_lines, ai_lines, agent_lines, import_lines, system_lines, unknown_lines, total_lines,
       last_actor_type, last_actor_label
     from marginchat_document_authorship where user_id = $1 and document_id = any($2::text[])`,
    [userId, documentIds],
  );
  return Object.fromEntries(result.rows.map((row) => [row.document_id, {
    revisionId: row.revision_id,
    humanLines: row.human_lines, aiLines: row.ai_lines, agentLines: row.agent_lines, importLines: row.import_lines,
    systemLines: row.system_lines, unknownLines: row.unknown_lines, totalLines: row.total_lines,
    lastActor: row.last_actor_type ? { type: row.last_actor_type, label: row.last_actor_label } : null,
  }]));
}
