import { randomBytes } from 'node:crypto';
import type { DB } from '@tribo/db';
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { inject } from 'vitest';
import { TEMPLATE_DB, type PostgresInfo } from './postgres.js';

export interface TestDatabase {
  name: string;
  /** Connected as tribo_app, the role requests run as. */
  db: Kysely<DB>;
  /** A raw pool as tribo_app, for SQL the typed builder does not cover. */
  pool: pg.Pool;
  /** Drops the database; call in afterEach / afterAll. */
  destroy: () => Promise<void>;
}

/** Where the run's PostgreSQL listens and its roles' passwords, for tests that connect as an app process. */
export function postgresInfo(): PostgresInfo {
  return inject('triboPostgres');
}

async function asSuperuser<T>(run: (client: pg.Client) => Promise<T>): Promise<T> {
  const i = postgresInfo();
  const client = new pg.Client({
    host: i.host,
    port: i.port,
    database: 'postgres',
    user: 'postgres',
    password: i.superPassword,
  });
  await client.connect();
  try {
    return await run(client);
  } finally {
    await client.end();
  }
}

/**
 * A fresh, migrated database for one test (or one file), cloned from the template in
 * well under a second. Database-level grants are not copied by CREATE DATABASE, so the
 * revokes and tribo_app's CONNECT from the bootstrap are applied again here.
 */
export async function createTestDatabase(): Promise<TestDatabase> {
  const name = `t_${randomBytes(6).toString('hex')}`;
  await asSuperuser(async (client) => {
    await client.query(`CREATE DATABASE ${name} TEMPLATE ${TEMPLATE_DB} OWNER tribo_owner`);
    await client.query(`REVOKE ALL ON DATABASE ${name} FROM PUBLIC`);
    await client.query(`GRANT CONNECT ON DATABASE ${name} TO tribo_app`);
  });
  const i = postgresInfo();
  const pool = new pg.Pool({
    host: i.host,
    port: i.port,
    database: name,
    user: 'tribo_app',
    password: i.appPassword,
    max: 4,
  });
  // pg-pool re-emits an idle connection's error on the pool; with no listener it would
  // surface as an unhandled error in whichever test file runs next. Keep it, report it in destroy().
  const poolErrors: Error[] = [];
  pool.on('error', (error) => poolErrors.push(error));
  // pool.end() resolves once its clients are told to end, not once their sockets have closed.
  const open = new Set<pg.Client>();
  const drained: { resolve?: () => void } = {};
  pool.on('connect', (client) => open.add(client));
  pool.on('remove', (client) => {
    open.delete(client);
    if (open.size === 0) drained.resolve?.();
  });
  const db = new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });
  return {
    name,
    db,
    pool,
    destroy: async () => {
      // Kysely ends only a pool it has queried through; a test may have used `pool` alone.
      await db.destroy();
      if (!pool.ending) await pool.end();
      // Dropping while a backend is still closing makes the server terminate it (57P01), and
      // the client reports that as an error after its pool is gone.
      if (open.size > 0)
        await new Promise<void>((resolve) => {
          drained.resolve = resolve;
        });
      await asSuperuser((client) => client.query(`DROP DATABASE IF EXISTS ${name}`));
      const [first] = poolErrors;
      if (first) throw first;
    },
  };
}

/** Connects to a test database as another role (tribo_owner or the superuser) for checks. */
export function connectAs(database: string, role: 'tribo_owner' | 'postgres'): pg.Client {
  const i = postgresInfo();
  return new pg.Client({
    host: i.host,
    port: i.port,
    database,
    user: role,
    password: role === 'postgres' ? i.superPassword : i.ownerPassword,
  });
}
