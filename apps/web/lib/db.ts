/**
 * Database access. Uses Postgres (node-postgres) when DATABASE_URL is set,
 * otherwise an embedded Postgres (PGlite) stored in ./.data for local dev.
 * Set DATABASE_URL=memory:// for a throwaway in-memory database (tests).
 */
import { SCHEMA_SQL } from './schema';

export interface Db {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  tx<R>(fn: (q: Db) => Promise<R>): Promise<R>;
}

// Next.js bundles pages and route handlers separately, so a module-level
// variable would give each its own connection (and, locally, two embedded
// databases fighting over one folder). Keep one per process on globalThis.
const g = globalThis as typeof globalThis & { __dsDb?: Promise<Db> | null };

export function getDb(): Promise<Db> {
  if (!g.__dsDb) {
    g.__dsDb = connect().catch((err) => {
      g.__dsDb = null;
      throw err;
    });
  }
  return g.__dsDb;
}

async function connect(): Promise<Db> {
  const url = process.env.DATABASE_URL;
  const db = url && !url.startsWith('memory://') ? await connectPg(url) : await connectPglite(url);
  await db.query(SCHEMA_SQL);
  return db;
}

async function connectPg(url: string): Promise<Db> {
  const { Pool } = await import('pg');
  const internal = /\.railway\.internal|localhost|127\.0\.0\.1/.test(url);
  const pool = new Pool({ connectionString: url, max: 5, ssl: internal ? undefined : { rejectUnauthorized: false } });
  const run = async <T,>(client: { query: (s: string, p?: unknown[]) => Promise<{ rows: unknown[] }> }, sql: string, params?: unknown[]) =>
    ({ rows: (await client.query(sql, params)).rows as T[] });
  const db: Db = {
    query: (sql, params) => run(pool, sql, params),
    async tx(fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const inner: Db = { query: (s, p) => run(client, s, p), tx: (f) => f(inner) };
        const result = await fn(inner);
        await client.query('COMMIT');
        return result;
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    },
  };
  return db;
}

async function connectPglite(url?: string): Promise<Db> {
  const { PGlite } = await import('@electric-sql/pglite');
  const pg = url?.startsWith('memory://') ? new PGlite() : new PGlite(process.env.PGLITE_DIR || './.data/pglite');
  await pg.waitReady;
  // PGlite runs one statement at a time; serialise to keep transactions safe.
  let chain: Promise<unknown> = Promise.resolve();
  const serial = <R,>(fn: () => Promise<R>): Promise<R> => {
    const next = chain.then(fn, fn);
    chain = next.catch(() => undefined);
    return next;
  };
  const raw: Db = {
    async query<T>(sql: string, params?: unknown[]) {
      if (!params || params.length === 0) {
        const results = await pg.exec(sql);
        return { rows: (results[results.length - 1]?.rows ?? []) as T[] };
      }
      return { rows: (await pg.query<T>(sql, params)).rows };
    },
    tx: (fn) => fn(raw),
  };
  return {
    query: (sql, params) => serial(() => raw.query(sql, params)),
    tx: (fn) =>
      serial(async () => {
        await raw.query('BEGIN');
        try {
          const r = await fn(raw);
          await raw.query('COMMIT');
          return r;
        } catch (err) {
          await raw.query('ROLLBACK');
          throw err;
        }
      }),
  };
}

/** Random URL-safe id. */
export function newId(bytes = 16): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(bytes))).toString('base64url');
}
