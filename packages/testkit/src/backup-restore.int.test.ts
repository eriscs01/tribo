// Backups and restore (s0 task 17): a pg_dump -Fc of a migrated database with real trip
// activity, restored by deploy/backup/restore-db.sh into a database the real bootstrap has
// just created, keeps every audit chain intact and needs no migration. The dump uses the
// flags of deploy/backup/serve.sh.
import { fileURLToPath } from 'node:url';
import {
  createItemsService,
  createTripsService,
  verifyChains,
  writePath,
  type ChainReport,
} from '@tribo/core';
import { loadMigrations, migrate, type DB } from '@tribo/db';
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import type { ExecResult, StartedTestContainer } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createUser } from './factories.js';
import { startPostgres, type PostgresInfo } from './postgres.js';

const RESTORE_SCRIPT = fileURLToPath(
  new URL('../../../deploy/backup/restore-db.sh', import.meta.url),
);
const DUMP = '/tmp/tribo.dump';

let container: StartedTestContainer;
let info: PostgresInfo;
let before: ChainReport[];
let restore: ExecResult;

function connect(): Kysely<DB> {
  const pool = new pg.Pool({
    host: info.host,
    port: info.port,
    database: 'tribo',
    user: 'tribo_app',
    password: info.appPassword,
  });
  return new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });
}

function run(...command: string[]): Promise<ExecResult> {
  return container.exec(command, { env: { POSTGRES_USER: 'postgres' } });
}

async function mustRun(...command: string[]): Promise<void> {
  const result = await run(...command);
  if (result.exitCode !== 0) throw new Error(`${command.join(' ')}: ${result.stderr}`);
}

/** A trip with an item, through the services: events in the platform and trip chains. */
async function tripActivity(db: Kysely<DB>): Promise<void> {
  const write = writePath(db);
  const owner = await createUser(db);
  const ctx = { requestId: 'backup-test', surface: 'web' as const, userId: owner.userId };
  const trip = await createTripsService(db, write).create(
    ctx,
    { mfaVerified: true },
    {
      name: 'Island weekend',
      startDate: '2026-11-11',
      endDate: '2026-11-14',
      currency: 'PHP',
      timezone: 'Asia/Manila',
    },
  );
  await createItemsService(db, write).create(ctx, trip.id, {
    type: 'transport',
    title: 'Morning ferry',
    start: { local: '2026-11-11T07:40', tz: 'Asia/Manila' },
  });
}

beforeAll(async () => {
  // A container of its own: the tribo database is dropped and bootstrapped again, as on the
  // fresh instance of a restore.
  ({ container, info } = await startPostgres());
  await container.copyFilesToContainer([{ source: RESTORE_SCRIPT, target: '/tmp/restore-db.sh' }]);

  const source = connect();
  try {
    await tripActivity(source);
    before = await verifyChains(source);
  } finally {
    await source.destroy();
  }

  await mustRun(
    ...['pg_dump', '--username', 'postgres', '--dbname', 'tribo', '--format', 'custom'],
    ...['--file', DUMP],
  );
  await mustRun(
    'psql',
    '-U',
    'postgres',
    '-d',
    'postgres',
    '-c',
    'DROP DATABASE tribo WITH (FORCE)',
  );
  await mustRun('bash', '/docker-entrypoint-initdb.d/10-tribo-init.sh');
  restore = await run('bash', '/tmp/restore-db.sh', DUMP);
});
afterAll(() => container.stop());

describe('nightly dump and restore', () => {
  it('restores into a freshly bootstrapped database with every chain intact', async () => {
    expect(restore.exitCode, restore.stderr).toBe(0);
    expect(before.map((c) => c.chainKey)).toContainEqual(expect.stringMatching(/^trip:/));
    expect(before.every((c) => c.brokenAt === null)).toBe(true);
    const restored = connect();
    try {
      expect(await verifyChains(restored)).toEqual(before);
    } finally {
      await restored.destroy();
    }
  });

  it('keeps tribo_owner as owner, the app role grants and the applied migrations', async () => {
    const owner = new pg.Client({
      host: info.host,
      port: info.port,
      database: 'tribo',
      user: 'tribo_owner',
      password: info.ownerPassword,
    });
    await owner.connect();
    try {
      const owners = await owner.query<{ owner: string }>(
        `SELECT DISTINCT tableowner AS owner FROM pg_tables WHERE schemaname IN ('tribo', 'audit')`,
      );
      expect(owners.rows).toEqual([{ owner: 'tribo_owner' }]);
      const grants = await owner.query<{ insert: boolean; update: boolean }>(`
        SELECT has_table_privilege('tribo_app', 'audit.audit_events', 'INSERT') AS insert,
               has_table_privilege('tribo_app', 'audit.audit_events', 'UPDATE') AS update`);
      expect(grants.rows).toEqual([{ insert: true, update: false }]);
      // The app's start-up migration finds every file already applied.
      expect(await migrate(owner, await loadMigrations())).toEqual([]);
    } finally {
      await owner.end();
    }
  });

  it('refuses to restore into a database that already has tables', async () => {
    const again = await run('bash', '/tmp/restore-db.sh', DUMP);
    expect(again.exitCode).toBe(1);
    expect(again.stderr).toContain('restore only into a fresh one');
  });
});
