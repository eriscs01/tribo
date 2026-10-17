import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ClientBase } from 'pg';

export const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations/', import.meta.url));

/** The superuser bootstrap, for container init (see README): roles, passwords, database. */
export const BOOTSTRAP_SCRIPT = fileURLToPath(
  new URL('../bootstrap/10-tribo-init.sh', import.meta.url),
);
export const BOOTSTRAP_SQL = join(MIGRATIONS_DIR, '0000_bootstrap.sql');

/**
 * Session-level advisory lock every app instance takes before migrating, so of two
 * instances started together one migrates and the other waits, then finds nothing to do.
 */
export const MIGRATION_LOCK_KEY = 7_407_265_301;

/** Numbered files the runner applies. 0000_bootstrap.sql runs once as superuser, not here. */
const MIGRATION_FILE = /^(\d{4})_[a-z0-9_]+\.sql$/;
const BOOTSTRAP_NUMBER = '0000';

export interface Migration {
  name: string;
  sha256: string;
  sql: string;
}

export interface AppliedMigration {
  name: string;
  sha256: string;
}

export class MigrationError extends Error {
  override name = 'MigrationError';
}

export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export async function loadMigrations(dir: string = MIGRATIONS_DIR): Promise<Migration[]> {
  const names = (await readdir(dir))
    .filter((name) => MIGRATION_FILE.test(name) && !name.startsWith(BOOTSTRAP_NUMBER))
    .sort();
  const seen = new Set<string>();
  for (const name of names) {
    const number = name.slice(0, 4);
    if (seen.has(number)) throw new MigrationError(`two migrations share number ${number}`);
    seen.add(number);
  }
  return Promise.all(
    names.map(async (name) => {
      const sql = await readFile(join(dir, name), 'utf8');
      return { name, sha256: sha256(sql), sql };
    }),
  );
}

/**
 * Returns the migrations still to apply, in order. Refuses when an applied migration is
 * missing or was edited after it ran (add a new numbered file instead), and when a new
 * file sorts before one already applied.
 */
export function pendingMigrations(
  applied: readonly AppliedMigration[],
  migrations: readonly Migration[],
): Migration[] {
  const onDisk = new Map(migrations.map((m) => [m.name, m]));
  for (const row of applied) {
    const file = onDisk.get(row.name);
    if (!file) throw new MigrationError(`applied migration ${row.name} is missing from disk`);
    if (file.sha256 !== row.sha256) {
      throw new MigrationError(`applied migration ${row.name} was changed after it ran`);
    }
  }
  const done = new Set(applied.map((row) => row.name));
  const last = applied
    .map((row) => row.name)
    .sort()
    .at(-1);
  const pending = migrations.filter((m) => !done.has(m.name));
  const early = last === undefined ? undefined : pending.find((m) => m.name < last);
  if (early) throw new MigrationError(`${early.name} sorts before applied migration ${last ?? ''}`);
  return pending;
}

/**
 * Applies pending migrations as the connected role (tribo_owner). Each file and its
 * schema_migrations row commit in one transaction, so a crash never leaves a
 * half-recorded migration. Returns the names applied.
 */
export async function migrate(
  client: ClientBase,
  migrations: readonly Migration[],
): Promise<string[]> {
  await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS public.schema_migrations (
        name       text PRIMARY KEY,
        sha256     text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`);
    const { rows } = await client.query<AppliedMigration>(
      'SELECT name, sha256 FROM public.schema_migrations ORDER BY name',
    );
    const pending = pendingMigrations(rows, migrations);
    for (const migration of pending) {
      await client.query('BEGIN');
      try {
        await client.query(migration.sql);
        await client.query('INSERT INTO public.schema_migrations (name, sha256) VALUES ($1, $2)', [
          migration.name,
          migration.sha256,
        ]);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw new MigrationError(`${migration.name} failed`, { cause: error });
      }
    }
    return pending.map((m) => m.name);
  } finally {
    // A dropped connection releases the lock anyway; don't mask the original error.
    await client
      .query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY])
      .catch(() => undefined);
  }
}
