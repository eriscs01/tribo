// openRuntime and buildApp, as main.ts and the CLI use them: the deployment's secrets and
// environment become a tribo_app pool, one app key and the services behind the HTTP app.
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestDatabase, postgresInfo, type TestDatabase } from '@tribo/testkit';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { openRuntime } from './runtime.js';

let tdb: TestDatabase;
let secrets: string;
let env: NodeJS.ProcessEnv;
const appKey = randomBytes(32);

beforeEach(async () => {
  tdb = await createTestDatabase();
  const pg = postgresInfo();
  secrets = await mkdtemp(join(tmpdir(), 'tribo-secrets-'));
  await writeFile(join(secrets, 'app_key'), appKey);
  await writeFile(join(secrets, 'db_app_password'), `${pg.appPassword}\n`);
  await writeFile(join(secrets, 'db_owner_password'), `${pg.ownerPassword}\n`);
  env = {
    TRIBO_PUBLIC_URL: 'https://trips.example.org',
    TRIBO_DB_HOST: pg.host,
    TRIBO_DB_PORT: String(pg.port),
    TRIBO_DB_NAME: tdb.name,
    TRIBO_SECRETS_DIR: secrets,
    TRIBO_LOG_LEVEL: 'fatal',
    TRIBO_RELEASE_VERSION: 'v0.9.0',
    TRIBO_RELEASE_COMMIT: 'feedc0de',
  };
});
afterEach(async () => {
  await tdb.destroy();
  await rm(secrets, { recursive: true, force: true });
});

describe('openRuntime', () => {
  it('connects as tribo_app under the process name, with the app key from the secrets', async () => {
    const runtime = await openRuntime(loadConfig(env), 'tribo-test');
    try {
      const { rows } = await runtime.pool.query<{ role: string; app: string }>(
        "SELECT current_user AS role, current_setting('application_name') AS app",
      );
      expect(rows).toEqual([{ role: 'tribo_app', app: 'tribo-test' }]);
      expect(runtime.appKey.fingerprint).toMatch(/^[0-9a-f]{8}$/);
      expect(runtime.issuer).toBe('Tribo (trips.example.org)');
      expect(runtime.release).toEqual({ version: 'v0.9.0', commit: 'feedc0de' });
    } finally {
      await runtime.close();
    }
  });

  it('closes every connection it opened, whether or not a service ever queried', async () => {
    const runtime = await openRuntime(loadConfig(env), 'tribo-close');
    await runtime.pool.query('SELECT 1');
    await runtime.close();
    const { rows } = await tdb.pool.query<{ n: string }>(
      "SELECT count(*) AS n FROM pg_stat_activity WHERE application_name = 'tribo-close'",
    );
    expect(rows).toEqual([{ n: '0' }]);
  });

  it('fails on a wrong database password instead of starting', async () => {
    await writeFile(join(secrets, 'db_app_password'), 'not-the-password');
    const runtime = await openRuntime(loadConfig(env), 'tribo-test');
    try {
      await expect(runtime.pool.query('SELECT 1')).rejects.toMatchObject({ code: '28P01' });
    } finally {
      await runtime.close();
    }
  });
});

describe('buildApp', () => {
  it('reports health from the runtime pool: 200 while it reaches the database, 503 once closed', async () => {
    const config = loadConfig(env);
    const runtime = await openRuntime(config, 'tribo-test');
    const app = await buildApp(runtime, config);
    try {
      expect((await app.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(200);
      await runtime.close();
      expect((await app.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(503);
    } finally {
      await app.close();
    }
  });
});
