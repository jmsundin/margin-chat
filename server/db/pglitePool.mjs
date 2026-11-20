/**
 * A node-postgres-shaped pool over PGlite, the Postgres that runs inside this process.
 * The desktop app's local mode keeps its database in a folder on the computer with it,
 * so the same repositories and migrations run with no database server and no account.
 *
 * PGlite has one connection, so a lease holds it until release(): a transaction begun on
 * one client can never interleave with another request's queries.
 */
export function createPglitePool({ dataDir, load = loadPglite } = {}) {
  let databasePromise = null;
  let tail = Promise.resolve();
  let closed = false;

  function database() {
    databasePromise ??= load(dataDir).catch((error) => {
      databasePromise = null;
      throw error;
    });
    return databasePromise;
  }

  async function run(pg, sql, params) {
    // Migrations send whole files of statements without parameters; exec() runs them all.
    const result = params === undefined && sql.includes(";")
      ? (await pg.exec(sql)).at(-1) ?? { rows: [], fields: [] }
      : await pg.query(sql, params ?? []);
    return { ...result, rowCount: result.rows.length || result.affectedRows || 0 };
  }

  /** Waits for the connection, then hands it out until release(). */
  async function connect() {
    if (closed) throw new Error("The local database is closed.");
    let release;
    const turn = new Promise((resolve) => { release = resolve; });
    const previous = tail;
    tail = previous.then(() => turn);
    await previous;
    let pg;
    try {
      pg = await database();
    } catch (error) {
      release();
      throw error;
    }
    let released = false;
    return {
      query: (sql, params) => {
        if (released) throw new Error("This database client was already released.");
        return run(pg, typeof sql === "string" ? sql : sql.text, typeof sql === "string" ? params : sql.values);
      },
      async release(error) {
        if (released) return;
        released = true;
        // A failed lease may have left a transaction open; end it before the next request.
        if (error) await pg.query("rollback").catch(() => undefined);
        release();
      },
    };
  }

  return {
    connect,
    async query(sql, params) {
      const client = await connect();
      try {
        return await client.query(sql, params);
      } finally {
        await client.release();
      }
    },
    async end() {
      closed = true;
      await tail;
      if (databasePromise) await (await databasePromise.catch(() => null))?.close();
      databasePromise = null;
    },
  };
}

async function loadPglite(dataDir) {
  const [{ PGlite }, { vector }] = await Promise.all([
    import("@electric-sql/pglite"),
    import("@electric-sql/pglite-pgvector"),
  ]);
  const pg = new PGlite(dataDir ? { dataDir, extensions: { vector } } : { extensions: { vector } });
  await pg.waitReady;
  return pg;
}
