// createTestDatabase().destroy(): the database is dropped only once every connection the
// test opened has closed, and a connection the server terminated mid-test is reported, not lost.
import { setTimeout } from 'node:timers/promises';
import type pg from 'pg';
import { describe, expect, it } from 'vitest';
import { createTestDatabase } from './database.js';

/** Counts the pool's connections as they open and as they finish closing. */
function trackClients(pool: pg.Pool) {
  const count = { opened: 0, closed: 0 };
  pool.on('connect', () => {
    count.opened += 1;
  });
  pool.on('remove', () => {
    count.closed += 1;
  });
  return count;
}

describe('test database teardown', () => {
  it('has closed every connection when destroy() resolves, so the drop never races a closing backend', async () => {
    const tdb = await createTestDatabase();
    const count = trackClients(tdb.pool);
    await Promise.all([1, 2, 3, 4].map(() => tdb.pool.query('SELECT pg_sleep(0.05)')));
    expect(count.opened).toBeGreaterThan(1);

    await tdb.destroy();

    expect(count.closed).toBe(count.opened);
  });

  it('rejects when the server terminated a connection mid-test, instead of an unhandled pool error', async () => {
    const tdb = await createTestDatabase();
    // Two idle connections; the next query runs on one and terminates the other.
    const first = await tdb.pool.connect();
    const second = await tdb.pool.connect();
    first.release();
    second.release();
    await tdb.pool.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
       WHERE datname = current_database() AND pid <> pg_backend_pid()`,
    );
    // Let the FATAL reach the idle client.
    await setTimeout(200);

    await expect(tdb.destroy()).rejects.toMatchObject({ code: '57P01' });
  });
});
