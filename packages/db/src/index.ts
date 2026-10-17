export {
  loadMigrations,
  migrate,
  MigrationError,
  MIGRATION_LOCK_KEY,
  MIGRATIONS_DIR,
  pendingMigrations,
  type AppliedMigration,
  type Migration,
} from './migrate.js';
export type * from './generated/db.js';
export {
  forModule,
  TABLE_OWNER,
  type ModuleDb,
  type ModuleTables,
  type TableOwner,
  type TablesOf,
} from './ownership.js';
