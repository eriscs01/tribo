// Tribo app process: config → app key → migrations (as tribo_owner) → HTTP (as tribo_app).
import { loadMigrations, migrate } from '@tribo/db';
import pg from 'pg';
import { loadConfig } from './config.js';
import { authHandlers } from './handlers/auth.js';
import { openRuntime } from './runtime.js';
import { buildServer } from './server.js';
import { csrfSecret } from './session.js';

const config = loadConfig(process.env);
const { appKey, pool, identity, close } = await openRuntime(config, 'tribo');
const csrf = csrfSecret(appKey);

const app = await buildServer({
  trustedProxies: config.trustedProxies,
  csrfSecret: csrf,
  authenticate: (token) => identity.authenticate(token),
  handlers: authHandlers(identity, csrf),
  logLevel: config.logLevel,
  ping: async () => {
    await pool.query('SELECT 1');
  },
});
app.log.info(
  {
    keyVersion: appKey.version,
    keyFingerprint: appKey.fingerprint,
    publicUrl: config.publicUrl.origin,
  },
  'starting',
);
// A dropped idle connection (database restart) must not kill the process: the pool opens
// a new one on the next query, and /healthz reports 503 until the database is back.
pool.on('error', (error) => {
  app.log.warn({ code: (error as { code?: string }).code }, 'idle database connection lost');
});

const owner = new pg.Client({
  host: config.db.host,
  port: config.db.port,
  database: config.db.database,
  user: 'tribo_owner',
  password: config.db.ownerPassword,
  application_name: 'tribo-migrate',
});
await owner.connect();
try {
  const applied = await migrate(owner, await loadMigrations());
  app.log.info({ applied }, applied.length > 0 ? 'migrations applied' : 'schema up to date');
} finally {
  await owner.end();
}

await app.listen(config.listen);

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    app.log.info({ signal }, 'shutting down');
    void app
      .close()
      .then(close)
      .then(() => process.exit(0));
  });
}
