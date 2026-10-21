import {
  accountHasMfa,
  createIdentityService,
  createItemsService,
  createLibraryService,
  createMembersService,
  createTripsService,
  createUnitsService,
  requestEvents,
  verifyChains,
  writePath,
} from '@tribo/core';
import { keyring, loadAppKey, type AppKey } from '@tribo/crypto';
import type { DB } from '@tribo/db';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import type { Config } from './config.js';

/**
 * The services over one database handle and one app key: the one composition the HTTP
 * server, the CLI and the adapter tests share.
 */
export function composeServices(db: Kysely<DB>, appKey: AppKey, publicUrl: URL) {
  const write = writePath(db);
  const keys = keyring(appKey);
  /** How authenticator apps name this deployment. */
  const issuer = `Tribo (${publicUrl.host})`;
  return {
    appKey,
    issuer,
    identity: createIdentityService(db, keys, issuer),
    trips: createTripsService(db, write),
    members: createMembersService(db, write, keys, accountHasMfa),
    items: createItemsService(db, write, keys),
    units: createUnitsService(db, write),
    library: createLibraryService(db, write, keys),
    verifyAudit: (chainKey?: string) => verifyChains(db, chainKey),
    requestAudit: (requestId: string) => requestEvents(db, requestId),
    /** Resolves once the database answers a query. */
    ping: async () => {
      await sql`SELECT 1`.execute(db);
    },
  };
}

export type Services = ReturnType<typeof composeServices>;

/** What the HTTP server and the CLI share: the app key, a tribo_app pool and the services. */
export async function openRuntime(config: Config, applicationName: string) {
  const appKey = await loadAppKey(config.appKeyFile);
  const pool = new pg.Pool({
    host: config.db.host,
    port: config.db.port,
    database: config.db.database,
    user: 'tribo_app',
    password: config.db.appPassword,
    application_name: applicationName,
    max: 10,
  });
  const db = new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });
  return {
    ...composeServices(db, appKey, config.publicUrl),
    release: config.release,
    pool,
    /** Ends the pool. Kysely ends only a pool it has queried through, so this ends it too. */
    close: async () => {
      await db.destroy();
      if (!pool.ending) await pool.end();
    },
  };
}
