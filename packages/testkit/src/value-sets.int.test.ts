import { VALUE_SETS } from '@tribo/db';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from './database.js';

// PostgreSQL stores `col IN ('a', 'b')` as `CHECK ((col = ANY (ARRAY['a'::text, 'b'::text])))`.
const IN_LIST = /^CHECK \(\((\w+) = ANY \(\(?ARRAY\[(.+)\]\)?(?:::text\[\])?\)\)\)$/;
const LITERAL = /'((?:[^']|'')*)'::text/g;

describe('closed value sets', () => {
  let tdb: TestDatabase;
  beforeAll(async () => {
    tdb = await createTestDatabase();
  });
  afterAll(() => tdb.destroy());

  it('VALUE_SETS equals every column IN-list CHECK in the migrated schema', async () => {
    const { rows } = await sql<{ rel: string; def: string }>`
      SELECT n.nspname || '.' || t.relname AS rel, pg_get_constraintdef(c.oid) AS def
        FROM pg_constraint c
        JOIN pg_class t ON t.oid = c.conrelid
        JOIN pg_namespace n ON n.oid = t.relnamespace
       WHERE c.contype = 'c' AND n.nspname IN ('tribo', 'audit')
    `.execute(tdb.db);
    const fromDb: Record<string, string[]> = {};
    for (const { rel, def } of rows) {
      const m = IN_LIST.exec(def);
      if (m) {
        const [, column, list] = m as unknown as [string, string, string];
        fromDb[`${rel}.${column}`] = [...list.matchAll(LITERAL)].map(([, value = '']) =>
          value.replaceAll("''", "'"),
        );
      }
    }
    expect(Object.keys(fromDb).length).toBeGreaterThan(0);
    expect(fromDb).toEqual(VALUE_SETS);
  });
});
