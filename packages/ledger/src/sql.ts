import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';

/** Small query surface shared by PGlite and node-postgres. */
export interface Sql {
  exec(statement: string): Promise<void>;
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    statement: string,
    params?: unknown[],
  ): Promise<T[]>;
  transaction<T>(fn: (sql: Sql) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

interface Executor {
  exec(statement: string): Promise<unknown>;
  query(statement: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  transaction?<T>(fn: (tx: Executor) => Promise<T>): Promise<T>;
  close?(): Promise<void>;
}

/**
 * databaseUrl (argument or DATABASE_URL) uses Postgres.
 * dataDir uses a file-backed PGlite. Otherwise the database is in memory.
 */
export async function openSql(options?: { databaseUrl?: string; dataDir?: string }): Promise<Sql> {
  const databaseUrl = options?.databaseUrl || process.env.DATABASE_URL;
  if (databaseUrl) return openPostgres(databaseUrl);
  if (options?.dataDir) return openPglite(resolve(options.dataDir));
  return openPglite();
}

async function openPglite(dataDir?: string): Promise<Sql> {
  const db = dataDir ? new PGlite(dataDir) : new PGlite();
  await db.waitReady;
  return bind({
    exec: (statement) => db.exec(statement),
    query: async (statement, params) => {
      const result = params ? await db.query(statement, params) : await db.query(statement);
      return { rows: result.rows as Record<string, unknown>[] };
    },
    transaction: (fn) => db.transaction((tx) => fn(pgliteTx(tx))),
    close: () => db.close(),
  });
}

function pgliteTx(tx: {
  exec(statement: string): Promise<unknown>;
  query(statement: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
}): Executor {
  return {
    exec: (statement) => tx.exec(statement),
    query: async (statement, params) => {
      const result = params ? await tx.query(statement, params) : await tx.query(statement);
      return { rows: result.rows as Record<string, unknown>[] };
    },
  };
}

function openPostgres(databaseUrl: string): Sql {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  return bind({
    exec: (statement) => pool.query(statement),
    query: async (statement, params) => {
      const result = params ? await pool.query(statement, params as never[]) : await pool.query(statement);
      return { rows: result.rows as Record<string, unknown>[] };
    },
    transaction: async (fn) => {
      const client = await pool.connect();
      const tx = postgresTx(client);
      try {
        await client.query('BEGIN');
        const result = await fn(tx);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  });
}

function postgresTx(client: pg.PoolClient): Executor {
  return {
    exec: (statement) => client.query(statement),
    query: async (statement, params) => {
      const result = params ? await client.query(statement, params as never[]) : await client.query(statement);
      return { rows: result.rows as Record<string, unknown>[] };
    },
  };
}

function bind(db: Executor): Sql {
  const sql: Sql = {
    exec: async (statement) => {
      await db.exec(statement);
    },
    query: async (statement, params) => {
      const result = await db.query(statement, params);
      return result.rows as never;
    },
    transaction: (fn) => {
      if (!db.transaction) return fn(sql);
      return db.transaction((tx) => fn(bind(tx)));
    },
    close: async () => {
      if (db.close) await db.close();
    },
  };
  return sql;
}
