// Applies pending migrations as tribo_owner: `DATABASE_URL=… pnpm --filter @tribo/db migrate`.
// The app runs the same function at start-up.
import pg from 'pg';
import { loadMigrations, migrate } from '../migrate.js';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set (connect as tribo_owner)');
  process.exit(1);
}

const client = new pg.Client({ connectionString: url, application_name: 'tribo-migrate' });
await client.connect();
try {
  const applied = await migrate(client, await loadMigrations());
  console.log(applied.length > 0 ? `applied ${applied.join(', ')}` : 'up to date');
} finally {
  await client.end();
}
