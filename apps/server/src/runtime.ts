import {
  createIdentityService,
  createItemsService,
  createLibraryService,
  createTripsService,
  verifyChains,
  writePath,
} from '@tribo/core';
import { keyring, loadAppKey } from '@tribo/crypto';
import type { DB } from '@tribo/db';
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import type { Config } from './config.js';

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
  const write = writePath(db);
  const keys = keyring(appKey);
  /** How authenticator apps name this deployment. */
  const issuer = `Tribo (${config.publicUrl.host})`;
  return {
    appKey,
    pool,
    issuer,
    identity: createIdentityService(db, keys, issuer),
    trips: createTripsService(db, write),
    items: createItemsService(db, write, keys),
    library: createLibraryService(db, write, keys),
    verifyAudit: (chainKey?: string) => verifyChains(db, chainKey),
    /** Ends the pool. */
    close: () => db.destroy(),
  };
}
