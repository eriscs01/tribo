import { randomBytes } from 'node:crypto';
import { BOOTSTRAP_SCRIPT, BOOTSTRAP_SQL, loadMigrations, migrate } from '@tribo/db';
import pg from 'pg';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';

export const POSTGRES_IMAGE = 'postgres:18';
/** The migrated database every test database is cloned from. */
export const TEMPLATE_DB = 'tribo';

/** Where the shared container listens and the three roles' passwords (test-only, random). */
export interface PostgresInfo {
  host: string;
  port: number;
  superPassword: string;
  ownerPassword: string;
  appPassword: string;
}

export interface StartedPostgres {
  info: PostgresInfo;
  container: StartedTestContainer;
}

/**
 * Starts PostgreSQL 18 the way production does: the real init script runs 0000 as
 * superuser and sets both role passwords from /run/secrets, then the real runner applies
 * the migrations as tribo_owner. The migrated `tribo` database becomes the template.
 */
export async function startPostgres(): Promise<StartedPostgres> {
  const secret = () => randomBytes(18).toString('hex');
  const passwords = { superPassword: secret(), ownerPassword: secret(), appPassword: secret() };

  const container = await new GenericContainer(POSTGRES_IMAGE)
    .withEnvironment({ POSTGRES_PASSWORD: passwords.superPassword })
    .withCopyFilesToContainer([
      {
        source: BOOTSTRAP_SCRIPT,
        target: '/docker-entrypoint-initdb.d/10-tribo-init.sh',
        mode: 0o755,
      },
      {
        source: BOOTSTRAP_SQL,
        target: '/docker-entrypoint-initdb.d/tribo/0000_bootstrap.sql',
        mode: 0o644,
      },
    ])
    .withCopyContentToContainer([
      { content: passwords.ownerPassword, target: '/run/secrets/db_owner_password', mode: 0o644 },
      { content: passwords.appPassword, target: '/run/secrets/db_app_password', mode: 0o644 },
    ])
    .withCommand(['postgres', '-c', 'fsync=off', '-c', 'synchronous_commit=off'])
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .withStartupTimeout(120_000)
    .start();

  const info: PostgresInfo = {
    host: container.getHost(),
    port: container.getMappedPort(5432),
    ...passwords,
  };

  const owner = new pg.Client({
    host: info.host,
    port: info.port,
    database: TEMPLATE_DB,
    user: 'tribo_owner',
    password: info.ownerPassword,
  });
  await owner.connect();
  try {
    await migrate(owner, await loadMigrations());
  } finally {
    await owner.end();
  }
  return { info, container };
}
